/**
 * MD-1 — the streaming-markdown round, stated against the report's own
 * samples (`kiso-doc/md-render-comparison-2026-09-11.md`).
 *
 * The round answers two owner complaints and four further defects the
 * same harness found. Every case below was RED on the shipped renderer,
 * at the widths the report used, before the item that makes it green.
 *
 * BLOCK-FREEZE is untouched by every item: `renderBlock` stays a pure
 * function of `(block, W)`, and nothing re-renders a committed block.
 * The gates that hold that are slice ①'s (T-MD-1/2/3) and they are not
 * restated here — what IS restated, per item, is that the new machinery
 * is reached through the same pure path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import { MdStream, renderBlock, renderMarkdown, splitCells, tableShape } from "../src/md.js";
import { palette } from "../src/render.js";
import { INDENTED, QUOTED, SETEXT, TABLE5, TABLE6 } from "./helpers/md1-samples.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The renderer's own width for a terminal of `term` columns:
 *  `MarkdownBlock` hands the block `W - 2` and insets every non-empty row
 *  by two (R13 E3). Every width the report quotes is a TERMINAL width. */
function W(term: number): number {
	return term - 2;
}

/** Is this render a GRID or the record form? The record form's shape is
 *  its `label: value` run, which no aligned row has. */
function isRecord(rows: readonly string[]): boolean {
	return rows.some((r) => /\S: /.test(plain(r)));
}

/** Every character of `s` that is content, counted. The survival gates
 *  compare BAGS rather than substrings, because a cell that wraps inside
 *  its column is no longer contiguous in any single row. Whitespace and
 *  MD-1.3's header rule are chrome and do not count. */
function bag(s: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const ch of plain(s).replace(/[\s\u2500]/g, "")) out.set(ch, (out.get(ch) ?? 0) + 1);
	return out;
}

/** The cells of a table fixture, header included. */
function cellsOf(src: string): string[] {
	const t = tableShape(src.split("\n"));
	if (t === null) throw new Error("fixture is not a table");
	return [...t.header, ...t.rows.flat()];
}

