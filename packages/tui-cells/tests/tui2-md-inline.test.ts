/**
 * TUI2-MD slice ② — the inline pass and the mono style table.
 *
 * Two independent reference implementations vendor the same markdown
 * parser and then patch the same three sharp edges: a STRICT `~~`
 * tokenizer, `|`-inside-backticks escaping before a table line is
 * split, and rejection of tables whose rows carry more columns than the
 * header. Convergent evolution is as close to a specification as this
 * problem has, so all three are required behaviours here — pinned as
 * fixtures below rather than inherited from a dependency we do not
 * have.
 *
 * The style table is the round's normative one (the owner's circled
 * group D). Its two adjudicated points: MD-1 — italic joins the SGR
 * alphabet as SGR 3, an ATTRIBUTE and not a colour, closing with 23 so
 * a span inside a bold heading cannot strand the heading's own style;
 * MD-2 — the fence gutter is the dim `│`, the same visual language the
 * tool-output block already speaks.
 *
 * The alphabet is CLOSED, and T-MD-16 is what keeps it closed: no
 * colour enters this round, and a renderer is exactly the place a
 * stray one would.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLOR_ON, palette } from "../src/render.js";
import { inlineSpans, renderMarkdown, splitCells, tableShape } from "../src/md.js";
import { MD_BENCHMARK } from "./helpers/md-benchmark.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** Every SGR sequence a string carries, in order. */
function sgr(s: string): string[] {
	return [...s.matchAll(/\x1b\[[0-9;]*m/g)].map((m) => m[0]);
}

/** The text a human sees — SGR stripped. */
function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TUI2-MD ② — the inline pass", () => {
	it("T-MD-9: the group-D mapping, construct by construct", () => {
		const p = palette();
		// **bold** -> bright bold, the markers gone
		expect(inlineSpans("say **loud** now", "")).toBe(`say ${p.bold}loud${p.reset} now`);
		// *italic* -> SGR 3, closing with 23 (the attribute's own close)
		expect(inlineSpans("say *soft* now", "")).toBe(`say ${p.italic}soft${p.italicEnd} now`);
		// `code` -> the existing tint, the backticks gone (the markdown pass
		// SUBSUMES colorInlineCode for assistant body text)
		expect(inlineSpans("run `npm test` now", "")).toBe(`run ${p.code}npm test${p.reset} now`);
		// [t](url) -> t bright, the url dim in parentheses; no OSC 8
		expect(inlineSpans("see [the docs](https://example.com) now", "")).toBe(
			`see ${p.bold}the docs${p.reset}${p.dim} (https://example.com)${p.reset} now`,
		);
		// ~~strike~~ -> the literal markers KEPT (honest degradation)
		expect(inlineSpans("was ~~wrong~~ before", "")).toBe("was ~~wrong~~ before");
	});

	it("T-MD-10: a span closes back to the BLOCK's own style, never to nothing", () => {
		const p = palette();
		// inside a bold heading, an italic span must close italic ONLY —
		// this is the whole reason SGR 3 has a dedicated close
		expect(inlineSpans("a *b* c", p.bold)).toBe(`a ${p.italic}b${p.italicEnd} c`);
		// a bold span inside a dim quote reopens the quote's dim after it
		expect(inlineSpans("a **b** c", p.dim)).toBe(`a ${p.bold}b${p.reset}${p.dim} c`);
	});

	it("T-MD-11: RAW UNTIL CLOSED — an opener with no closer stays literal", () => {
		for (const half of ["**bold", "*ital", "`code", "[text](url", "[text]"]) {
			expect(inlineSpans(`x ${half}`, "")).toBe(`x ${half}`);
		}
		// and the escape hatch: a backslash defuses a marker
		expect(plain(inlineSpans("2 \\* 3 \\* 4", ""))).toBe("2 * 3 * 4");
	});

	it("T-MD-12: the convergent patch (a) — STRICT ~~ never consumes anything", () => {
		// the strict tokenizer's point is not that ~~ styles differently; it
		// is that a loose one eats delimiters it has no business eating.
		expect(plain(inlineSpans("a ~~ b ~~ c", ""))).toBe("a ~~ b ~~ c");
		expect(plain(inlineSpans("~~ text~~", ""))).toBe("~~ text~~");
		// tildes never swallow a neighbouring construct
		const p = palette();
		expect(inlineSpans("~~**b**~~", "")).toBe(`~~${p.bold}b${p.reset}~~`);
		// and a code span keeps its tildes verbatim
		expect(plain(inlineSpans("`a ~~ b`", ""))).toBe("a ~~ b");
	});

	it("T-MD-13: the convergent patch (b) — a `|` inside backticks is not a cell wall", () => {
		expect(splitCells("| a | `x | y` | b |")).toEqual(["a", "`x | y`", "b"]);
		expect(splitCells("| plain | cells |")).toEqual(["plain", "cells"]);
		// an escaped pipe is content too
		expect(splitCells("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
	});

	it("T-MD-14: the convergent patch (c) — a table with overflow columns is REJECTED", () => {
		const good = ["| a | b |", "|---|---|", "| 1 | 2 |"];
		expect(tableShape(good)?.rows).toEqual([["1", "2"]]);
		// a body row wider than the header is not a table — it is prose that
		// happens to contain pipes, and guessing turns it into a lie
		const overflow = ["| a | b |", "|---|---|", "| 1 | 2 | 3 |"];
		expect(tableShape(overflow)).toBeNull();
		// no delimiter row -> not a table either
		expect(tableShape(["| a | b |", "| 1 | 2 |"])).toBeNull();
	});

	it("T-MD-15: the delimiter row carries the alignment", () => {
		const t = tableShape(["| a | b | c |", "|:--|:-:|--:|", "| 1 | 2 | 3 |"]);
		expect(t?.align).toEqual(["left", "center", "right"]);
		expect(tableShape(["| a |", "|---|", "| 1 |"])?.align).toEqual(["left"]);
	});

	it("T-MD-16: the SGR alphabet stays CLOSED — italic is the only new member", () => {
		// the whole acceptance content, every construct, at four widths:
		// nothing outside the palette may appear.
		const allowed = new Set([COLOR_ON.bold, COLOR_ON.dim, COLOR_ON.code, COLOR_ON.reset, COLOR_ON.italic, COLOR_ON.italicEnd]);
		const seen = new Set<string>();
		for (const W of [40, 60, 80, 120]) for (const row of renderMarkdown(MD_BENCHMARK, W)) for (const s of sgr(row)) seen.add(s);
		expect([...seen].filter((s) => !allowed.has(s))).toEqual([]);
		// and italic really is SGR 3 with its close 23 (MD-1, spelled)
		expect(COLOR_ON.italic).toBe("\x1b[3m");
		expect(COLOR_ON.italicEnd).toBe("\x1b[23m");
	});

	it("T-MD-17: the palette off emits ZERO escape bytes", () => {
		delete (process.stdout as { isTTY?: boolean }).isTTY;
		const rows = renderMarkdown(MD_BENCHMARK, 80);
		expect(rows.join("\n")).not.toContain("\x1b");
	});
});
