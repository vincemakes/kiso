/**
 * DC-1 / DC-2 — the two text surfaces a new reader meets first.
 *
 * DC-1: /help builds each row as `name + "    " + desc`, four spaces
 * regardless of the name's length, so the description column wanders by
 * three columns between `/help` and `/compact`. A list whose second
 * column moves is harder to scan than a list with no second column.
 *
 * DC-2: the sheet's panel row is 76 columns and `cutRow` truncates at
 * the width with no mark, so at 72 the row's last clause `t types`
 * becomes `t` — the reader is told a key exists and not told what it
 * does. The row is a list of independent clauses, so it degrades by
 * dropping whole clauses; the ellipsis is the floor below that.
 */

import { describe, expect, it } from "vitest";
import { PANEL_KEYS_ROW, helpRows, keysSheetRows } from "../src/strings.js";
import { displayWidth } from "../src/width.js";

const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");
const helpLines = (): string[] => helpRows().flatMap((r) => plain(r).split("\n"));
const panelRow = (W: number): string => plain(keysSheetRows(W)[keysSheetRows(W).length - 1]!);

describe("DC-1 — /help has one description column", () => {
	it("every description begins at the same column", () => {
		const starts = helpLines().map((line) => {
			const m = /^(\S+)(\s+)/.exec(line);
			return m === null ? -1 : displayWidth(m[1]! + m[2]!);
		});
		expect(starts).not.toContain(-1);
		expect(new Set(starts).size).toBe(1);
	});

	it("the longest name still gets a gap — the column is not flush", () => {
		const longest = Math.max(...helpLines().map((l) => displayWidth(/^\S+/.exec(l)![0])));
		const start = displayWidth(/^(\S+\s+)/.exec(helpLines()[0]!)![1]!);
		expect(start).toBeGreaterThan(longest);
	});
});

describe("DC-2 — the panel row degrades by clause, never mid-word", () => {
	it("is whole when the width allows it", () => {
		expect(panelRow(100)).toBe(PANEL_KEYS_ROW);
	});

	it("drops whole clauses rather than cutting one in half", () => {
		for (const W of [60, 64, 68, 72, 75]) {
			const row = panelRow(W);
			expect(displayWidth(row), `W=${W} overruns`).toBeLessThanOrEqual(W);
			// what survives is a run of whole clauses from the front
			const kept = row.replace(/…$/, "");
			expect(PANEL_KEYS_ROW.startsWith(kept), `W=${W}: ${JSON.stringify(row)}`).toBe(true);
			if (!row.endsWith("…")) {
				const rest = PANEL_KEYS_ROW.slice(kept.length);
				expect(rest === "" || rest.startsWith(" · "), `W=${W} cut mid-clause`).toBe(true);
			}
		}
	});

	it("marks the cut when even the first clause will not fit", () => {
		const row = panelRow(12);
		expect(displayWidth(row)).toBeLessThanOrEqual(12);
		expect(row.endsWith("…")).toBe(true);
	});

	it("never leaves a dangling one-character clause", () => {
		for (let W = 40; W <= 80; W += 1) {
			expect(panelRow(W), `W=${W}`).not.toMatch(/· .$/);
		}
	});
});