describe("MD-1.1 — a table SHRINKS before it falls to the record form", () => {
	/**
	 * COMPLAINT 1, reproduced and answered. The 6-column sample's natural
	 * width is 86 columns; at terminal 80 it missed the grid by 8 and the
	 * whole table collapsed into 11 rows of the record form. The two
	 * columns carrying long CJK phrases wrap inside their cells for free.
	 *
	 * The expectation is the report's own §MD-1.1 rendering, rebuilt from
	 * kiso's `mdWrap`/`visibleWidth` and the report's published column
	 * widths (4/17/17/14/6/6) — an oracle independent of this patch.
	 */
	it("MD1-1a: the 6-column CJK table is a GRID at terminal 80, not a grey wall", () => {
		const rows = renderMarkdown(TABLE6, W(80)).map(plain);
		expect(rows).toEqual([
			"  \u987a\u5e8f  \u5185\u5bb9\u8d44\u4ea7           \u7528\u9014               \u9002\u7528\u793e\u533a        \u8d1f\u8d23\u4eba  \u72b6\u6001",
			`  ${"\u2500".repeat(74)}`, // MD-1.3's rule, at the grid's own width
			"  15    \u521b\u59cb\u4eba\u6545\u4e8b\u957f\u6587     \u5efa\u7acb\u4fe1\u4efb\u4e0e\u54c1\u724c\u8ba4   \u5c0f\u7ea2\u4e66\u3001\u77e5\u4e4e    \u5f20\u4f1f    \u5df2\u5b8c\u6210",
			"        \uff08\u5b8c\u6574\u7248\uff09         \u77e5",
			"  16    \u4ea7\u54c1\u529f\u80fd\u5bf9\u6bd4\u8868     \u63a8\u52a8\u8f6c\u5316\u51b3\u7b56       \u77e5\u4e4e\u3001\u5fae\u4fe1\u793e\u7fa4  \u674e\u5a1c    \u8fdb\u884c\u4e2d",
			"  17    30\u79d2\u7ad6\u5c4f\u77ed\u89c6\u9891     \u62c9\u65b0\u4e0e\u66dd\u5149         \u6296\u97f3\u3001\u89c6\u9891\u53f7    \u738b\u5f3a    \u5f85\u6392\u671f",
		]);
		// 11 rows of dim became 5 rows of grid (6 with MD-1.3's rule) — the
		// degradation is also half the height, which is what makes it cheaper
		// for the short-terminal residue of FINDING TUI2-MD-1.
		expect(rows).toHaveLength(6);
		expect(isRecord(rows)).toBe(false);
	});

	it("MD1-1b: the wide widths are unchanged — the natural grid still wins", () => {
		// at 100 and 120 the table already fitted naturally and must not
		// move: shrinking is reached only when the natural widths do not fit.
		for (const term of [100, 120]) {
			const rows = renderMarkdown(TABLE6, W(term)).map(plain);
			expect(`${term}: ${rows.length}`).toBe(`${term}: 5`); // 4 rows + MD-1.3's rule
			expect(isRecord(rows)).toBe(false);
		}
		// and the 5-column sample, which fitted at 80 already
		expect(isRecord(renderMarkdown(TABLE5, W(80)).map(plain))).toBe(false);
	});

	/**
	 * The degradation is now GRADUAL rather than a cliff. The floor is
	 * eight columns per column (four CJK characters) — a judgement, not a
	 * measurement: it is where the report's sample stopped reading as a
	 * table. Below it the record form is still the answer, so the record
	 * form is not retired, only postponed.
	 */
	it("MD1-1c: the ladder — grid down to the floor, records below it", () => {
		const got = [88, 80, 72, 64, 56, 48].map((term) => {
			const rows = renderMarkdown(TABLE6, W(term)).map(plain);
			return `${term}: ${isRecord(rows) ? "record" : `grid/${rows.length}`}`;
		});
		// the row counts carry MD-1.3's header rule: 4/5/7/8/9 of content + 1
		expect(got).toEqual(["88: grid/5", "80: grid/6", "72: grid/8", "64: grid/9", "56: grid/10", "48: record"]);
	});

	it("MD1-1d: no row exceeds W, at every width from 12 to 120", () => {
		const offenders: string[] = [];
		for (const [name, src] of [["TABLE5", TABLE5], ["TABLE6", TABLE6]] as const) {
			for (let w = 12; w <= 120; w += 1) {
				for (const row of renderMarkdown(src, w)) if (visibleWidth(row) > w) offenders.push(`${name} W=${w} w=${visibleWidth(row)}`);
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("MD1-1e: every cell SURVIVES at every width — the bag is never short", () => {
		// a cell that wraps inside its column is not contiguous in any one
		// row, so the subject is stated as a bag: every character of every
		// cell is still on the screen, at every width, and no ellipsis is
		// ever drawn.
		const offenders: string[] = [];
		for (const [name, src] of [["TABLE5", TABLE5], ["TABLE6", TABLE6]] as const) {
			const want = bag(cellsOf(src).join(""));
			for (let w = 12; w <= 120; w += 1) {
				const rows = renderMarkdown(src, w);
				const got = bag(rows.join(""));
				for (const [ch, n] of want) if ((got.get(ch) ?? 0) < n) offenders.push(`${name} W=${w} ${ch}: ${got.get(ch) ?? 0} < ${n}`);
				if (rows.join("").includes("\u2026")) offenders.push(`${name} W=${w}: ellipsis`);
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("MD1-1f: in GRID form nothing is invented either — the bag is EXACT", () => {
		// containment alone would be satisfied by a renderer that repeated
		// content. In grid form the drawn characters are exactly the cells'.
		for (const [name, src] of [["TABLE5", TABLE5], ["TABLE6", TABLE6]] as const) {
			for (const term of [56, 64, 72, 80, 100, 120]) {
				const rows = renderMarkdown(src, W(term)).map(plain);
				if (isRecord(rows)) continue;
				const got = [...bag(rows.join(""))].sort();
				const want = [...bag(cellsOf(src).join(""))].sort();
				expect(got, `${name}@${term}`).toEqual(want);
			}
		}
	});

	it("MD1-1g: the shrink is a pure function of (block, W) — same bytes, twice", () => {
		// the freeze guarantee restated on the new path: nothing in the
		// shrink reads a clock, a cache or a previous render.
		for (const term of [48, 56, 64, 72, 80, 100]) {
			expect(renderMarkdown(TABLE6, W(term))).toEqual(renderMarkdown(TABLE6, W(term)));
		}
		// and the tokenizer the shrink measures through is untouched
		expect(splitCells("| a | `x | y` | b |")).toEqual(["a", "`x | y`", "b"]);
	});
});

/** Split a styled row into runs, each tagged with whether `dim` is open
 *  over it. The record form's whole subject is WHICH tier a run is in, so
 *  the gate reads the tier rather than grepping for an escape. */
function dimRuns(row: string): { text: string; dim: boolean }[] {
	const p = palette();
	const out: { text: string; dim: boolean }[] = [];
	let dim = false;
	let i = 0;
	let cur = "";
	const flush = (): void => {
		if (cur !== "") out.push({ text: cur, dim });
		cur = "";
	};
	while (i < row.length) {
		const m = /^\x1b\[[0-9;]*m/.exec(row.slice(i));
		if (m !== null) {
			const next = m[0] === p.dim ? true : m[0] === p.reset ? false : dim;
			if (next !== dim) {
				flush();
				dim = next;
			}
			i += m[0].length;
			continue;
		}
		cur += row[i];
		i += 1;
	}
	flush();
	return out;
}

describe("MD-1.2 — in the record form only the LABELS are dim", () => {
	/**
	 * COMPLAINT 2, reproduced and answered. `recordRows` wrapped every
	 * label AND every value after the first column in ONE `p.dim` span, so
	 * the table's actual content arrived at the lowest contrast tier on the
	 * screen while the labels — scaffolding the reader already read in the
	 * header — were given equal weight. The emphasis was exactly inverted.
	 *
	 * Per-token contrast was never the defect: `dim` measures 4.54:1 on a
	 * resolved light ground, which is a legal token for a LABEL. Setting a
	 * whole paragraph of body text in it is a different thing, and on a
	 * terminal that never answered OSC 11 it is worse still — the palette
	 * keeps SGR 2 there rather than an absolute grey.
	 */
	it("MD1-2a: every VALUE is at body strength, every LABEL is dim", () => {
		const t = tableShape(TABLE6.split("\n"))!;
		const rows = renderMarkdown(TABLE6, W(48));
		expect(isRecord(rows.map(plain))).toBe(true);
		const dimText = rows.flatMap((r) => dimRuns(r).filter((x) => x.dim).map((x) => x.text)).join("");
		const litText = rows.flatMap((r) => dimRuns(r).filter((x) => !x.dim).map((x) => x.text)).join("");
		const offenders: string[] = [];
		// every value, at body strength and NOWHERE in a dim run. The runs are
		// concatenated with no delimiter and compared with whitespace removed,
		// because a long value wraps and a wrapped value's two halves are two
		// runs on two rows.
		const flat = (s: string): string => s.replace(/\s/g, "");
		for (const value of t.rows.flat()) {
			if (!flat(litText).includes(flat(value))) offenders.push(`value not at body strength: ${value}`);
			if (flat(dimText).includes(flat(value))) offenders.push(`value dimmed: ${value}`);
		}
		// every label except the record's own name, dim
		for (const label of t.header.slice(1)) {
			if (!flat(dimText).includes(flat(label))) offenders.push(`label not dim: ${label}`);
		}
		expect(offenders).toEqual([]);
	});

	it("MD1-2b: the record's NAME keeps its bold, and its colon keeps its dim", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE6, W(48));
		// the first column names the record: bold, with a dim colon. That
		// half of the shape is unchanged — it was never the complaint.
		expect(rows[0]!.startsWith(`${p.bold}`)).toBe(true);
		expect(rows[0]).toContain(`${p.reset}${p.dim}:${p.reset} `);
	});

	it("MD1-2c: the separator stays dim — it is punctuation, not content", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE6, W(48));
		const seps = rows.flatMap((r) => dimRuns(r).filter((x) => x.text.includes("\u00b7")));
		expect(seps.length).toBeGreaterThan(0);
		expect(seps.every((x) => x.dim)).toBe(true);
	});

	it("MD1-2d: no row exceeds W in the record form either, 12..120", () => {
		const offenders: string[] = [];
		for (let w = 12; w <= 120; w += 1) {
			const rows = renderMarkdown(TABLE6, w);
			if (!isRecord(rows.map(plain))) continue;
			for (const row of rows) if (visibleWidth(row) > w) offenders.push(`W=${w} w=${visibleWidth(row)}`);
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});
});

describe("MD1-F1 — a zero-width SGR token rides the token it precedes", () => {
	/**
	 * FOUND while making MD-1.2 green, and fixed because it is the
	 * tokenizer breaking its own stated contract: "SGR sequences are
	 * zero-width and ride the token they precede". A `cur` holding nothing
	 * but SGR was flushed as a token of its own whenever the next character
	 * was break-eligible, and a zero-width token still reaches the fitting
	 * test — `w + pendW + 0 > room` — so a row could be broken AT a style
	 * boundary. The pending space was dropped into the break and the row
	 * ended in whitespace, with an empty style span after it.
	 *
	 * NOT a visible change: the PLAIN text of every fixture in this suite
	 * plus the acceptance content, at every width from 10 to 120, hashes
	 * identically before and after. What it buys is copy fidelity — a
	 * copied row no longer carries trailing whitespace it never needed.
	 */
	it("MD1-F1a: no record-form row ends in whitespace, 12..120", () => {
		const offenders: string[] = [];
		for (let w = 12; w <= 120; w += 1) {
			const rows = renderMarkdown(TABLE6, w);
			if (!isRecord(rows.map(plain))) continue;
			for (const row of rows) if (/\s$/.test(plain(row)) && plain(row).trim() !== "") offenders.push(`W=${w}: ${JSON.stringify(plain(row).slice(-12))}`);
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});
});

describe("MD-1.3 — ONE rule under the table header", () => {
	/**
	 * R2 AMENDMENT 1 (owner ruling, 2026-09-11). R2 removed the table's
	 * RAILS — the four-sided box that BOUNDS a table, "the last box left on
	 * a screen that has decided not to have boxes". A line under the header
	 * row bounds nothing; it SEPARATES the header from the body, which is
	 * the one job the round's own governing distinction gives a rule:
	 * "a rule separates, a gutter scopes, a rail bounds". The owner ruled
	 * that a single rule under a table header is a separator, not a rail.
	 * Rails stay out.
	 *
	 * It also buys something concrete. Before it, a six-row table's header
	 * was carried by SGR bold ALONE: in a pipe, under NO_COLOR, or on a
	 * terminal with weak bold, seven visually identical rows arrived with
	 * nothing saying which one names the columns.
	 */
	it("MD1-3a: the rule sits directly under the header, at the GRID's width", () => {
		const rows = renderMarkdown(TABLE6, W(80));
		const header = plain(rows[0]!);
		const rule = plain(rows[1]!);
		// inset by the table's own two columns, like every row of the grid
		expect(rule.startsWith("  ")).toBe(true);
		expect(rule.slice(2)).toMatch(/^\u2500+$/);
		// the columns and their gutters: 4+17+17+14+6+6 plus five 2-space
		// gutters = 74. The header row is trailing-trimmed and so is shorter;
		// the rule states the grid's extent, which is what a separator does.
		expect(visibleWidth(rule)).toBe(76);
		expect(visibleWidth(header)).toBeLessThanOrEqual(visibleWidth(rule));
	});

	it("MD1-3b: it is DIM, and it is the one rule glyph the product has", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE6, W(80));
		expect(rows[1]).toBe(`  ${p.dim}${"\u2500".repeat(74)}${p.reset}`);
	});

	it("MD1-3c: exactly ONE rule per table, and only in grid form", () => {
		const offenders: string[] = [];
		for (let w = 12; w <= 120; w += 1) {
			const rows = renderMarkdown(TABLE6, w).map(plain);
			const at = rows.map((r, i) => [r, i] as const).filter(([r]) => /^ {2}\u2500+$/.test(r)).map(([, i]) => i);
			if (isRecord(rows)) {
				// the record form has no header row, so it has nothing to separate
				if (at.length !== 0) offenders.push(`W=${w}: ${at.length} rules in the record form`);
				continue;
			}
			if (at.length !== 1) offenders.push(`W=${w}: ${at.length} rules`);
			else if (at[0] !== 1) offenders.push(`W=${w}: the rule is at row ${at[0]}, not under the header`);
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("MD1-3d: the rule never makes a row exceed W", () => {
		const offenders: string[] = [];
		for (const src of [TABLE5, TABLE6]) {
			for (let w = 12; w <= 120; w += 1) for (const row of renderMarkdown(src, w)) if (visibleWidth(row) > w) offenders.push(`W=${w} w=${visibleWidth(row)}`);
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});
});

describe("MD-1.4 — setext headings and indented code blocks", () => {
	/**
	 * Neither of these was merely unstyled: both produced CORRUPTED output,
	 * and kiso's own standard for the table path is that a guess printed
	 * into scrollback is indistinguishable from a fact. A paragraph that has
	 * eaten its own `===` underline, and a code block reflowed into prose,
	 * are the same failure.
	 *
	 *   Setext heading          ->  Setext heading ==============
	 *   ==============
	 *
	 *   Another setext          ->  Another setext
	 *   --------------              (and a full-width rule under it)
	 *
	 *       const x = 1;        ->  const x = 1;     const y = 2;
	 *       const y = 2;
	 *
	 * BLOCK-FREEZE holds by construction: the underline is a COMPLETE line
	 * when it is read, and the paragraph it promotes has not closed yet, so
	 * no committed row changes. MD1-4g states that as a gate.
	 */
	it("MD1-4a: a setext H1 is an H1 — underlined, with no `=` left in the text", () => {
		const p = palette();
		const rows = renderMarkdown("Setext heading\n==============", W(80));
		expect(rows).toEqual([`${p.bold}${p.underline}Setext heading${p.reset}`]);
		expect(plain(rows.join(""))).not.toContain("=");
	});

	it("MD1-4b: a setext H2 is an H2 — bold, and NOT a paragraph under a rule", () => {
		const p = palette();
		const rows = renderMarkdown("Another setext\n--------------", W(80));
		expect(rows).toEqual([`${p.bold}Another setext${p.reset}`]);
		expect(plain(rows.join(""))).not.toContain("─");
	});

	it("MD1-4c: both samples together, at the report's three widths", () => {
		for (const term of [80, 100, 120]) {
			const rows = renderMarkdown(SETEXT, W(term)).map(plain);
			expect(rows, `terminal ${term}`).toEqual(["Setext heading", "", "Another setext"]);
		}
	});

	it("MD1-4d: a `---` with NO open paragraph is still a rule", () => {
		// the underline can only be an underline where a paragraph is open,
		// which is exactly the condition `#line` has at that point. Everywhere
		// else `---` keeps its own meaning.
		const rows = renderMarkdown("a paragraph\n\n---\n\nanother", W(80)).map(plain);
		expect(rows.some((r) => /^ *─+$/.test(r))).toBe(true); // MD-1.6 decides the inset
		expect(rows).toContain("a paragraph");
		expect(rows).toContain("another");
	});

	it("MD1-4e: an indented code block keeps its LINES and its indentation", () => {
		const rows = renderMarkdown(INDENTED, W(80)).map(plain);
		expect(rows).toEqual(["some prose first", "", "    const x = 1;", "    const y = 2;"]);
	});

	it("MD1-4f: relative indentation inside the block survives too", () => {
		const src = ["    function f() {", "      if (x) {", "        return 1;", "      }", "    }"].join("\n");
		expect(renderMarkdown(src, W(80)).map(plain)).toEqual([
			"    function f() {",
			"      if (x) {",
			"        return 1;",
			"      }",
			"    }",
		]);
	});

	it("MD1-4g: a 4-space-indented LIST is still a list, and a paragraph is not interrupted", () => {
		// a deliberate deviation from CommonMark, and the reason is frequency:
		// a nested list written with four spaces is far more common in model
		// prose than an indented code block that starts with a list marker.
		expect(renderMarkdown("- one\n    - two", W(80)).map(plain)).toEqual(["  - one", "      - two"]);
		// and an indented line after a paragraph is that paragraph's own
		// continuation — indented code cannot interrupt a paragraph.
		//
		// FINDING MD1-F2 (pre-existing, NOT fixed in this round): a
		// paragraph's soft line breaks join with a space and the continuation
		// line's OWN leading spaces ride along, so the reflowed text carries
		// five spaces where it should carry one. The subject of this assertion
		// is that the line JOINS; the spacing is pinned as it is so the defect
		// is visible here and flips loudly when it is fixed.
		expect(renderMarkdown("a paragraph\n    continued here", W(80)).map(plain)).toEqual(["a paragraph     continued here"]);
	});

	it("MD1-4h: an indented code line is LINE-LOCAL — it closes the instant its newline lands", () => {
		const s = new MdStream();
		s.push("intro\n\n");
		const before = s.closed();
		s.push("    const x = 1;\n");
		expect(s.closed()).toBe(before + 1);
		expect(s.blocks()[before]!.kind).toBe("code-line");
		s.push("    const y = 2;\n");
		expect(s.closed()).toBe(before + 2);
		// the live region holds the open block, never the message: a long
		// indented block streams through it exactly as a fence body does.
		expect(s.blocks().every((b) => b.lines.length === 1 || b.kind !== "code-line")).toBe(true);
	});

	it("MD1-4i: BLOCK-FREEZE — every delta split yields the same closed blocks and renders", () => {
		const offenders: string[] = [];
		for (const src of [SETEXT, INDENTED, `${SETEXT}\n\n${INDENTED}`]) {
			const one = new MdStream();
			one.push(src);
			one.end();
			const want = one.blocks().map((b) => `${b.kind}|${b.gap}|${JSON.stringify(b.lines)}`);
			for (const n of [1, 2, 3, 5, 7, 13, 64]) {
				const s = new MdStream();
				for (let i = 0; i < src.length; i += n) s.push(src.slice(i, i + n));
				s.end();
				if (JSON.stringify(s.blocks().map((b) => `${b.kind}|${b.gap}|${JSON.stringify(b.lines)}`)) !== JSON.stringify(want)) offenders.push(`chunk=${n}`);
			}
			// and no CLOSED block's render ever changes as more text arrives
			for (const n of [1, 7]) {
				const s = new MdStream();
				const atClose = new Map<number, string>();
				for (let i = 0; i < src.length; i += n) {
					s.push(src.slice(i, i + n));
					const blocks = s.blocks();
					for (let b = 0; b < s.closed(); b += 1) if (!atClose.has(b)) atClose.set(b, JSON.stringify(renderBlock(blocks[b]!, 60)));
				}
				s.end();
				const final = s.blocks();
				for (const [b, was] of atClose) if (JSON.stringify(renderBlock(final[b]!, 60)) !== was) offenders.push(`chunk=${n} block=${b} moved`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("MD-1.5 — a blockquote keeps its block structure", () => {
	/**
	 * `blockBody`'s quote case joined every line of the quote with spaces, so
	 * a quoted list and a quoted second paragraph became one reflowed line:
	 * `A quote with a list: - one - two  And a second paragraph.` The quote's
	 * content is BLOCKS, and it is rendered as blocks — through a nested
	 * `MdStream` constructed per render, which is a local, so `renderBlock`
	 * stays pure in (block, W).
	 *
	 * THE JUDGEMENT CALL, and the choice made: the blanket `dim` over the
	 * whole quote is DROPPED, and the `│ ` gutter carries "this text is not
	 * mine" on its own. Two reasons, both from this round. With inner blocks
	 * the blanket dim would put dim OVER bold in a quoted heading, which is
	 * a contradiction — bold says more, dim says less — and dim over a
	 * fence body's inset in a quoted fence. And it is the same argument
	 * MD-1.2 makes one item earlier: `dim` is a LABEL tier, and a quote is
	 * body text. The gutter stays dim, because the gutter IS a label.
	 */
	it("MD1-5a: a quoted list and a quoted second paragraph keep their shape", () => {
		expect(renderMarkdown(QUOTED, W(80)).map(plain)).toEqual([
			"│ A quote with a list:",
			"│",
			"│   - one",
			"│   - two",
			"│",
			"│ And a second paragraph.",
		]);
	});

	it("MD1-5b: the quote's CONTENT is at body strength; only the gutter is dim", () => {
		const rows = renderMarkdown(QUOTED, W(80));
		const dimText = rows.flatMap((r) => dimRuns(r).filter((x) => x.dim).map((x) => x.text)).join("");
		const litText = rows.flatMap((r) => dimRuns(r).filter((x) => !x.dim).map((x) => x.text)).join("");
		expect(dimText.replace(/\s/g, "")).toBe("│".repeat(6)); // the gutter, six rows of it
		expect(litText).toContain("A quote with a list:");
		expect(litText).toContain("And a second paragraph.");
	});

	it("MD1-5c: a quoted heading and a quoted fence render as what they are", () => {
		const p = palette();
		const rows = renderMarkdown("> ## Heading\n>\n> ```ts\n> const a = 1;\n> ```", W(80));
		expect(rows.map(plain)).toEqual(["│ Heading", "│", "│ ```ts", "│   const a = 1;", "│ ```"]);
		// the heading's bold survives inside the quote, which the blanket dim
		// would have been fighting
		expect(rows[0]).toContain(p.bold);
	});

	it("MD1-5d: nesting works, and a deep nest neither throws nor overruns", () => {
		expect(renderMarkdown("> > nested", W(80)).map(plain)).toEqual(["│ │ nested"]);
		const offenders: string[] = [];
		for (const depth of [1, 2, 3, 4, 5, 6, 8]) {
			const src = `${"> ".repeat(depth)}deep`;
			for (let w = 12; w <= 80; w += 4) {
				const rows = renderMarkdown(src, w);
				for (const row of rows) if (visibleWidth(row) > w) offenders.push(`depth=${depth} W=${w} w=${visibleWidth(row)}`);
				// the text SURVIVES, wrapped if it must be: at W=12 a deep nest
				// spends two columns per level and the word breaks by code point,
				// so the needle is the bag and not a substring.
				for (const [ch, n] of bag("deep")) if ((bag(rows.join("")).get(ch) ?? 0) < n) offenders.push(`depth=${depth} W=${w}: lost ${ch}`);
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("MD1-5e: the quote is still a pure function of (block, W)", () => {
		// the nested stream is a LOCAL, built per render: two renders of the
		// same block at the same width are byte-identical, and a render never
		// reaches the outer stream's state.
		for (const w of [20, 40, 60, 78]) expect(renderMarkdown(QUOTED, w)).toEqual(renderMarkdown(QUOTED, w));
	});

	it("MD1-5f: no quote row exceeds W, 12..120", () => {
		const offenders: string[] = [];
		for (let w = 12; w <= 120; w += 1) for (const row of renderMarkdown(QUOTED, w)) if (visibleWidth(row) > w) offenders.push(`W=${w} w=${visibleWidth(row)}`);
		expect(offenders.slice(0, 5)).toEqual([]);
	});
});
