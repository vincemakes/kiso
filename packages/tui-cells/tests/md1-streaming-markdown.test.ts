/**
 * MD-1 \u2014 the streaming-markdown round, stated against the report's own
 * samples (`kiso-doc/md-render-comparison-2026-09-11.md`).
 *
 * The round answers two owner complaints and four further defects the
 * same harness found. Every case below was RED on the shipped renderer,
 * at the widths the report used, before the item that makes it green.
 *
 * BLOCK-FREEZE is untouched by every item: `renderBlock` stays a pure
 * function of `(block, W)`, and nothing re-renders a committed block.
 * The gates that hold that are slice \u2460's (T-MD-1/2/3) and they are not
 * restated here \u2014 what IS restated, per item, is that the new machinery
 * is reached through the same pure path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import { renderMarkdown, splitCells, tableShape } from "../src/md.js";
import { TABLE5, TABLE6 } from "./helpers/md1-samples.js";

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

/** Every non-space character of `s`, counted. The survival gates compare
 *  BAGS rather than substrings, because a cell that wraps inside its
 *  column is no longer contiguous in any single row. */
function bag(s: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const ch of plain(s).replace(/\s/g, "")) out.set(ch, (out.get(ch) ?? 0) + 1);
	return out;
}

/** The cells of a table fixture, header included. */
function cellsOf(src: string): string[] {
	const t = tableShape(src.split("\n"));
	if (t === null) throw new Error("fixture is not a table");
	return [...t.header, ...t.rows.flat()];
}

describe("MD-1.1 \u2014 a table SHRINKS before it falls to the record form", () => {
	/**
	 * COMPLAINT 1, reproduced and answered. The 6-column sample's natural
	 * width is 86 columns; at terminal 80 it missed the grid by 8 and the
	 * whole table collapsed into 11 rows of the record form. The two
	 * columns carrying long CJK phrases wrap inside their cells for free.
	 *
	 * The expectation is the report's own \u00a7MD-1.1 rendering, rebuilt from
	 * kiso's `mdWrap`/`visibleWidth` and the report's published column
	 * widths (4/17/17/14/6/6) \u2014 an oracle independent of this patch.
	 */
	it("MD1-1a: the 6-column CJK table is a GRID at terminal 80, not a grey wall", () => {
		const rows = renderMarkdown(TABLE6, W(80)).map(plain);
		expect(rows).toEqual([
			"  \u987a\u5e8f  \u5185\u5bb9\u8d44\u4ea7           \u7528\u9014               \u9002\u7528\u793e\u533a        \u8d1f\u8d23\u4eba  \u72b6\u6001",
			"  15    \u521b\u59cb\u4eba\u6545\u4e8b\u957f\u6587     \u5efa\u7acb\u4fe1\u4efb\u4e0e\u54c1\u724c\u8ba4   \u5c0f\u7ea2\u4e66\u3001\u77e5\u4e4e    \u5f20\u4f1f    \u5df2\u5b8c\u6210",
			"        \uff08\u5b8c\u6574\u7248\uff09         \u77e5",
			"  16    \u4ea7\u54c1\u529f\u80fd\u5bf9\u6bd4\u8868     \u63a8\u52a8\u8f6c\u5316\u51b3\u7b56       \u77e5\u4e4e\u3001\u5fae\u4fe1\u793e\u7fa4  \u674e\u5a1c    \u8fdb\u884c\u4e2d",
			"  17    30\u79d2\u7ad6\u5c4f\u77ed\u89c6\u9891     \u62c9\u65b0\u4e0e\u66dd\u5149         \u6296\u97f3\u3001\u89c6\u9891\u53f7    \u738b\u5f3a    \u5f85\u6392\u671f",
		]);
		// 11 rows of dim became 5 rows of grid \u2014 the degradation is also
		// half the height, which is what makes it cheaper for the short-
		// terminal residue of FINDING TUI2-MD-1.
		expect(rows).toHaveLength(5);
		expect(isRecord(rows)).toBe(false);
	});

	it("MD1-1b: the wide widths are unchanged \u2014 the natural grid still wins", () => {
		// at 100 and 120 the table already fitted naturally and must not
		// move: shrinking is reached only when the natural widths do not fit.
		for (const term of [100, 120]) {
			const rows = renderMarkdown(TABLE6, W(term)).map(plain);
			expect(`${term}: ${rows.length}`).toBe(`${term}: 4`);
			expect(isRecord(rows)).toBe(false);
		}
		// and the 5-column sample, which fitted at 80 already
		expect(isRecord(renderMarkdown(TABLE5, W(80)).map(plain))).toBe(false);
	});

	/**
	 * The degradation is now GRADUAL rather than a cliff. The floor is
	 * eight columns per column (four CJK characters) \u2014 a judgement, not a
	 * measurement: it is where the report's sample stopped reading as a
	 * table. Below it the record form is still the answer, so the record
	 * form is not retired, only postponed.
	 */
	it("MD1-1c: the ladder \u2014 grid down to the floor, records below it", () => {
		const got = [88, 80, 72, 64, 56, 48].map((term) => {
			const rows = renderMarkdown(TABLE6, W(term)).map(plain);
			return `${term}: ${isRecord(rows) ? "record" : `grid/${rows.length}`}`;
		});
		expect(got).toEqual(["88: grid/4", "80: grid/5", "72: grid/7", "64: grid/8", "56: grid/9", "48: record"]);
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

	it("MD1-1e: every cell SURVIVES at every width \u2014 the bag is never short", () => {
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

	it("MD1-1f: in GRID form nothing is invented either \u2014 the bag is EXACT", () => {
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

	it("MD1-1g: the shrink is a pure function of (block, W) \u2014 same bytes, twice", () => {
		// the freeze guarantee restated on the new path: nothing in the
		// shrink reads a clock, a cache or a previous render.
		for (const term of [48, 56, 64, 72, 80, 100]) {
			expect(renderMarkdown(TABLE6, W(term))).toEqual(renderMarkdown(TABLE6, W(term)));
		}
		// and the tokenizer the shrink measures through is untouched
		expect(splitCells("| a | `x | y` | b |")).toEqual(["a", "`x | y`", "b"]);
	});
});
