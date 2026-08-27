/**
 * TUI2-MD slice ④ — tables, and the narrow degradation that NEVER
 * truncates.
 *
 * A table is the one construct whose layout depends on content the
 * scanner has not seen yet: column widths are measured from the rows,
 * so a later long cell changes every earlier line. Under a mutable
 * transcript that is free. Under committed lines it is forbidden —
 * which is why the table block stays in the live region until it
 * CLOSES, and only then becomes commit-eligible (slice ①'s T-MD-6).
 *
 * The width question is settled honestly rather than cleverly. Columns
 * are measured at their NATURAL widths on the inline-rendered,
 * SGR-stripped text; if the table cannot fit, it does not shrink and it
 * does not cut — each row becomes a record: the first column is the
 * record's name, the rest a dim `label: value` run. Every cell survives
 * at every width, which is the only property that matters when the
 * bytes are about to become permanent.
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

describe("TUI2-MD ④ — tables", () => {
	/**
	 * R2 supersession (2026-08-27, the nineteen-screen review): the rails
	 * are gone. A table is bounded by the blank lines above and below it,
	 * exactly as every other block on the screen is, and it was the last
	 * box left on a screen that has decided not to have boxes. Alignment
	 * does the work the rails were doing, the header is still bold, and a
	 * copied table is closer to markdown without them.
	 */
	it("T-MD-28: the aligned table — a bold header, padded columns, no rails", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE, 60);
		expect(rows).toEqual([
			`  ${p.bold}area${p.reset}  ${p.bold}lines${p.reset}  ${p.bold}budget${p.reset}`,
			"  core  1972   2000",
			"  cli   2012   1920",
		]);
		expect(rows.every((r) => !plain(r).includes("│"))).toBe(true);
	});

	it("T-MD-29: CJK cells measure with the width authority, so the columns line up", () => {
		// two-column CJK headers and cells, mixed with narrow ASCII
		const src = ["| \u5ef6\u8fdf | ms |", "|---|---|", "| \u4fee\u590d\u524d | 120 |", "| a | 45 |"].join("\n");
		// R2: without rails the rows no longer pad to a common width, so the
		// subject is stated directly — every COLUMN starts at the same
		// place, which is what "the columns line up" always meant.
		const rows = renderMarkdown(src, 60).map(plain);
		const second = rows.map((r) => visibleWidth(r.slice(0, r.lastIndexOf("  ") + 2)));
		expect(new Set(second).size).toBe(1);
	});

	it("T-MD-30: styled cell content is measured STRIPPED — SGR has no width", () => {
		const bold = ["| a | b |", "|---|---|", "| **45ms** | x |"].join("\n");
		const flat = ["| a | b |", "|---|---|", "| 45ms | x |"].join("\n");
		expect(renderMarkdown(bold, 60).map((r) => visibleWidth(r))).toEqual(renderMarkdown(flat, 60).map((r) => visibleWidth(r)));
	});

	it("T-MD-31: the alignment column comes from the delimiter row", () => {
		const src = ["| head | head | head |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
		expect(plain(renderMarkdown(src, 60)[1]!)).toBe("  a      b       c"); // left, centre, right — R2: no rails
	});

	it("T-MD-32: too narrow -> the VERTICAL record, every cell kept", () => {
		const p = palette();
		const wide = ["| area | n |", "|---|---|", "| a-very-long-area-name | 1 |", "| b | 2 |"].join("\n");
		// R2: the rails cost four columns, so the natural table is 28 now
		// and the record threshold moved with it. The SUBJECT — that a
		// table which cannot be drawn becomes records rather than being
		// cut — is untouched, and it is exercised at the new threshold.
		expect(renderMarkdown(wide, 27)).toEqual([
			`${p.bold}area${p.reset}${p.dim}:${p.reset} a-very-long-area-name`,
			`${p.dim}n: 1${p.reset}`,
			"",
			`${p.bold}area${p.reset}${p.dim}:${p.reset} b`,
			`${p.dim}n: 2${p.reset}`,
		]);
		// one column more and the aligned table is back
		expect(plain(renderMarkdown(wide, 28)[0]!)).toBe("  area                   n");
	});

	it("T-MD-33: NOTHING is ever truncated — every cell appears at every width", () => {
		const cells = ["area", "lines", "budget", "core", "1972", "2000", "cli", "2012", "1920"];
		for (let W = 12; W <= 90; W += 1) {
			const text = renderMarkdown(TABLE, W).map(plain).join(" ");
			for (const cell of cells) expect(`W=${W} ${cell}: ${text.includes(cell)}`).toBe(`W=${W} ${cell}: true`);
			expect(text).not.toContain("…"); // no ellipsis anywhere: the cut that never happens
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
		// narrow form is records. The discriminator is the record form's
		// own `label: value` shape, which no aligned row has.
		const wide = renderMarkdown(MD_BENCHMARK, 100).map(plain);
		const narrow = renderMarkdown(MD_BENCHMARK, 34).map(plain);
		expect(wide.some((r) => /^ {2}\S+ +\S/.test(r) && !r.includes(": "))).toBe(true);
		expect(narrow.some((r) => r.includes(": "))).toBe(true);
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
