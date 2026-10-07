/**
 * R3 — design.md §5, built and gated.
 *
 * §5 was written into the contract in the 0.16.3 round and never
 * implemented: the product shipped the four quadrant blocks it was
 * meant to replace, for both marks, for two releases. The owner found
 * it by looking at the screen. These are the gates that make that
 * impossible to repeat — the two cycles are asserted by VALUE, so a
 * future round cannot quietly leave them unbuilt.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MOTION_FRAMES, TWINKLE, breathFrame, twinkleFrame, setGround } from "../src/render.js";
import { contrast, graphiteColours, rgbHex } from "../src/graphite.js";
import { charWidth } from "../src/width.js";

afterEach(() => setGround("unknown"));

const tty = (on: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
};
/** The colour a frame's `●` is written in (the suite runs in the 24-bit
 *  tier, tests/setup-env.ts). */
const rgbOf = (frame: string): { r: number; g: number; b: number } => {
	const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(frame);
	if (m === null) throw new Error(`no 24-bit colour in ${JSON.stringify(frame)}`);
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
};

describe("R3 §5.2 — the thinking TWINKLE", () => {
	it("is the contract's seven glyphs, in the contract's order", () => {
		expect([...TWINKLE]).toEqual(["✧", "✦", "✶", "✸", "✺", "✸", "✦"]);
	});

	it("settles on ✦ — §4.1: the mark that runs is the mark that stays", () => {
		expect(TWINKLE[TWINKLE.length - 1]).toBe("✦");
	});

	it("is GLYPHS ONLY — no colour, so it is intact under NO_COLOR and on any ground", () => {
		for (let i = 0; i < 20; i += 1) expect(twinkleFrame(i)).not.toContain("\x1b");
	});

	it("every glyph is ONE cell — §6.1's tear is what a two-cell mark in a one-cell slot causes", () => {
		for (const g of TWINKLE) expect(charWidth(g.codePointAt(0)!)).toBe(1);
	});

	it("walks and wraps", () => {
		expect(twinkleFrame(0)).toBe("✧");
		expect(twinkleFrame(MOTION_FRAMES)).toBe("✧");
		expect(twinkleFrame(MOTION_FRAMES + 1)).toBe("✦");
	});
});

describe("R3 §5.2 — the command BREATH", () => {
	it("is brightness only: ONE glyph, never a rotation (§5.3)", () => {
		tty(true);
		setGround("light");
		const glyphs = new Set(Array.from({ length: MOTION_FRAMES }, (_, i) => breathFrame(i).replace(/\x1b\[[0-9;]*m/g, "")));
		expect([...glyphs]).toEqual(["●"]);
	});

	// Graphite (design.md §5.2, §2.2): seven steps from gold toward the
	// running card's ground, peak → floor → peak, and never under the
	// graphic floor (3:1) on that ground — the mark dims, it never goes.
	for (const kind of ["light", "dark"] as const) {
		it(`${kind}: peaks at gold, dims toward the card, and never drops under 3:1 on it — §2.2 holds mid-animation`, () => {
			tty(true);
			setGround(kind);
			const c = graphiteColours(kind, null);
			const steps = Array.from({ length: MOTION_FRAMES }, (_, i) => rgbOf(breathFrame(i)));
			expect(rgbHex(steps[0]!), "the peak is gold").toBe(rgbHex(c.gold));
			expect(steps.map(rgbHex), "symmetric: out and back").toEqual([...steps].reverse().map(rgbHex));
			const ratios = steps.map((s) => contrast(s, c.washRun));
			expect(Math.min(...ratios)).toBeGreaterThanOrEqual(3);
			expect(ratios[3]!, "the middle step is the floor, and it is dimmer than the peak").toBeLessThan(ratios[0]!);
		});
	}

	it("FREEZES to a static ● with no ground — §3.1 forbids guessing a background", () => {
		tty(true);
		setGround("unknown");
		for (let i = 0; i < MOTION_FRAMES; i += 1) expect(breathFrame(i)).toBe("●");
	});

	it("freezes under NO_COLOR too — the glyph never changes, so the meaning survives", () => {
		tty(false);
		setGround("light");
		for (let i = 0; i < MOTION_FRAMES; i += 1) expect(breathFrame(i)).toBe("●");
		tty(true);
	});

	it("● is one cell", () => {
		expect(charWidth("●".codePointAt(0)!)).toBe(1);
	});
});

describe("R3 §5.1 — one cadence, one counter", () => {
	it("both cycles are seven frames, so a screen showing both stays in step", () => {
		expect(MOTION_FRAMES).toBe(7);
		expect(TWINKLE).toHaveLength(MOTION_FRAMES);
	});
});
