/**
 * DC-6 — the user chip is ONE block, so it has ONE width.
 *
 * The chip is reverse video. A block whose rows are padded to different
 * widths draws as bars of different lengths with a ragged right edge —
 * which is what a multi-line message does today, because the pad width
 * is computed per source paragraph instead of over the whole block.
 *
 * The cap and the CJK padding authority ride along: a capped chip is
 * still one width, and a CJK row pads by DISPLAY width (2 cells per
 * character) rather than by character count.
 */

import { describe, expect, it } from "vitest";
import { cellComponent, type BodyCell } from "../src/components.js";
import { displayWidth } from "../src/width.js";

const CTX = { spinnerI: 0, now: 0, height: 24 };
const chip = (text: string, W = 56): string[] =>
	cellComponent({ kind: "user", text, done: true, turn: 0 } as BodyCell).render(W, CTX);
const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");

describe("DC-6 — one chip, one width", () => {
	it("pads a three-paragraph message to a single width", () => {
		const rows = chip("hello\nthis is a much longer second line here\nok");
		expect(rows).toHaveLength(3);
		const widths = rows.map((r) => displayWidth(plain(r)));
		expect(new Set(widths).size).toBe(1);
	});

	// DECLARED SUPERSESSION (R2, law 1.6's recorded reversal): the single
	// width USED to be the longest row's. It is now the TERMINAL's. The
	// argument for sizing to content was that a one-word turn would paint
	// a bar across the screen; the argument against is every real
	// message, which is a paragraph and reads as a block only when the
	// block has an edge. DC-6's actual invariant — ONE width, whatever it
	// is — is unchanged and still asserted above.
	it("the single width is the TERMINAL's", () => {
		const rows = chip("hello\nthis is a much longer second line here\nok");
		expect(displayWidth(plain(rows[1]!))).toBe(56);
		expect(displayWidth(plain(rows[0]!))).toBe(56);
	});

	it("a one-paragraph message spans the width too — the `/think` case, accepted", () => {
		const rows = chip("fix the resize repaint");
		expect(rows).toHaveLength(1);
		expect(displayWidth(plain(rows[0]!))).toBe(56);
	});

	it("pads a CJK row by display width, not by character count", () => {
		const rows = chip("short\n\u4fee\u590d\u91cd\u7ed8\u95ee\u9898");
		const widths = rows.map((r) => displayWidth(plain(r)));
		expect(new Set(widths).size).toBe(1);
		// the CJK row pads to the SAME full width as the ascii one, which
		// is only true if the pad counts cells rather than characters
		expect(widths[0]).toBe(56);
	});

	it("a chip wide enough to fold keeps one width across the folded rows", () => {
		const rows = chip("aaaa bbbb cccc dddd eeee ffff gggg hhhh", 20);
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map((r) => displayWidth(plain(r)))).size).toBe(1);
	});
});
