/**
 * R9 P1 + Q3 — the human's words take the WASH, and fold by WORD.
 *
 * P1 is a bug fix against design.md §7.9, not a new rule. §1.6 has always
 * said the wash means verbatim — "the human's own words, and inline
 * code" — and §7.9 has always said the chip is "full width, washed".
 * Inline code took the wash at DC-3; the chip never did. It still drew
 * with SGR 7 on EVERY ground, which on a light terminal is a full-width
 * black band with white text, on a dark one a white band, and either way
 * the heaviest thing on a screen that has one per turn. Per §11 a rule
 * the code contradicts is a bug in one of them: here the design is right
 * and the code is the stale side.
 *
 * The reason this is safe to change is the LADDER (§3, ground.ts): with
 * no ground established `wash` IS reverse video — rung 4, correct on any
 * ground — so the unknown-ground chip is byte-identical to what shipped.
 * That identity is asserted below rather than assumed, because it is the
 * whole argument for why every existing reverse-video pin still holds.
 *
 * Q3 is the second half of the same component (R12 §1). The chip folded
 * by CHARACTER, defended as lossless. That defence does not survive CJK,
 * which has no spaces to lose, and every other prose surface in the
 * product already folds by word — ErrorLine took `foldWords` at VD-10.
 * A word longer than the width still hard-breaks, because an overflowing
 * row breaks invariant ① and a word that cannot fit has to break
 * somewhere.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell } from "../src/components.js";
import { setGround } from "../src/render.js";
import { displayWidth } from "../src/width.js";

// the chip IS a surface, so the palette has to be on: a non-TTY vitest
// run degrades to COLOR_OFF and every byte assertion here would pass
// vacuously (the r3v2 bar gate's precedent).
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX = { spinnerI: 0, now: 0, height: 24 };
const chip = (text: string, W = 56): string[] =>
	cellComponent({ kind: "user", text, done: true, turn: 0 } as BodyCell).render(W, CTX);
const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");

describe("R9 P1 — the chip is washed, and the ladder still degrades", () => {
	it("with NO ground it is byte-identical to the reverse-video chip that shipped", () => {
		setGround("unknown");
		const rows = chip("look around");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.startsWith("\x1b[7m ")).toBe(true);
		expect(rows[0]!.endsWith(" \x1b[27m")).toBe(true);
	});

	it("on a LIGHT ground it is the wash — a background, closed by 49, never SGR 7", () => {
		setGround("light");
		const rows = chip("look around");
		expect(rows[0]!.startsWith("\x1b[48;5;255m ")).toBe(true);
		expect(rows[0]!.endsWith(" \x1b[49m")).toBe(true);
		expect(rows[0]).not.toContain("\x1b[7m");
	});

	it("on a DARK ground it is the wash too", () => {
		setGround("dark");
		const rows = chip("look around");
		expect(rows[0]!.startsWith("\x1b[48;5;236m ")).toBe(true);
		expect(rows[0]!.endsWith(" \x1b[49m")).toBe(true);
		expect(rows[0]).not.toContain("\x1b[7m");
	});

	it("spans the full width on every ground — §7.9 pads by DISPLAY width", () => {
		for (const g of ["unknown", "light", "dark"] as const) {
			setGround(g);
			for (const text of ["hi", "\u4fee\u590d\u91cd\u7ed8\u95ee\u9898", "one\ntwo three four"]) {
				for (const row of chip(text, 56)) {
					expect(displayWidth(plain(row)), `${g} / ${JSON.stringify(text)}`).toBe(56);
				}
			}
		}
	});

	it("the truncation notice stays OUTSIDE the surface — it is kiso's word, not the human's", () => {
		setGround("light");
		const rows = chip(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		const notice = rows.at(-1)!;
		expect(plain(notice)).toContain("sent in full");
		expect(notice).not.toContain("\x1b[48;5;255m");
	});
});

describe("R9 Q3 — the chip folds by WORD", () => {
	it("breaks at a space, so no word is split across two rows", () => {
		setGround("unknown");
		const rows = chip("alpha bravo charlie delta echo foxtrot golf", 20);
		expect(rows.length).toBeGreaterThan(1);
		const words = rows.flatMap((r) => plain(r).trim().split(/\s+/)).filter((w) => w !== "");
		expect(words).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"]);
	});

	it("a word longer than the width still hard-breaks — invariant ① outranks the word", () => {
		setGround("unknown");
		const rows = chip("x".repeat(200), 20);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(displayWidth(plain(row))).toBe(20);
	});

	it("a space-free CJK run folds and never overruns — the case the char fold was defended with", () => {
		setGround("unknown");
		const rows = chip("\u4fee\u590d\u91cd\u7ed8\u95ee\u9898".repeat(8), 24);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(displayWidth(plain(row))).toBe(24);
	});

	it("keeps ONE width across the folded rows (DC-6's invariant, unchanged)", () => {
		setGround("unknown");
		const rows = chip("aaaa bbbb cccc dddd eeee ffff gggg hhhh", 20);
		expect(new Set(rows.map((r) => displayWidth(plain(r)))).size).toBe(1);
	});
});
