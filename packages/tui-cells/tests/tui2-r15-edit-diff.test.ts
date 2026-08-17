/**
 * TUI2-R1.5 slice ② — VD-2: the edit approval diff tells the truth.
 *
 * editFileDiff's locator required the search to align to FULL LINES
 * (`oldLines.slice(i, i+n).join("\n") === search`) while the tool it
 * previews is a plain `text.indexOf(search)`. Every mid-line search
 * therefore missed, fell into the "no occurrence → the whole file is the
 * old side" branch, and rendered the entire file as deleted — at the
 * APPROVAL MOMENT, the one surface where a human is deciding whether to
 * let a write happen. The walkthrough's frame s1-05 is that lie: a
 * one-line edit shown as −5 +1.
 *
 * The tool's own semantics are the contract (tools-node edit_file):
 *   i = text.indexOf(search); i === -1 → "pattern not found in <path>"
 *   result = text.slice(0, i) + replace + text.slice(i + search.length)
 *
 * Red on base: the mid-line case reports {added: 1, removed: 5}.
 */

import { describe, expect, it } from "vitest";
import { editFileDiff } from "../src/diff.js";

/** The walkthrough's own fixture — src/parser.ts, with "// OLD" INDENTED
 *  inside its line, which is what made the line-aligned locator miss. */
const PARSER = "export function parseExpr(t: Token) {\n  // OLD\n  return t;\n}\n";

describe("TUI2-R1.5 ② — editFileDiff locates the way the tool does (VD-2)", () => {
	it("the walkthrough's MID-LINE search is a one-line ± diff, not a deleted file", () => {
		const r = editFileDiff(PARSER, "// OLD", "if (t == null) throw new Error('null token');");
		expect({ added: r.added, removed: r.removed }).toEqual({ added: 1, removed: 1 });
		const minus = r.lines.filter((l) => l.kind === "-");
		const plus = r.lines.filter((l) => l.kind === "+");
		expect(minus.map((l) => l.text)).toEqual(["  // OLD"]);
		expect(plus.map((l) => l.text)).toEqual(["  if (t == null) throw new Error('null token');"]);
		// the surrounding lines are CONTEXT, and the function signature is
		// not reported as deleted
		expect(r.lines.some((l) => l.kind === "-" && l.text.includes("parseExpr"))).toBe(false);
	});

	it("a search that spans a line boundary mid-line still splices exactly", () => {
		const old = "alpha\nbeta gamma\ndelta\n";
		const r = editFileDiff(old, "gamma\ndel", "GG\nDEL");
		expect({ added: r.added, removed: r.removed }).toEqual({ added: 2, removed: 2 });
		expect(r.lines.filter((l) => l.kind === "-").map((l) => l.text)).toEqual(["beta gamma", "delta"]);
		expect(r.lines.filter((l) => l.kind === "+").map((l) => l.text)).toEqual(["beta GG", "DELta"]);
	});

	it("a FULL-LINE search keeps its old behaviour, byte for byte", () => {
		const old = ["a", "b", "OLD", "c", "d"].join("\n");
		const r = editFileDiff(old, "OLD", "NEW");
		expect(r.lines.map((l) => `${l.kind}${l.text}`)).toEqual([" a", " b", "-OLD", "+NEW", " c", " d"]);
		expect(r.added).toBe(1);
		expect(r.removed).toBe(1);
	});

	it("a search that is NOT THERE is an honest note — never a fabricated diff", () => {
		const r = editFileDiff("one\ntwo", "absent", "x", "src/thing.ts");
		expect(r.notFound).toBe(true);
		expect(r.added).toBe(0);
		expect(r.removed).toBe(0);
		expect(r.lines.map((l) => l.text)).toEqual(["pattern not found in src/thing.ts"]);
		expect(r.lines.every((l) => l.kind === " ")).toBe(true);
	});

	it("the not-found note names the file even when the caller passes none", () => {
		const r = editFileDiff("one\ntwo", "absent", "x");
		expect(r.notFound).toBe(true);
		expect(r.lines[0]!.text).toBe("pattern not found in the file");
	});

	it("the diff is WINDOWED — a 200-line file with a one-line edit shows the region, not the file", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const old = `${lines.join("\n")}\n`;
		const r = editFileDiff(old, "line 100", "LINE ONE HUNDRED");
		expect({ added: r.added, removed: r.removed }).toEqual({ added: 1, removed: 1 });
		// 2 context rows each side + the ± pair
		expect(r.lines).toHaveLength(6);
		expect(r.lines.map((l) => `${l.kind}${l.text}`)).toEqual([
			" line 98",
			" line 99",
			"-line 100",
			"+LINE ONE HUNDRED",
			" line 101",
			" line 102",
		]);
	});

	it("the FIRST occurrence is the one that is previewed — the tool replaces exactly one", () => {
		const old = "x\nDUP\ny\nDUP\nz\n";
		const r = editFileDiff(old, "DUP", "ONE");
		expect({ added: r.added, removed: r.removed }).toEqual({ added: 1, removed: 1 });
		expect(r.lines.filter((l) => l.kind === "+").map((l) => l.text)).toEqual(["ONE"]);
		// the SECOND DUP survives — it is context, never a change
		expect(r.lines.some((l) => l.kind === " " && l.text === "DUP")).toBe(true);
	});

	it("an INSERTION (replace contains the search) reports one changed line, not a rewrite", () => {
		const old = "a\nkeep me\nb\n";
		const r = editFileDiff(old, "keep me", "keep me\nand this");
		expect({ added: r.added, removed: r.removed }).toEqual({ added: 1, removed: 0 });
		expect(r.lines.filter((l) => l.kind === "+").map((l) => l.text)).toEqual(["and this"]);
	});
});
