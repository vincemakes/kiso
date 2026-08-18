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
	it("T-MD-28: the aligned table — dim rules, a bold header, padded columns", () => {
		const p = palette();
		const rows = renderMarkdown(TABLE, 60);
		expect(rows).toEqual([
			`${p.dim}│${p.reset} ${p.bold}area${p.reset} ${p.dim}│${p.reset} ${p.bold}lines${p.reset} ${p.dim}│${p.reset} ${p.bold}budget${p.reset} ${p.dim}│${p.reset}`,
			`${p.dim}├──────┼───────┼────────┤${p.reset}`,
			`${p.dim}│${p.reset} core ${p.dim}│${p.reset} 1972  ${p.dim}│${p.reset} 2000   ${p.dim}│${p.reset}`,
			`${p.dim}│${p.reset} cli  ${p.dim}│${p.reset} 2012  ${p.dim}│${p.reset} 1920   ${p.dim}│${p.reset}`,
		]);
		// the rule's segments are the column widths plus their two pad columns
		expect(visibleWidth(plain(rows[1]!))).toBe(visibleWidth(plain(rows[0]!)));
	});

	it("T-MD-29: CJK cells measure with the width authority, so the columns line up", () => {
		// two-column CJK headers and cells, mixed with narrow ASCII
		const src = ["| \u5ef6\u8fdf | ms |", "|---|---|", "| \u4fee\u590d\u524d | 120 |", "| a | 45 |"].join("\n");
		const widths = renderMarkdown(src, 60).map((r) => visibleWidth(r));
		expect(new Set(widths).size).toBe(1); // every row exactly as wide as the rest
	});

	it("T-MD-30: styled cell content is measured STRIPPED — SGR has no width", () => {
		const bold = ["| a | b |", "|---|---|", "| **45ms** | x |"].join("\n");
		const flat = ["| a | b |", "|---|---|", "| 45ms | x |"].join("\n");
		expect(renderMarkdown(bold, 60).map((r) => visibleWidth(r))).toEqual(renderMarkdown(flat, 60).map((r) => visibleWidth(r)));
	});

	it("T-MD-31: the alignment column comes from the delimiter row", () => {
		const src = ["| head | head | head |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
		expect(plain(renderMarkdown(src, 60)[2]!)).toBe("│ a    │  b   │    c │");
	});

	it("T-MD-32: too narrow -> the VERTICAL record, every cell kept", () => {
		const p = palette();
		const wide = ["| area | n |", "|---|---|", "| a-very-long-area-name | 1 |", "| b | 2 |"].join("\n");
		// the natural table is 29 columns; at 28 it becomes records
		expect(renderMarkdown(wide, 28)).toEqual([
			`${p.bold}area${p.reset}${p.dim}:${p.reset} a-very-long-area-name`,
			`${p.dim}n: 1${p.reset}`,
			"",
			`${p.bold}area${p.reset}${p.dim}:${p.reset} b`,
			`${p.dim}n: 2${p.reset}`,
		]);
		// one column more and the aligned table is back
		expect(plain(renderMarkdown(wide, 29)[0]!)).toBe("│ area                  │ n │");
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
		const wide = renderMarkdown(MD_BENCHMARK, 100).map(plain);
		expect(wide.some((r) => r.startsWith("├") && r.includes("┼"))).toBe(true);
		const narrow = renderMarkdown(MD_BENCHMARK, 34).map(plain);
		expect(narrow.some((r) => r.startsWith("├"))).toBe(false);
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
