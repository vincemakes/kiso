/**
 * DC-23 — search_text answers a file, and a bad pattern is a result.
 *
 * Found by the 0.16.7 real-model dogfood: the model asked to search
 * INSIDE a file it had already read — the obvious thing, since the file
 * was known and the question was where in it something is decided — and
 * got libuv's own words back:
 *
 *   search_text failed: ENOTDIR: not a directory, scandir '<path>'
 *
 * It asked twice, so the error taught it nothing either time. Two costs:
 * the round-trips bought nothing, and a Node errno reached the human's
 * screen unedited. The product's rule is that a failure keeps its words
 * — the words should be the tool's, not the runtime's.
 *
 * Two neighbours found while fixing it: `new RegExp(pattern, "i")` sat
 * OUTSIDE every try in the function, so an invalid pattern threw raw out
 * of `execute` instead of returning a result the model could act on; and
 * the "i" was hardcoded, so a case-sensitive search was not expressible.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchTextTool } from "../src/index.js";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "kiso-dc23-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "const NEEDLE = 1;\nconst other = 2;\n", "utf8");
	writeFileSync(join(root, "src", "b.ts"), "// needle in the second file\n", "utf8");
	return root;
}
const ctx = {} as never;

describe("DC-23 — a file is a place text lives", () => {
	it("a FILE path searches that file — not an ENOTDIR", async () => {
		const root = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "NEEDLE", path: "src/a.ts" }, ctx);
		expect(out.isError).toBe(false);
		expect(out.content).toContain("a.ts:1:");
		expect(out.content).not.toContain("ENOTDIR");
	});

	it("...and only that file — the sibling's match is not in the answer", async () => {
		const root = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "needle", path: "src/a.ts" }, ctx);
		expect(out.content).not.toContain("b.ts");
	});

	it("a DIRECTORY still walks — the rule widens, it does not move", async () => {
		const root = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "needle", path: "src" }, ctx);
		expect(out.content).toContain("a.ts");
		expect(out.content).toContain("b.ts");
	});

	it("an invalid pattern is a RESULT with the tool's own words, never a throw", async () => {
		const root = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "(unclosed", path: "src" }, ctx);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("invalid pattern");
	});

	it("a missing path is a RESULT too, naming what was asked for", async () => {
		const root = workspace();
		const out = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "x", path: "src/nope.ts" }, ctx);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("src/nope.ts");
	});

	it("caseSensitive makes an exact-case search expressible", async () => {
		const root = workspace();
		const tool = searchTextTool({ workspaceRoot: root });
		const strict = await tool.execute({ pattern: "needle", path: "src/a.ts", caseSensitive: true }, ctx);
		expect(strict.content).toContain("(no matches)"); // the file has NEEDLE, not needle
		const loose = await tool.execute({ pattern: "needle", path: "src/a.ts" }, ctx);
		expect(loose.content).toContain("a.ts:1:"); // the default is unchanged
	});
});
