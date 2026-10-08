/**
 * A refusal that names the divergence.
 *
 * `pattern not found in src/report.js (hunk 2)` is true and useless: the
 * caller's only recourse is to read the whole file. Ten refused edits in
 * one measured session were ALL of this kind — none stale, none
 * overlapping — and in every one a long prefix matched before the search
 * ran into text the caller had not written yet (93 of 223 characters, 94
 * of 286, 306 of 913). Four searched for an import line with the new
 * symbol already in it. One shape: the search describes the file as it
 * WILL be.
 *
 * So the detail must distinguish the shapes, and the headline and the
 * refusal class must not change: a missing pattern is still a
 * precondition, and a STALE revision must still be reported as staleness
 * — the truer cause comes first, and a better message for the wrong cause
 * would be a worse tool.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editFileTool } from "../src/index.js";
import { describeSearchMiss } from "../src/search-miss.js";
import type { ToolResult } from "@vincemakes/kiso-core";

// The result is a union and `errorKind` lives only on the error side; the
// suite's existing idiom narrows it. vitest does not typecheck, so this
// read clean under a green run and only `tsc` had anything to say.
const kindOf = (r: ToolResult): string | undefined => (r.isError ? r.errorKind : undefined);

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const FILE = ["export function clamp(n, min, max) {", "\tif (n < min) return min;", "\tif (n >= max) return max - 1;", "\treturn n;", "}", ""].join("\n");

function ws(text: string): { root: string; edit: ReturnType<typeof editFileTool> } {
	const root = mkdtempSync(join(tmpdir(), "kiso-search-miss-"));
	writeFileSync(join(root, "f.js"), text);
	return { root, edit: editFileTool({ workspaceRoot: root }) };
}

describe("describeSearchMiss — the three shapes a miss takes", () => {
	it("running PAST THE END is its own sentence, because that is the common case", () => {
		const out = describeSearchMiss(FILE, `${FILE}\nexport function isBetween(n) {}\n`);
		expect(out).toContain("the file ENDS there");
		expect(out).toContain("more characters");
		// and never the empty-string rendering that buries it
		expect(out).not.toContain('the file then has:  ""');
	});

	it("diverging MID-FILE shows both sides at the point they part", () => {
		// the caller searched for the FIXED line; the file still has the bug
		const out = describeSearchMiss(FILE, "\tif (n >= max) return max;\n");
		expect(out).toContain("the file then has:");
		expect(out).toContain("your oldText wanted:");
		// Both sides are shown FROM THE DIVERGENCE ON, so the matched prefix
		// is not repeated: the file continues " - 1;" where the search
		// continues ";". Asserting the whole line "max - 1" was my error —
		// "max" is inside the part that MATCHED.
		expect(out).toContain('" - 1;');
		expect(out).toContain('wanted: ";');
	});

	it("matching NOTHING says so, and quotes where the search begins", () => {
		const out = describeSearchMiss(FILE, "zzz absent zzz\nmore");
		expect(out).toContain("no part of it appears");
		expect(out).toContain("zzz absent zzz");
		expect(out).not.toContain("characters matched");
	});

	it("counts the prefix, and names the lines it spans", () => {
		const out = describeSearchMiss(FILE, "\tif (n < min) return min;\n\tif (n >= max) return max;\n");
		expect(out).toMatch(/\d+ of \d+ characters matched, from line 2 to line 3/);
	});

	it("an empty search has nothing to describe", () => {
		expect(describeSearchMiss(FILE, "")).toBe("");
	});

	it("is BOUNDED — a divergence into a huge block does not dump it into the message", () => {
		const huge = "x".repeat(5000);
		const out = describeSearchMiss(FILE, `export function clamp${huge}`);
		expect(out.length).toBeLessThan(400);
		expect(out).toContain("…");
	});

	it("resolves the prefix at its FIRST occurrence — deterministic, and no longer a match to the tool's own rule (ACI-2)", () => {
		const twice = "AAA\nBBB\nAAA\nCCC\n";
		const out = describeSearchMiss(twice, "AAA\nZZZ");
		// the first AAA is on line 1; the second is on line 3
		expect(out).toContain("from line 1");
	});
});

describe("edit_file carries it, and changes nothing else", () => {
	it("a refused search keeps the headline AND gains the detail", async () => {
		const { edit } = ws(FILE);
		const r = await edit.execute(
			{ path: "f.js", expectedRevision: rev(FILE), search: "\tif (n >= max) return max;\n", replace: "x" },
			undefined as never,
		);
		expect(r.isError).toBe(true);
		expect(kindOf(r)).toBe("precondition"); // the refusal CLASS is unchanged
		expect(r.content.split("\n")[0]).toBe("edit_file: pattern not found in f.js");
		expect(r.content).toContain("characters matched");
	});

	it("the batch form still names the hunk, and describes THAT hunk", async () => {
		const { edit } = ws(FILE);
		const r = await edit.execute(
			{
				path: "f.js",
				expectedRevision: rev(FILE),
				edits: [
					{ search: "return n;", replace: "return n;" },
					{ search: `${FILE}\nexport function extra() {}`, replace: "x" },
				],
			},
			undefined as never,
		);
		// ACI-3: hunks apply in order, so the headline says what the hunk met
		expect(r.content.split("\n")[0]).toContain("(hunk 2, after hunk 1 applied)");
		expect(r.content).toContain("the file ENDS there");
	});

	it("A STALE REVISION IS STILL REPORTED AS STALENESS — the truer cause first", async () => {
		const { edit } = ws(FILE);
		const r = await edit.execute(
			{ path: "f.js", expectedRevision: rev("something else entirely"), search: "nowhere", replace: "x" },
			undefined as never,
		);
		expect(r.isError).toBe(true);
		// the staleness stays the headline — the truer cause first. ACI-3
		// adds, BELOW it, where the search stands in the file as it is now:
		// declared, so the retry needs no read.
		expect(r.content.split("\n")[0]).toContain("changed since");
		expect(r.content.split("\n")[0]).not.toContain("characters matched");
		expect(r.content).toContain("the search: not found");
	});

	it("a SUCCESSFUL edit carries no miss detail", async () => {
		const { edit } = ws(FILE);
		const r = await edit.execute(
			{ path: "f.js", expectedRevision: rev(FILE), search: "max - 1", replace: "max" },
			undefined as never,
		);
		expect(r.isError).toBe(false);
		expect(r.content).not.toContain("characters matched");
	});
});
