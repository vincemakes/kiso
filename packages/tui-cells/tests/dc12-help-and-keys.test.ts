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
import { SHEET_CLOSE, helpRows, keysSheetRows } from "../src/strings.js";
import { displayWidth } from "../src/width.js";

const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");
const helpLines = (): string[] => helpRows().flatMap((r) => plain(r).split("\n"));
const closeRow = (W: number): string => plain(keysSheetRows(W)[keysSheetRows(W).length - 1]!);

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

/* DECLARED REVERSAL (the sheets round, owner, 2026-10-06): DC-2's panel
   row (`panels: ↑↓ move · ⏎ confirms · digits act on their row · t types`)
   and its clause-dropping ladder retired with the keys sheet's grid. Each
   panel's own key row says its keys (§8.2, P3, P4), and the row had gone
   stale. What closes the sheet now is the row every sheet closes on. */
describe("the sheets round — the keys sheet closes on the row every sheet has", () => {
	it("whole where it fits, cut with … where it does not, and always last", () => {
		for (let W = 12; W <= 100; W += 1) {
			const row = closeRow(W);
			expect(displayWidth(row), `W=${W} overruns`).toBeLessThanOrEqual(W);
			if (W >= SHEET_CLOSE.length + 2) expect(row, `W=${W}`).toBe(`  ${SHEET_CLOSE}`);
			else expect(row.endsWith("\u2026"), `W=${W}: ${row}`).toBe(true);
		}
	});
});
