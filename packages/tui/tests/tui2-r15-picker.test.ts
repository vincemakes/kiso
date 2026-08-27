/**
 * TUI2-R1.5 slices ⑧ + ⑦(b) — VD-9 + VD-8: the picker and the menu read
 * as surfaces.
 *
 * ⑧ (VD-9): the selection was a two-cell `→ ` marker on the inverse
 * band, which at a glance is one character of highlight in an
 * eighty-column row; and the directory was pushed to the far right edge,
 * ~80 columns from the filename it belongs to, so the eye had to travel
 * the row to learn which `parser.ts` this was. Full-row reverse video
 * (the W16 chip mechanism, already the user chip's own) and the
 * directory ADJACENT to the name, dim.
 *
 * ⑦(b) (VD-8): both bands render frameless directly above the composer,
 * bleeding into whatever scrollback happens to sit there. A one-row dim
 * header names the surface. Mono discipline: dim text only, no new
 * colours.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atPanelRows, atRow } from "../src/at-picker.js";
import { Body } from "../src/compositor.js";

function setTTY(on: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}
beforeEach(() => setTTY(false));
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const match = (path: string, hit: number[] = []): Parameters<typeof atRow>[0] => ({ path, hit, run: hit.length });

describe("TUI2-R1.5 ⑧ — the picker is legible (VD-9)", () => {
	it("the directory rides NEXT TO the name, dim — never at the far edge", () => {
		const row = atRow(match("src/parser.ts"), false, 100);
		expect(row).toContain("parser.ts  — src/");
		// nothing is pushed to column 100 any more
		expect(row.length).toBeLessThan(40);
	});

	it("a ROOT file carries no directory suffix at all", () => {
		expect(atRow(match("README.md"), false, 100)).not.toContain("—");
	});

	it("the SELECTED row is highlighted FULL-ROW, not by one marker character", () => {
		setTTY(true);
		const row = atRow(match("src/parser.ts"), true, 40);
		// the reverse span opens at the row's first cell and closes at its last
		expect(row.startsWith("\x1b[7m")).toBe(true);
		expect(row.endsWith("\x1b[27m")).toBe(true);
		// and it covers the row's whole text width — the band reads as a bar
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain.length).toBe(40);
	});

	it("an UNSELECTED row carries no reverse video at all", () => {
		setTTY(true);
		expect(atRow(match("src/parser.ts"), false, 40)).not.toContain("\x1b[7m");
	});

	it("every row fits the width, selected or not, at every width", () => {
		setTTY(true);
		for (const W of [20, 30, 40, 60, 80, 100]) {
			for (const sel of [true, false]) {
				const plain = atRow(match("src/very/deep/nesting/parser.ts"), sel, W).replace(/\x1b\[[0-9;]*m/g, "");
				expect(plain.length, `W=${W} sel=${sel}`).toBeLessThanOrEqual(W);
			}
		}
	});
});

describe("TUI2-R1.5 ⑦(b) — the band names itself (VD-8)", () => {
	it("the @ picker band opens with the dashed rule that names it `files`", () => {
		setTTY(true);
		const rows = atPanelRows({ matches: [match("src/parser.ts"), match("README.md")], selected: 0, capped: false }, 60);
		// R2: the band's label rides the RULE — a band opens the way the
		// composer and every panel now open, and the label says which band.
		expect(rows[0]!.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/^\u2500{3} files \u2500+$/);
		// the counter still closes the band
		expect(rows[rows.length - 1]).toContain("(1/2)");
	});

	it("the / menu band opens with a one-row dim `commands` header", () => {
		setTTY(true);
		Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
		body.bindMenu(() => ({ items: [{ name: "/help", desc: "print this list" }], selected: 0 }));
		body.enter();
		const frame = writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(frame).toContain("commands");
		delete (process.stdout as { rows?: number }).rows;
		delete (process.stdout as { columns?: number }).columns;
	});

	it("the header is dim text and nothing else — the mono discipline", () => {
		setTTY(true);
		const rows = atPanelRows({ matches: [match("a.ts")], selected: 0, capped: false }, 60);
		expect(rows[0]).not.toMatch(/\x1b\[3[0-9]m/); // no colour
		expect(rows[0]).not.toContain("\x1b[7m"); // no reverse
	});
});
