/**
 * PR-1 — the SIX descriptions that must not move.
 *
 * The round changes shell's wording deliberately. Everything else in the tool
 * schema is a control variable: if `read_file`'s description drifts in the
 * same commit, the eval measures two changes and attributes both to one.
 *
 * Pinned byte-for-byte against v0.33.0 — the control build's own bytes, read
 * off the published tree rather than retyped. The seventh, `ask_user`, lives
 * in the ask extension rather than in tools-node, so a gate that only walked
 * this package would report six asserted while checking five.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileTool, listDirTool, searchTextTool, writeFileTool, editFileTool, shellTool } from "@vincemakes/kiso-tools-node";

const describeOf = (t: unknown): string => {
	const d = typeof t === "function" ? (t as (o: { workspaceRoot: string }) => { description: string })({ workspaceRoot: "/w" }) : (t as { description: string });
	return d.description;
};

/** v0.33.0's bytes, for the five that this round does not touch. */
const CONTROL = {
	read_file:
		"Read a workspace file or a range (offset/limit; default: the first 200 lines, with a continuation note). The final [rev:X] line identifies the version read.",
	list_dir:
		"List the entries of a directory. Omit path to list the workspace root. Capped at 200 entries with an overflow note (narrow to a subdirectory for more).",
	search_text:
		"Search files under a workspace directory (recursive), or a single file, for a regular expression (the workspace grep — prefer it over shell grep/rg). Returns matching file:line excerpts, capped at 50 — an overflow note states the count of further matches (narrow the pattern to see them). Case-insensitive unless caseSensitive is true.",
	write_file:
		'Create or replace a whole workspace file. expectedRevision is the file\'s latest revision token, or "absent" to create a new file.',
	edit_file:
		"Edit a workspace file at its latest revision (expectedRevision). ONE of: search+replace (first exact occurrence), or edits (1-32 disjoint hunks resolved against the same snapshot, applied atomically).",
} as const;

describe("PR-1 — the five unchanged tool descriptions", () => {
	for (const [name, text] of Object.entries(CONTROL)) {
		it(`${name} is byte-identical to v0.33.0`, () => {
			const live = { read_file: readFileTool, list_dir: listDirTool, search_text: searchTextTool, write_file: writeFileTool, edit_file: editFileTool }[name as keyof typeof CONTROL];
			expect(describeOf(live)).toBe(text);
		});
	}
});

describe("PR-1 — the sixth is ask_user, and it lives elsewhere", () => {
	it("the ask extension's source is byte-identical to v0.33.0", () => {
		// A stronger claim than "the description is unchanged", and one that
		// does not depend on HOW the description is declared — the first
		// version of this case matched a string literal and the extension
		// builds its description from an array, so the regex found nothing and
		// the case failed on a null rather than on a difference. The hash
		// cannot be fooled by a declaration shape.
		const src = readFileSync(new URL("../../../extensions/ask/src/kiso-ask.mjs", import.meta.url));
		expect(createHash("sha256").update(src).digest("hex")).toBe("091333aa6ecff1bfa42d5e78d762dd2bd1cd8ee311a370207473dccadd9eea09");
	});
});

describe("PR-1 — shell is the one that DID move", () => {
	it("carries this round's wording, so the gate above is not vacuous", () => {
		const d = describeOf(shellTool);
		expect(d).toContain("Run a shell command through /bin/sh with the workspace root");
		expect(d).not.toContain("A side effect — approval required");
	});
});
