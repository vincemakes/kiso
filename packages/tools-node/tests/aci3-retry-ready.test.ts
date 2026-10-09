/**
 * ACI-3 — edit_file failed one call in five on the owner's disk (319 of
 * 1,687), and after every failure the model read the file again before
 * retrying: two extra requests per failure. The four shapes, and what
 * each refusal now carries so the retry needs no read:
 *
 *   - pattern not found (129): the search started right and diverged —
 *     stale memory, not formatting. The refusal now shows the file's
 *     current text around the best partial match, and the current [rev].
 *   - changed since (102): 41 cited a revision older than one they had
 *     been shown, 40 cited one no tool ever returned, 21 met a real outside
 *     change. The refusal now says, per hunk, whether it still matches the
 *     file as it is, shows the text where it does not, and ends on the
 *     current [rev].
 *   - two hunks overlap (57): hunks are now applied IN ORDER, each against
 *     the result of the ones before it — all or nothing.
 *   - expectedRevision inside a hunk (5, always with the top-level one
 *     too): tolerated and ignored.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editFileTool } from "../src/index.js";
import type { ToolResult } from "@vincemakes/kiso-core";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const kindOf = (r: ToolResult): string | undefined => (r.isError ? r.errorKind : undefined);
const lastLine = (s: string): string => s.trimEnd().split("\n").at(-1)!;

/** A 40-line file: a function in the middle is what the model edits. */
const LINES = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
LINES[19] = "export function total(items) {";
LINES[20] = "  return items.reduce((a, b) => a + b.price, 0);";
LINES[21] = "}";
const FILE = `${LINES.join("\n")}\n`;

function ws(content = FILE): { root: string; edit: ReturnType<typeof editFileTool>; read: () => string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-aci3-"));
	writeFileSync(join(root, "f.ts"), content);
	return { root, edit: editFileTool({ workspaceRoot: root }), read: () => readFileSync(join(root, "f.ts"), "utf8") };
}

describe("ACI-3 — a missing pattern's refusal carries what the retry needs", () => {
	it("the current text around the best partial match, and the current [rev] as the last line", async () => {
		const { edit, read } = ws();
		// stale memory: the model remembers `item.price`; the file says `b.price`
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(FILE), search: "  return items.reduce((a, item) => a + item.price, 0);", replace: "  return sum(items);" },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content.split("\n")[0]).toBe("edit_file: pattern not found in f.ts"); // the headline parsers read is unchanged
		expect(r.content).toContain("  return items.reduce((a, b) => a + b.price, 0);"); // the real line, verbatim
		expect(r.content).toContain("export function total(items) {"); // with its surroundings
		expect(r.content).not.toContain("const line1 = 1;"); // a region, not the file
		expect(lastLine(r.content)).toBe(`[${rev(FILE)}]`);
		expect(read()).toBe(FILE);
		// the retry uses ONLY what the refusal showed — no read
		const again = await edit.execute(
			{ path: "f.ts", expectedRevision: lastLine(r.content).slice(1, -1), search: "  return items.reduce((a, b) => a + b.price, 0);", replace: "  return sum(items);" },
			undefined as never,
		);
		expect(again.isError).toBe(false);
	});

	it("a search with no part in the file still ends on the current [rev]", async () => {
		const { edit } = ws();
		const r = await edit.execute({ path: "f.ts", expectedRevision: rev(FILE), search: "@@@ not in this file", replace: "x" }, undefined as never);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("no part of it appears");
		expect(lastLine(r.content)).toBe(`[${rev(FILE)}]`);
	});

	it("a prefix of a character or two says nothing about where the caller aimed — no region is shown", async () => {
		const { edit } = ws();
		const r = await edit.execute({ path: "f.ts", expectedRevision: rev(FILE), search: "c@@@@@@@@@@@@@@@@@@@", replace: "x" }, undefined as never);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("1 of 20 characters matched");
		expect(r.content).not.toContain("the file now has,");
		expect(lastLine(r.content)).toBe(`[${rev(FILE)}]`);
	});
});

