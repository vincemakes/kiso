/**
 * The person's block (design.md §7.9) — its surface, and its fold.
 *
 * Graphite (owner-ruled 2026-09-28, settled 2026-09-29 after the owner's
 * seam test in Apple Terminal): on a known ground the warm `human` ground
 * across the full width with a whole ROW of it above and below (the
 * half-row glyphs R1b drew left a seam; a row of background does not —
 * §1.5), an EDGE cell of quieted gold in column 0 down every row — a
 * background, the same width as a card's edge (a `▌` glyph showed a break
 * between rows in Apple Terminal) — and the text at the content edge,
 * column 2. On an unknown ground nothing assumes a
 * background (§3.1): the `▌` in column 0 — a character, so a stripped
 * frame still marks the person's words (§1.2) — and reverse video from
 * column 1, no pads.
 *
 * DECLARED REVERSAL of the 2026-09-02 ruling this file used to assert
 * ("reverse video on every ground, one form, no ladder"): reverse video
 * remains only as the unknown ground's fallback.
 *
 * Q3 is unchanged and still asserted below: the block folds by WORD.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell } from "../src/components.js";
import { palette, setGround } from "../src/render.js";
import { displayWidth } from "../src/width.js";

// the block IS a surface, so the palette has to be on: a non-TTY vitest
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
const isNotice = (row: string): boolean => plain(row).includes("\u2514");

describe("§7.9 — the person's block", () => {
	for (const g of ["light", "dark"] as const) {
		it(`${g}: a row of warm ground above and below, the gold edge cell down every row, the text at column 2`, () => {
			setGround(g);
			const p = palette();
			const rows = chip("look around");
			expect(rows).toHaveLength(3);
			for (const row of rows) expect(row.startsWith(`${p.humanEdge} ${p.human}`), "the edge is a BACKGROUND cell on every row").toBe(true);
			for (const pad of [rows[0]!, rows[2]!]) expect(plain(pad)).toBe(" ".repeat(56));
			expect(plain(rows[1]!)).toMatch(/^ {2}look around {2,}$/);
			expect(rows.map(plain).join(""), "a block glyph drew the surface (§1.5)").not.toMatch(/[\u2584\u2580\u258c]/);
			expect(rows.join(""), "no reverse video on a known ground").not.toContain("\x1b[7m");
		});
	}

	it("unknown ground: the bar in column 0, reverse video from column 1, the text at column 2 — nothing that assumes a colour", () => {
		setGround("unknown");
		const rows = chip("look around");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.startsWith("\u258c\x1b[7m look around")).toBe(true);
		expect(rows[0]!.endsWith(" \x1b[27m")).toBe(true);
	});

	it("never takes a card's ground on ANY ground — that surface is the machine's (§1.6)", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			expect(chip("look around\nand again").join(""), `ground=${g}`).not.toContain(palette().wash);
		}
	});

	it("spans the full width on every ground — padded by DISPLAY width", () => {
		for (const g of ["unknown", "light", "dark"] as const) {
			setGround(g);
			for (const text of ["hi", "\u4fee\u590d\u91cd\u7ed8\u95ee\u9898", "one\ntwo three four"]) {
				for (const row of chip(text, 56)) expect(displayWidth(plain(row)), `${g} / ${JSON.stringify(text)}`).toBe(56);
			}
		}
	});

	it("the truncation notice stays OUTSIDE the surface — it is kiso's word, not the person's", () => {
		setGround("light");
		const rows = chip(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		const notice = rows.at(-1)!;
		expect(plain(notice)).toContain("sent in full");
		expect(notice).not.toContain(palette().human);
		expect(notice).not.toContain("\x1b[7m");
	});
});

describe("R9 Q3 — the chip folds by WORD", () => {
	it("breaks at a space, so no word is split across two rows", () => {
		setGround("unknown");
		const rows = chip("alpha bravo charlie delta echo foxtrot golf", 20);
		expect(rows.length).toBeGreaterThan(1);
		const words = rows.flatMap((r) => plain(r).trim().split(/\s+/)).filter((w) => w !== "" && w !== "\u258c");
		expect(words).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"]);
	});

	it("a word longer than the width still hard-breaks — invariant ① outranks the word", () => {
		setGround("unknown");
		const rows = chip("x".repeat(200), 20);
		expect(rows.length).toBeGreaterThan(1);
		// the BAND's rows are exactly the width; the cut notice below it is
		// outside the reverse video by design and only has to fit (DC-45).
		for (const row of rows) expect(displayWidth(plain(row)), JSON.stringify(plain(row))).toBeLessThanOrEqual(20);
		for (const row of rows.filter((r) => !isNotice(r))) expect(displayWidth(plain(row))).toBe(20);
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
			const notice = rows.map(plain).find((r) => r.includes("\u2514"));
			expect(notice, `W=${W}: no cut notice at all`).toBeDefined();
			expect(displayWidth(notice!), `W=${W}: ${JSON.stringify(notice)}`).toBeLessThanOrEqual(W);
		}
	});

	it("DC-45: …and it keeps the words that matter for as long as it can", () => {
		setGround("unknown");
		const many = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		expect(plain(chip(many, 40).map(plain).find((r) => r.includes("\u2514"))!)).toBe("  \u2514 +3 more lines \u00b7 sent in full"); // under the person's text, column 2
		// where the count no longer fits, the CLAIM is what survives
		expect(chip(many, 20).map(plain).find((r) => r.includes("\u2514"))!).toContain("sent in full");
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
