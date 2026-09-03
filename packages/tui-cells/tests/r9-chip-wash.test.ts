/**
 * The user chip's SURFACE, and its fold.
 *
 * R9 P1 (0.21.0) moved the chip onto the wash, reading §1.6's
 * "verbatim" as one surface shared by the human's words and the
 * machine's. The owner reversed it one release later and split §1.6
 * instead: reverse video is THE HUMAN'S surface, the wash is the
 * MACHINE'S verbatim one (inline code, tool output).
 *
 * The argument for the reversal is contrast, and it is structural
 * rather than a matter of taste. Reverse video INVERTS whatever the
 * terminal is, so the human's own words carry the same weight on a
 * light terminal, a dark one, and one whose ground was never
 * established — one form, no ladder, nothing to under-read. The wash
 * cannot promise that: it is a chosen background on the two known
 * grounds and degrades to reverse video where none is known (§3's last
 * rung), so a
 * chip on the wash was really two different weights wearing one name.
 *
 * These are the cases R9 P1 shipped, re-derived against the contract
 * that replaced it. The file keeps its name because its subject is
 * "which surface does the chip take" — that is the question, and the
 * answer is what moved.
 *
 * Q3 is untouched by the reversal and is still asserted below: the chip
 * folds by WORD. The character fold was defended as lossless, which is
 * not a property CJK has, and every other prose surface already folds
 * by word (ErrorLine, VD-10).
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

describe("the chip is REVERSE VIDEO, and the same on every ground", () => {
	it("unknown ground: SGR 7, closed with SGR 27", () => {
		setGround("unknown");
		const rows = chip("look around");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.startsWith("\x1b[7m ")).toBe(true);
		expect(rows[0]!.endsWith(" \x1b[27m")).toBe(true);
	});

	it("light and dark grounds: the SAME bytes — the chip has no ladder", () => {
		setGround("unknown");
		const neutral = chip("look around");
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			expect(chip("look around"), `ground=${g}`).toEqual(neutral);
		}
	});

	it("never takes the wash on ANY ground — that surface is the machine's now (§1.6)", () => {
		for (const g of ["unknown", "light", "dark"] as const) {
			setGround(g);
			const joined = chip("look around\nand again").join("");
			expect(joined, `ground=${g}`).not.toContain("\x1b[48;5;255m");
			expect(joined, `ground=${g}`).not.toContain("\x1b[48;5;236m");
			expect(joined, `ground=${g}`).not.toContain("\x1b[49m");
		}
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
		expect(notice).not.toContain("\x1b[7m");
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
		// the BAND's rows are exactly the width; the cut notice below it is
		// outside the reverse video by design and only has to fit (DC-45).
		for (const row of rows) expect(displayWidth(plain(row)), JSON.stringify(plain(row))).toBeLessThanOrEqual(20);
		for (const row of rows.filter((r) => !plain(r).startsWith("\u2514"))) expect(displayWidth(plain(row))).toBe(20);
	});

	/**
	 * DC-45 — the cut notice was the one row of the chip nobody folded.
	 *
	 * `└ +3 more lines · sent in full` is written at a fixed 30 columns and
	 * was emitted verbatim at every width. A paste of thirteen lines is
	 * what reaches it (USER_CHIP_ROWS is 12), and in a terminal narrower
	 * than the sentence the compositor's invariant ① does exactly what it
	 * promises — it THROWS. So kiso died on a wide paste in a narrow
	 * terminal, and had since the notice was written.
	 *
	 * Found during R13 (the chip's inner pad went from one column to two,
	 * which moved a neighbouring case across the truncation boundary and
	 * put this row on screen). It is not R13's defect: the row folds no
	 * better at HEAD.
	 *
	 * The tiers follow TUI2-R1.5 ⑤'s discipline — the SEMANTICS is
	 * reserved. "sent in full" is the whole point of the row (a bounded
	 * display of a complete message is not a truncated message); the count
	 * gives way before it, and `cutLine` is the backstop that makes the
	 * invariant hold at every width there is.
	 */
	it("DC-45: the cut notice FITS at every width — it used to be 30 columns wide, always", () => {
		setGround("unknown");
		const many = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		for (let W = 4; W <= 40; W += 1) {
			const rows = chip(many, W);
			const notice = rows.map(plain).find((r) => r.startsWith("\u2514"));
			expect(notice, `W=${W}: no cut notice at all`).toBeDefined();
			expect(displayWidth(notice!), `W=${W}: ${JSON.stringify(notice)}`).toBeLessThanOrEqual(W);
		}
	});

	it("DC-45: …and it keeps the words that matter for as long as it can", () => {
		setGround("unknown");
		const many = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		expect(plain(chip(many, 40).map(plain).find((r) => r.startsWith("\u2514"))!)).toBe("\u2514 +3 more lines \u00b7 sent in full");
		// where the count no longer fits, the CLAIM is what survives
		expect(chip(many, 20).map(plain).find((r) => r.startsWith("\u2514"))!).toContain("sent in full");
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