describe("ACI-3 — a stale revision's refusal says where each hunk stands in the file as it is", () => {
	it("the current [rev], each hunk's standing, and the text where a hunk no longer matches", async () => {
		const { edit, read } = ws();
		const r = await edit.execute(
			{
				path: "f.ts",
				expectedRevision: rev("an older state"),
				edits: [
					{ search: "const line5 = 5;", replace: "const line5 = 50;" },
					{ search: "  return items.reduce((a, item) => a + item.price, 0);", replace: "  return sum(items);" },
				],
			},
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toMatch(/^edit_file: f\.ts changed since rev:/); // the headline parsers read is unchanged
		expect(r.content).toContain("hunk 1: matches once, line 5");
		expect(r.content).toContain("hunk 2: not found");
		expect(r.content).toContain("  return items.reduce((a, b) => a + b.price, 0);");
		expect(lastLine(r.content)).toBe(`[${rev(FILE)}]`);
		expect(read()).toBe(FILE);
	});
});

describe("ACI-3 — hunks apply IN ORDER, each against the result of the ones before it, all or nothing", () => {
	it("a second hunk written against the first one's result succeeds (0.40.2 refused it as an overlap)", async () => {
		const { edit, read } = ws();
		const r = await edit.execute(
			{
				path: "f.ts",
				expectedRevision: rev(FILE),
				edits: [
					{ search: "export function total(items) {", replace: "export function total(items, tax) {" },
					{ search: "export function total(items, tax) {\n  return items.reduce((a, b) => a + b.price, 0);", replace: "export function total(items, tax) {\n  return items.reduce((a, b) => a + b.price, 0) * (1 + tax);" },
				],
			},
			undefined as never,
		);
		expect(r.isError).toBe(false);
		expect(read()).toContain("export function total(items, tax) {\n  return items.reduce((a, b) => a + b.price, 0) * (1 + tax);\n}");
	});

	it("a later hunk that finds nothing refuses the WHOLE call — the file is byte-identical — and names what it saw", async () => {
		const { edit, read } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(FILE), edits: [{ search: "const line5 = 5;", replace: "const line5 = 50;" }, { search: "const line5 = 5;", replace: "const line5 = 500;" }] },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content.split("\n")[0]).toBe("edit_file: pattern not found in f.ts (hunk 2, after hunk 1 applied)");
		expect(read()).toBe(FILE);
	});
});

describe("ACI-3 — expectedRevision inside a hunk is tolerated", () => {
	// ADR-0061 reverses the SCHEMA half of this: the hunk items no longer
	// advertise it (one protocol knob fewer for the model); the executor
	// still ignores it on calls that skip validation (the case below).
	it("the hunk items no longer advertise it (ADR-0061)", () => {
		const { edit } = ws();
		const items = (edit.parameters as { properties: { edits: { items: { properties: Record<string, unknown>; additionalProperties: boolean } } } }).properties.edits.items;
		expect(Object.keys(items.properties).sort()).toEqual(["newText", "oldText"]);
		expect(items.additionalProperties).toBe(false);
	});

	it("an edit whose hunks carry it applies as if they did not", async () => {
		const { edit, read } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(FILE), edits: [{ search: "const line5 = 5;", replace: "const line5 = 50;", expectedRevision: "rev:whatever" } as never] },
			undefined as never,
		);
		expect(r.isError).toBe(false);
		expect(read()).toContain("const line5 = 50;");
	});
});

describe("ACI-3 — edit_file on a file that does not exist says how to create one", () => {
	it("names write_file with expectedRevision \"absent\"", async () => {
		const { edit } = ws();
		const r = await edit.execute({ path: "new.ts", expectedRevision: rev(FILE), search: "a", replace: "b" }, undefined as never);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("does not exist");
		expect(r.content).toContain('write_file with expectedRevision:"absent"');
	});
});
