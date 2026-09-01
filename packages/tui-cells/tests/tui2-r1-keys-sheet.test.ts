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
import { KEY_BINDINGS, PANEL_KEYS_ROW, helpRows, keysHelpRow, keysSheetRows } from "../src/strings.js";

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
		// The prototype's own frame, transcribed — with ONE correction it
		// asked for: its row 2 put the third column at 42 while row 1 put
		// it at 43, which is a hand-spacing slip, not a design. The stops
		// are 16/43 on both rows, so the column the prototype was drawing
		// is the column that renders.
		// DECLARED ADDITION (R5): ctrl+o joins at index 8 and the tail
		// shifts by one, so the last two bindings now share a row and the
		// undo row is no longer alone. The stops are untouched.
		// DECLARED SUPERSESSION (R8b, 2026-09-01): the sheet opens with a
		// LABELLED RULE now, like every other band (`─── commands ───`,
		// `─── files ───`, `─── sessions ───`). It used to be a bare bold
		// word at column 0 — the exact condition TUI2-R1.5 ⑦(b) named
		// when it made the rule, since with scrollback behind an overlay
		// nothing said where the surface began. The GRID below is
		// untouched, which is what this case is actually about.
		const sheet = keysSheetRows(80);
		expect(sheet[0]).toMatch(/^─── keys ─+$/);
		expect(sheet.slice(1)).toEqual([
			"enter send      ctrl+j / shift+⏎ newline   @ files",
			"esc stop        alt+⏎ / ctrl+⏎ redirect    / commands",
			"↑↓ history / queue pop              ctrl+r expand cells",
			"ctrl+o transcript                   tab complete (menu / @)",
			"? this sheet                        ctrl+z / ctrl+y undo / redo",
			// MOVED (the TUI2-R3v2 panel-selection supersession class): R1.5
			// pin 6 chose "digits pick · ⏎ confirms" as the one sentence true
			// of an approval where a digit SELECTED and an ask where a digit
			// ANSWERED. This round removed that disagreement — every panel is
			// a list with a bar on it — so the row names the gestures
			// outright, in the SAME words the live panel's own hint line
			// uses ("↑↓ move · ⏎ or click confirms · 1-4 instant").
			// DECLARED SUPERSESSION (R6/D2): the row claims only what is
			// true of EVERY panel. `1-4 instant` was false on the ask's
			// multi-select and on the pick panel (a digit there only moves
			// the cursor), `or click` was false on both (their frames
			// report no clickable span), and "1-4" was wrong for any panel
			// with a different option count — while its own comment said
			// the sentence was true of every flavor. Each panel's own row
			// now states that panel's whole truth.
			"panels: ↑↓ move · ⏎ confirms · digits act on their row · t types",
		]);
	});

	it("every row fits the width — the sheet cuts, it never wraps into a second screen", () => {
		setTTY(false);
		for (const W of [20, 34, 50, 60, 80, 120]) {
			const rows = keysSheetRows(W);
			expect(rows).toHaveLength(7); // UD-1: + the undo row
			for (const row of rows) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("the header is bold, the keys tinted, the panel row dim — the prototype's placement", () => {
		setTTY(true);
		const rows = keysSheetRows(80);
		// R8b: the header is the band's dim labelled rule now, not a bold
		// word — see the frame case above for why.
		expect(rows[0]).toMatch(/^\x1b\[2m─── keys ─+\x1b\[0m$/);
		// DC-3 supersession: the key NAMES borrowed the inline-code tint
		// (#d0d0d0, 1.54:1 on a white terminal), which made the least
		// readable thing on screen the one screen whose whole job is being
		// read. They are the sheet's CONTENT, so they are bold.
		expect(rows[1]).toContain("\x1b[1menter\x1b[0m send");
		expect(rows[6]).toBe(`\x1b[2m${PANEL_KEYS_ROW}\x1b[0m`); // R5: the grid packed to 5 rows again, so the panel row is back at 6
	});

	it("ONE SOURCE — every binding in the table reaches the sheet, and nothing but the table does", () => {
		setTTY(false);
		const sheet = keysSheetRows(200).join("\n");
		for (const binding of KEY_BINDINGS) {
			expect(sheet, `the sheet must show ${binding.keys}`).toContain(`${binding.keys} ${binding.what}`);
		}
		// and the sheet invents nothing: strip the table's own text and the
		// header/footer, and what is left is whitespace
		let residue = sheet;
		for (const b of KEY_BINDINGS) residue = residue.replace(`${b.keys} ${b.what}`, "");
		// R8b: strip the band header as a HEADER — matching the bare word
		// left its rule behind and the residue stopped being whitespace.
		residue = residue.replace(/─+ keys ─+/, "").replace(PANEL_KEYS_ROW, "");
		expect(residue.trim()).toBe("");
	});

	it("the DRIFT GUARD on /help — its keys sentence still mentions every gesture the table names", () => {
		setTTY(false);
		// /help's row is deliberately NOT derived this round: rewriting it
		// would move an assertion outside the two declared supersession
		// classes. This is the guard that keeps the two honest until a
		// round is allowed to make the swap (keysHelpRow exists for it).
		const keysRow = helpRows().join("\n").split("\n").find((r) => r.startsWith("keys"));
		expect(keysRow).toBeDefined();
		// the gestures /help spells out, in its own words
		for (const gesture of ["enter", "ctrl+J", "shift+enter", "esc", "alt+⏎", "@"]) {
			expect(keysRow, `/help must mention ${gesture}`).toContain(gesture);
		}
		expect(keysHelpRow()).toContain("? this sheet");
	});

	it("the table names the REAL bindings — every gesture the editor implements is in it", () => {
		// the editor's gesture set, transcribed from editor.ts's feed():
		// enter submits, ctrl+j/shift+⏎ insert a newline, esc stops,
		// alt+⏎/ctrl+⏎ redirect, @ picks files, / opens the menu, ↑↓ walk
		// the history and pop the queue, ctrl+r expands, tab completes,
		// ? opens this sheet, ctrl+z/ctrl+y undo and redo (UD-1).
		expect(KEY_BINDINGS.map((b) => b.keys)).toEqual([
			"enter",
			"ctrl+j / shift+⏎",
			"@",
			"esc",
			"alt+⏎ / ctrl+⏎",
			"/",
			"↑↓",
			"ctrl+r",
			"ctrl+o", // R5: the transcript viewer
			"tab",
			"?",
			"ctrl+z / ctrl+y",
		]);
	});
});
