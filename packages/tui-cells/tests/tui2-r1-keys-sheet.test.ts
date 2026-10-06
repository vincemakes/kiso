/**
 * TUI2-R1 slice ⑤ — T-V4 (the rows half): the `?` keys sheet.
 *
 * The sheet's whole point is that it is TRUE. A keys sheet that drifts
 * from the keys is worse than none, so there is exactly ONE table —
 * KEY_BINDINGS — and the sheet is generated from it, never transcribed.
 * A future round that adds a gesture and forgets the sheet cannot happen
 * without deleting a test.
 *
 * /help's own keys sentence stays byte-identical this round: rewriting
 * it would move an assertion outside the two declared supersession
 * classes. `keysHelpRow()` is the derived form waiting for the round
 * that is allowed to swap it in; until then a drift guard keeps the two
 * from contradicting each other.
 */

import { afterEach, describe, expect, it } from "vitest";
import { KEY_BINDINGS, SHEET_CLOSE, helpRows, keysHelpRow, keysSheetRows } from "../src/strings.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

describe("TUI2-R1 T-V4 — the keys sheet's rows", () => {
	// Re-derived for the sheets round (owner, 2026-10-06): the sheet is two
	// columns of key · what at the content edge, measured over the table,
	// closed by the row every sheet has. DECLARED REVERSAL of the
	// prototype's grid (its hand-set stops 16/43/36/39, column 0, the bold
	// keys of DC-3) and of the panels row (R1.5 pin 6, R6/D2): each panel's
	// own key row says its keys, and `t types` had left /model in P3.
	it("the sheet is one screen: the band, the bindings two to a row, the closing row", () => {
		setTTY(false);
		const sheet = keysSheetRows(80);
		expect(sheet[0]).toMatch(/^─── keys ─+$/);
		expect(sheet.slice(1)).toEqual([
			"  enter   send                          esc     stop the run",
			"  ctrl+j  newline (shift+⏎ too)         alt+⏎   stop it, send this",
			"  @       files                         /       commands",
			"  ↑↓      history · take back a steer   tab     complete",
			"  ctrl+o  expand all                    ctrl+r  transcript",
			"  ctrl+t  hide thinking                 ctrl+g  edit in $EDITOR",
			"  alt+←→  word motion                   alt+⌫   delete a word (ctrl+w too)",
			"  ctrl+z  undo                          ctrl+y  redo",
			"  ctrl+x  copy the answer               ctrl+v  attach an image",
			"  !cmd    run it and send it            !!cmd   run it, show it here only",
			// DECLARED ADDITION (the second main-sync round, ADR-0058 3e):
			// ctrl+b, on a row of its own — the table's count is odd
			"  ctrl+b  background a command",
			`  ${SHEET_CLOSE}`,
		]);
	});

	it("every row fits the width — the sheet cuts, it never wraps; narrower than two columns, it is one", () => {
		setTTY(false);
		for (const W of [20, 34, 50, 60, 80, 120]) {
			const rows = keysSheetRows(W);
			const two = rows.length === 1 + Math.ceil(KEY_BINDINGS.length / 2) + 1;
			expect(two || rows.length === 1 + KEY_BINDINGS.length + 1, `W=${W}: ${rows.length} rows`).toBe(true);
			expect(two, `W=${W}`).toBe(W >= 74); // 2 + 6 + 2 + 27 + 3 + 6 + 2 + 26 cells
			for (const row of rows) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("the band names it; the key in ink, what it does dim; the closing row dim — the command list's tones", () => {
		setTTY(true);
		const rows = keysSheetRows(80);
		expect(rows[0]).toMatch(/─── keys ─+/);
		expect(rows[1]).toContain(`  enter   \x1b[2msend\x1b[0m`);
		expect(rows[1]).not.toContain("\x1b[1menter");
		expect(rows.at(-1)).toBe(`  \x1b[2m${SHEET_CLOSE}\x1b[0m`);
	});

	it("ONE SOURCE — every binding in the table reaches the sheet, on one row, and nothing but the table does", () => {
		setTTY(false);
		const sheet = keysSheetRows(200);
		for (const binding of KEY_BINDINGS) {
			const row = sheet.find((r) => r.includes(binding.what));
			expect(row, `the sheet must show ${binding.keys}`).toBeDefined();
			expect(row!.indexOf(binding.keys), `${binding.keys} stands before what it does`).toBeLessThan(row!.indexOf(binding.what));
		}
		// and the sheet invents nothing: strip the table's own text, the band
		// and the closing row, and what is left is whitespace
		let residue = sheet.slice(1, -1).join("\n");
		for (const b of KEY_BINDINGS) residue = residue.replace(b.what, "").replace(b.keys, "");
		expect(residue.trim()).toBe("");
		expect(sheet.at(-1)).toBe(`  ${SHEET_CLOSE}`);
	});

	it("the DRIFT GUARD on /help — its keys sentence still mentions every gesture the table names", () => {
		setTTY(false);
		// /help's printed table (a pipe's) is unchanged; on a dock /help
		// opens the command list now (§8.16).
		const keysRow = helpRows().join("\n").split("\n").find((r) => r.startsWith("keys"));
		expect(keysRow).toBeDefined();
		for (const gesture of ["enter", "ctrl+J", "shift+enter", "esc", "alt+⏎", "@"]) {
			expect(keysRow, `/help must mention ${gesture}`).toContain(gesture);
		}
		// re-derived for the sheets round: `? this sheet` left the table —
		// `?` is how you got there — and the derived row follows the table
		expect(keysHelpRow()).toBe(KEY_BINDINGS.map((b) => `${b.keys} ${b.what}`).join(" · "));
	});

	it("the table names the REAL bindings — every gesture the editor implements is in it", () => {
		// the editor's gesture set, transcribed from editor.ts's feed():
		// enter submits, esc stops, ctrl+j inserts a newline, alt+⏎
		// redirects, @ picks files, / opens the menu, ↑↓ walk the history
		// and pop the queue, tab completes, ctrl+o expands, ctrl+r opens the
		// transcript, ctrl+t hides thinking, ctrl+g edits in $EDITOR, E1's
		// word motion and deletion, UD-1's undo and redo, ctrl+x copies,
		// ctrl+v attaches an image, and the two shell gestures.
		//
		// Re-derived for the sheets round (owner, 2026-10-06): the table is
		// read in pairs, left then right; a key with two spellings is named
		// by one; ctrl+t, ctrl+g and the `!` gestures joined from /help's
		// table; `?` left (it is how you got here).
		expect(KEY_BINDINGS.map((b) => b.keys)).toEqual(["enter", "esc", "ctrl+j", "alt+⏎", "@", "/", "↑↓", "tab", "ctrl+o", "ctrl+r", "ctrl+t", "ctrl+g", "alt+←→", "alt+⌫", "ctrl+z", "ctrl+y", "ctrl+x", "ctrl+v", "!cmd", "!!cmd", "ctrl+b"]);
	});
});
