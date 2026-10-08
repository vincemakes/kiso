/**
 * ADR-0061 — a reader of edit_file input takes both vocabularies.
 *
 * The model now sends `edits` of `{oldText, newText}`; a log written before
 * the rename holds `search`/`replace`. Every display of an edit — the
 * approval diff, the card's line counts, the settled summary — must draw
 * the same thing for the same change in either vocabulary, and must draw
 * nothing for a shape the tool refuses (a mixed hunk, a top-level
 * `oldText` pair). Before the rename these readers took only the top-level
 * pair, so a batch drew "+0 -0".
 */

import { describe, expect, it } from "vitest";
import { editFileHunksDiff, hunksOf } from "../src/diff.js";
import { renderToolSummary } from "../src/render.js";

const OLD = { path: "f.js", edits: [{ search: "a\nb", replace: "a\nb\nc" }, { search: "x", replace: "y" }] };
const NEW = { path: "f.js", edits: [{ oldText: "a\nb", newText: "a\nb\nc" }, { oldText: "x", newText: "y" }] };
const FILE = "a\nb\nx\n";

describe("hunksOf — both vocabularies, nothing the tool refuses", () => {
	it("reads oldText/newText hunks and legacy search/replace hunks alike", () => {
		expect(hunksOf(NEW)).toEqual(hunksOf(OLD));
		expect(hunksOf(NEW)).toEqual([{ search: "a\nb", replace: "a\nb\nc" }, { search: "x", replace: "y" }]);
	});

	it("reads the legacy top-level pair", () => {
		expect(hunksOf({ path: "f.js", search: "x", replace: "y" })).toEqual([{ search: "x", replace: "y" }]);
	});

	it("refuses a top-level oldText pair (the tool takes it only inside edits)", () => {
		expect(hunksOf({ path: "f.js", oldText: "x", newText: "y" })).toBeNull();
	});

	it("refuses a hunk that mixes the two, and a half hunk", () => {
		expect(hunksOf({ path: "f.js", edits: [{ oldText: "x", replace: "y" }] })).toBeNull();
		expect(hunksOf({ path: "f.js", edits: [{ oldText: "x" }] })).toBeNull();
		expect(hunksOf({ path: "f.js", edits: [] })).toBeNull();
	});
});

describe("the displays draw the same change the same way", () => {
	it("the approval diff", () => {
		expect(editFileHunksDiff(FILE, hunksOf(NEW)!, "f.js")).toEqual(editFileHunksDiff(FILE, hunksOf(OLD)!, "f.js"));
	});

	it("the settled summary counts every hunk", () => {
		const done = { content: "edited f.js", isError: false };
		const a = renderToolSummary("edit_file", NEW, done);
		expect(a).toBe(renderToolSummary("edit_file", OLD, done));
		expect(a).toMatch(/\+4 -3/);
	});
});
