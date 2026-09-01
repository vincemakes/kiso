/**
 * R8b — THE SHIPPED KEY IS ON A SURFACE YOU CAN SEE, AND THE SHEET
 * NAMES ITSELF.
 *
 * Two small gaps found by driving the installed binary and reading its
 * chrome next to another agent's, rather than by reading the source.
 *
 *  - `ctrl+o` shipped as 0.19.0's headline and was reachable only from
 *    the `?` sheet: not on the banner's key line, not on the idle
 *    status. A feature whose only advertisement is a screen you must
 *    already know to open is DC-30's lesson pointing the other way.
 *    It could not simply be appended, because the hint is dropped
 *    WHOLE when it does not fit and a longer string would have taken
 *    `/ commands` down with it on a narrow terminal — hence a ladder.
 *
 *  - the `?` sheet opened with a bare bold word at column 0 while
 *    every other overlay names itself in the band vocabulary. That is
 *    the exact condition TUI2-R1.5 ⑦(b) named when it made the rule:
 *    with scrollback behind an overlay, nothing said where the
 *    surface began.
 */

import { describe, expect, it } from "vitest";
import { idleHint, statusLine } from "../src/components.js";
import { keysSheetRows } from "../src/strings.js";
import { visibleWidth } from "../src/width.js";

const STATUS = "▸ default · /mode to switch · faux · ctx left ~100%";
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("R8b — ctrl+o is on the permanent surface", () => {
	it("the idle row advertises the transcript when there is room", () => {
		expect(plain(statusLine(STATUS, "", 110))).toContain("ctrl+o transcript");
	});

	it("the ladder only ever gets SHORTER as the room does — no width loses something that fits", () => {
		// The real invariant. An earlier draft asserted a strict ranking
		// of the three affordances and was wrong: keeping the old
		// `/ commands · ↑ history` rung is what stops a 24-30 column room
		// falling all the way to `/ commands` when the old form fitted.
		const widths = [];
		for (let room = 60; room >= 0; room -= 1) widths.push(visibleWidth(idleHint(room)));
		for (let i = 1; i < widths.length; i += 1) {
			expect(widths[i]!, `the hint GREW as the room shrank, at ${60 - i} columns`).toBeLessThanOrEqual(widths[i - 1]!);
		}
		// and a hint never claims more room than it was given
		for (let room = 0; room <= 60; room += 1) expect(visibleWidth(idleHint(room)), `room=${room}`).toBeLessThanOrEqual(room);
	});

	it("there is a real width band where ctrl+o is advertised", () => {
		const rooms = [];
		for (let room = 0; room <= 60; room += 1) if (idleHint(room).includes("ctrl+o")) rooms.push(room);
		expect(rooms.length, "ctrl+o never appears at any width").toBeGreaterThan(5);
	});

	it("a hint NEVER pushes the row past its width — invariant ① holds at every size", () => {
		for (let W = 20; W <= 140; W += 1) {
			expect(visibleWidth(plain(statusLine(STATUS, "", W))), `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("`/ commands` survives every width the hint appears at all", () => {
		for (let W = 20; W <= 140; W += 1) {
			const hint = idleHint(Math.max(0, W - visibleWidth(STATUS)));
			if (hint !== "") expect(hint, `W=${W}`).toContain("/ commands");
		}
	});
});

describe("R8b — the keys sheet names itself", () => {
	it("it opens with a labelled rule, like every other band", () => {
		const rows = keysSheetRows(92).map(plain);
		expect(rows[0]).toMatch(/^─── keys ─+$/);
	});

	it("the header is the full width, at every width", () => {
		for (const W of [40, 60, 92, 120]) {
			expect(visibleWidth(plain(keysSheetRows(W)[0]!)), `W=${W}`).toBe(W);
		}
	});

	it("naming it did not cost a row of content", () => {
		const rows = keysSheetRows(92).map(plain);
		expect(rows.slice(1).join("\n")).toContain("ctrl+o transcript");
	});
});
