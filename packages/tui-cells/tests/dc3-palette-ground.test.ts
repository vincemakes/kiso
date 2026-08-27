/**
 * DC-3 — no token may be an absolute colour chosen against a ground the
 * product has not established.
 *
 * The defect: `code` was 256-colour index 252 (#d0d0d0), picked on a
 * dark terminal, and on a white one it measures 1.54:1 against a 4.5:1
 * floor. Five call sites shared it — inline code, whole fenced blocks,
 * the ctrl+r affordance, the approval hint and the keys sheet's key
 * names — so on a light terminal the code the model wrote and the key
 * that would reveal the rest of a cell were equally unreadable.
 *
 * The rule this pins is stronger than "fix that grey": an absolute
 * FOREGROUND colour is a claim about the background, so a palette that
 * does not know its ground may not contain one. `dim` is exempt on
 * purpose — SGR 2 is an attribute, it dims whatever the terminal's own
 * foreground is, and therefore adapts instead of asserting.
 */

import { afterEach, describe, expect, it } from "vitest";
import { COLOR_DARK, COLOR_LIGHT, COLOR_NEUTRAL, COLOR_OFF, palette, setGround, type Palette } from "../src/render.js";
import { relativeLuminance } from "../src/ground.js";

afterEach(() => setGround("unknown"));

const GROUND = { light: { r: 255, g: 255, b: 255 }, dark: { r: 30, g: 30, b: 30 } };
const grey = (n: number): { r: number; g: number; b: number } => {
	const v = n >= 232 ? 8 + (n - 232) * 10 : 0;
	return { r: v, g: v, b: v };
};
const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
	const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** every `38;5;N` in a palette — the absolute FOREGROUND colours. */
const fgIndexes = (p: Palette): number[] =>
	Object.values(p)
		.flatMap((v) => [...String(v).matchAll(/\x1b\[38;5;(\d+)m/g)])
		.map((m) => Number(m[1]));

describe("DC-3 — absolute foregrounds clear the floor against their own ground", () => {
	it("light", () => {
		for (const n of fgIndexes(COLOR_LIGHT)) {
			expect(contrast(grey(n), GROUND.light), `index ${n} on white`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("dark", () => {
		for (const n of fgIndexes(COLOR_DARK)) {
			expect(contrast(grey(n), GROUND.dark), `index ${n} on #1e1e1e`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("a palette with no ground carries no absolute foreground at all", () => {
		expect(fgIndexes(COLOR_NEUTRAL)).toEqual([]);
	});
});

describe("DC-3 — the wash is the ground-shaped token", () => {
	it("is reverse video when the ground is unknown — correct on any ground", () => {
		expect(COLOR_NEUTRAL.wash).toBe("\x1b[7m");
		expect(COLOR_NEUTRAL.washEnd).toBe("\x1b[27m");
	});

	it("is a background, closed by 49, once the ground is known", () => {
		expect(COLOR_LIGHT.wash).toBe("\x1b[48;5;255m");
		expect(COLOR_DARK.wash).toBe("\x1b[48;5;236m");
		expect(COLOR_LIGHT.washEnd).toBe("\x1b[49m");
		expect(COLOR_DARK.washEnd).toBe("\x1b[49m");
	});

	it("is nothing at all with colour off", () => {
		expect(COLOR_OFF.wash).toBe("");
		expect(COLOR_OFF.washEnd).toBe("");
	});

	it("code is the wash — it is a surface now, never a foreground tint", () => {
		for (const p of [COLOR_NEUTRAL, COLOR_LIGHT, COLOR_DARK, COLOR_OFF]) {
			expect(p.code).toBe(p.wash);
		}
	});
});

describe("DC-3 — dim stays an attribute", () => {
	it("every ground dims by SGR 2, which adapts instead of asserting", () => {
		for (const p of [COLOR_NEUTRAL, COLOR_LIGHT, COLOR_DARK]) expect(p.dim).toBe("\x1b[2m");
	});
});

describe("setGround selects the palette", () => {
	it("routes to the ground's own table, and back to neutral", () => {
		const tty = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			setGround("light");
			expect(palette()).toBe(COLOR_LIGHT);
			setGround("dark");
			expect(palette()).toBe(COLOR_DARK);
			setGround("unknown");
			expect(palette()).toBe(COLOR_NEUTRAL);
		} finally {
			Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
		}
	});
});
