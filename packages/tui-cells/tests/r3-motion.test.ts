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
import { relativeLuminance } from "../src/ground.js";
import { charWidth } from "../src/width.js";

afterEach(() => setGround("unknown"));

const tty = (on: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
};
const grey = (n: number): { r: number; g: number; b: number } => {
	const v = n >= 232 ? 8 + (n - 232) * 10 : 0;
	return { r: v, g: v, b: v };
};
const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
	const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const GROUND = { light: { r: 255, g: 255, b: 255 }, dark: { r: 30, g: 30, b: 30 } };
const indexOf = (frame: string): number | null => {
	const m = /\x1b\[38;5;(\d+)m/.exec(frame);
	return m === null ? null : Number(m[1]);
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

	it("bottoms out EXACTLY on the ground's dim token — §2.2 holds mid-animation", () => {
		tty(true);
		setGround("light");
		const light = Array.from({ length: MOTION_FRAMES }, (_, i) => indexOf(breathFrame(i))!);
		expect(light).toEqual([232, 236, 240, 243, 240, 236, 232]);
		expect(Math.min(...light.map((n) => contrast(grey(n), GROUND.light)))).toBeGreaterThanOrEqual(4.5);

		setGround("dark");
		const dark = Array.from({ length: MOTION_FRAMES }, (_, i) => indexOf(breathFrame(i))!);
		expect(dark).toEqual([255, 251, 248, 246, 248, 251, 255]);
		expect(Math.min(...dark.map((n) => contrast(grey(n), GROUND.dark)))).toBeGreaterThanOrEqual(4.5);
	});

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
