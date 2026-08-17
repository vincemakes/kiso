/**
 * TUI2-R1 slice ⑤ — T-V4 (the rows half): the `?` keys sheet.
 *
 * The sheet's whole point is that it is TRUE. A keys sheet that drifts
 * from the keys is worse than none, so there is exactly ONE table —
 * KEY_BINDINGS — and both readers (the sheet, and /help's keys row)
 * derive from it. A future round that adds a gesture and forgets the
 * sheet cannot happen without deleting a test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { KEY_BINDINGS, PANEL_KEYS_ROW, helpRows, keysSheetRows } from "../src/strings.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

describe("TUI2-R1 T-V4 — the keys sheet's rows", () => {
	it("the sheet is the prototype's frame, one screen, the grid aligned", () => {
		setTTY(false);
		expect(keysSheetRows(80)).toEqual([
			"keys",
			"enter send      ctrl+j / shift+⏎ newline    @ files",
			"esc stop        alt+⏎ / ctrl+⏎ redirect     / commands",
			"↑↓ history / queue pop              ctrl+r expand cells",
			"tab complete (menu / @)             ? this sheet",
			"panels: digits select · space toggles · t types an answer",
		]);
	});

	it("every row fits the width — the sheet cuts, it never wraps into a second screen", () => {
		setTTY(false);
		for (const W of [20, 34, 50, 60, 80, 120]) {
			const rows = keysSheetRows(W);
			expect(rows).toHaveLength(6);
			for (const row of rows) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("the header is bold, the keys tinted, the panel row dim — the prototype's placement", () => {
		setTTY(true);
		const rows = keysSheetRows(80);
		expect(rows[0]).toBe("\x1b[1mkeys\x1b[0m");
		expect(rows[1]).toContain("\x1b[38;5;252menter\x1b[0m send");
		expect(rows[5]).toBe(`\x1b[2m${PANEL_KEYS_ROW}\x1b[0m`);
	});

	it("ONE SOURCE — /help's keys row is derived from the same table, so the two can never disagree", () => {
		setTTY(false);
		const keysRow = helpRows().join("\n").split("\n").find((r) => r.startsWith("keys"));
		expect(keysRow).toBeDefined();
		for (const binding of KEY_BINDINGS) {
			expect(keysRow, `/help must mention ${binding.keys}`).toContain(binding.keys);
			expect(keysSheetRows(200).join("\n"), `the sheet must mention ${binding.keys}`).toContain(binding.keys);
		}
	});

	it("the table names the REAL bindings — every gesture the editor implements is in it", () => {
		// the editor's gesture set, transcribed from editor.ts's feed():
		// enter submits, ctrl+j/shift+⏎ insert a newline, esc stops,
		// alt+⏎/ctrl+⏎ redirect, @ picks files, / opens the menu, ↑↓ walk
		// the history and pop the queue, ctrl+r expands, tab completes,
		// ? opens this sheet.
		expect(KEY_BINDINGS.map((b) => b.keys)).toEqual([
			"enter",
			"ctrl+j / shift+⏎",
			"@",
			"esc",
			"alt+⏎ / ctrl+⏎",
			"/",
			"↑↓",
			"ctrl+r",
			"tab",
			"?",
		]);
	});
});
