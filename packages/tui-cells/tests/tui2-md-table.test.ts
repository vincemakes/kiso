/**
 * TUI2-MD slice \u2463 \u2014 tables, and the narrow degradation that NEVER
 * truncates.
 *
 * A table is the one construct whose layout depends on content the
 * scanner has not seen yet: column widths are measured from the rows,
 * so a later long cell changes every earlier line. Under a mutable
 * transcript that is free. Under committed lines it is forbidden \u2014
 * which is why the table block stays in the live region until it
 * CLOSES, and only then becomes commit-eligible (slice \u2460's T-MD-6).
 *
 * The width question is settled honestly rather than cleverly. Columns
 * are measured at their NATURAL widths on the inline-rendered,
 * SGR-stripped text; if those do not fit, the columns SHRINK and the
 * cells wrap inside them (MD-1.1), and only when every column has
 * reached its floor does each row become a record: the first column is
 * the record's name, the rest a `label: value` run. Nothing is cut in
 * either form. Every cell survives at every width, which is the only
 * property that matters when the bytes are about to become permanent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import { renderMarkdown } from "../src/md.js";
import { palette } from "../src/render.js";
import { MD_BENCHMARK } from "./helpers/md-benchmark.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const TABLE = ["| area | lines | budget |", "|---|---|---|", "| core | 1972 | 2000 |", "| cli | 2012 | 1920 |"].join("\n");

describe("TUI2-MD \u2463 \u2014 tables", () => {
	/**
	 * R2 supersession (2026-08-27, the nineteen-screen review): the rails
	 * are gone. A table is bounded by the blank lines above and below it,
	 * exactly as every other block on the screen is, and it was the last
	 * box left on a screen that has decided not to have boxes. Alignment
	 * does the work the rails were doing, the header is still bold, and a
	 * copied table is closer to markdown without them.
	 */
	it("T-MD-28: the aligned table \u2014 a bold header, padded columns, no rails", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE, 60);
		expect(rows).toEqual([
			`  ${p.bold}area${p.reset}  ${p.bold}lines${p.reset}  ${p.bold}budget${p.reset}`,
			"  core  1972   2000",
			"  cli   2012   1920",
		]);
		expect(rows.every((r) => !plain(r).includes("\u2502"))).toBe(true);
	});

	it("T-MD-29: CJK cells measure with the width authority, so the columns line up", () => {
		// two-column CJK headers and cells, mixed with narrow ASCII
		const src = ["| \u5ef6\u8fdf | ms |", "|---|---|", "| \u4fee\u590d\u524d | 120 |", "| a | 45 |"].join("\n");
		// R2: without rails the rows no longer pad to a common width, so the
		// subject is stated directly \u2014 every COLUMN starts at the same
		// place, which is what "the columns line up" always meant.
		const rows = renderMarkdown(src, 60).map(plain);
		const second = rows.map((r) => visibleWidth(r.slice(0, r.lastIndexOf("  ") + 2)));
		expect(new Set(second).size).toBe(1);
	});

	it("T-MD-30: styled cell content is measured STRIPPED \u2014 SGR has no width", () => {
		const bold = ["| a | b |", "|---|---|", "| **45ms** | x |"].join("\n");
		const flat = ["| a | b |", "|---|---|", "| 45ms | x |"].join("\n");
		expect(renderMarkdown(bold, 60).map((r) => visibleWidth(r))).toEqual(renderMarkdown(flat, 60).map((r) => visibleWidth(r)));
	});

	it("T-MD-31: the alignment column comes from the delimiter row", () => {
		const src = ["| head | head | head |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
		expect(plain(renderMarkdown(src, 60)[1]!)).toBe("  a      b       c"); // left, centre, right \u2014 R2: no rails
	});

	it("T-MD-32: too narrow -> the VERTICAL record, every cell kept", () => {
		const p = palette();
		const wide = ["| area | n |", "|---|---|", "| a-very-long-area-name | 1 |", "| b | 2 |"].join("\n");
		// DECLARED SUPERSESSION (MD-1.1, 2026-09-11): the flip width moves
		// from 27/28 to 14/15, and it is not a threshold tweak \u2014 the test
		// that reaches the record form CHANGED. A table no longer has to fit
		// at its NATURAL widths: the columns shrink and the cells wrap inside
		// them first, and the record form is reached only when every column
		// has spent itself down to CELL_FLOOR (8) and the grid still does not
		// fit. For this fixture that minimum is 2 + 8 + 2 + 1 + 2 = 15, so 14
		// is the widest width at which records are still the right answer.
		//
		// The SUBJECT \u2014 that a table which cannot be drawn becomes records
		// rather than being cut \u2014 is untouched, and it is exercised at the
		// new threshold. The long value wrapping across two rows is the same
		// ruling seen from the other side: wrapped, never cut.
		expect(renderMarkdown(wide, 14)).toEqual([
			`${p.bold}area${p.reset}${p.dim}:${p.reset}`,
			"a-very-long-ar",
			"ea-name",
			`${p.dim}n: 1${p.reset}`,
			"",
			`${p.bold}area${p.reset}${p.dim}:${p.reset} b`,
			`${p.dim}n: 2${p.reset}`,
		]);
		// one column more and the aligned table is back \u2014 at SHRUNK columns
		// (8/1), which is the whole of MD-1.1 in one assertion
		expect(plain(renderMarkdown(wide, 15)[0]!)).toBe("  area      n");
		expect(plain(renderMarkdown(wide, 15)[1]!)).toBe("  a-very-l  1");
	});

	it("T-MD-33: NOTHING is ever truncated \u2014 every cell appears at every width", () => {
		const cells = ["area", "lines", "budget", "core", "1972", "2000", "cli", "2012", "1920"];
		for (let W = 12; W <= 90; W += 1) {
			const text = renderMarkdown(TABLE, W).map(plain).join(" ");
			for (const cell of cells) expect(`W=${W} ${cell}: ${text.includes(cell)}`).toBe(`W=${W} ${cell}: true`);
			expect(text).not.toContain("\u2026"); // no ellipsis anywhere: the cut that never happens
		}
	});

	it("T-MD-34: a REJECTED table falls back to its own source bytes", () => {
		// a body row wider than the header, and a table with no delimiter
		// row: both stay valid markdown rather than becoming a guess
		const overflow = ["| a | b |", "|---|---|", "| 1 | 2 | 3 |"].join("\n");
		expect(renderMarkdown(overflow, 60).map(plain)).toEqual(["| a | b |", "|---|---|", "| 1 | 2 | 3 |"]);
		// mid-stream, before the delimiter row lands, the header is raw too
		expect(renderMarkdown("| a | b |", 60).map(plain)).toEqual(["| a | b |"]);
	});

	it("T-MD-35: the acceptance content's table renders wide and degrades narrow", () => {
		// R2: the wide form is an ALIGNED table (no rails to look for), the
		// narrow form is records.
		//
		// DECLARED SUPERSESSION (MD-1.1, 2026-09-11), and a DEAD NEEDLE
		// caught while making it: the narrow width moves 34 -> 33, because
		// the acceptance table's floors now fit in 34. Left at 34 this case
		// still PASSED \u2014 but on a grid, because the only `": "` on the screen
		// was the `MaxListenersExceededWarning: 11` paragraph. A
		// discriminator that any prose can satisfy is not a discriminator, so
		// it is replaced by one the record form alone can produce: the
		// record's own leading row, `header[0]: value`, verbatim.
		const wide = renderMarkdown(MD_BENCHMARK, 100).map(plain);
		const narrow = renderMarkdown(MD_BENCHMARK, 33).map(plain);
		expect(wide.some((r) => /^ {2}\S+ +\S/.test(r) && !r.includes(": "))).toBe(true);
		expect(narrow).toContain("\u533a\u57df: core"); // the record form and nothing else draws this
		expect(wide.some((r) => r.startsWith("\u533a\u57df: "))).toBe(false);
		// the numbers from the table body are present at BOTH widths
		for (const cell of ["1972", "2000", "2012", "1920", "1468", "1280"]) {
			expect(`${cell} wide=${wide.join(" ").includes(cell)} narrow=${narrow.join(" ").includes(cell)}`).toBe(`${cell} wide=true narrow=true`);
		}
	});

	it("T-MD-36: the table holds the width invariant at every width", () => {
		const offenders: string[] = [];
		for (let W = 10; W <= 90; W += 1) for (const row of renderMarkdown(TABLE, W)) if (visibleWidth(row) > W) offenders.push(`W=${W} w=${visibleWidth(row)}`);
		expect(offenders.slice(0, 5)).toEqual([]);
	});
});
