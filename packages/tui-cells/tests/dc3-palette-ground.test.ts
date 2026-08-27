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
/**
 * DC-9: the xterm-256 index → sRGB, for BOTH halves of the space.
 *
 * This used to cover only the 232–255 grey ramp and return black for
 * everything else — safe while the greys were the only absolute
 * foregrounds, and silently wrong the moment §2.3's theme-resolved
 * failure colour (a 6×6×6 cube index) arrived: it measured 173 as
 * black-on-#1e1e1e, 1.26:1, and would have failed a colour that is
 * actually 5.97:1. A gate that computes the wrong number is worse than
 * no gate, because it is believed.
 */
const rgbOf = (n: number): { r: number; g: number; b: number } => {
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return { r: v, g: v, b: v };
	}
	if (n >= 16) {
		const LEVELS = [0, 95, 135, 175, 215, 255];
		const i = n - 16;
		return { r: LEVELS[Math.floor(i / 36)]!, g: LEVELS[Math.floor(i / 6) % 6]!, b: LEVELS[i % 6]! };
	}
	// 0–15 are the terminal's OWN palette slots: no fixed sRGB exists for
	// them, which is exactly why the product does not spend them as
	// absolute colours. Reaching here is the bug, so it is stated.
	throw new Error(`index ${n} is a terminal palette slot, not an absolute colour`);
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
			expect(contrast(rgbOf(n), GROUND.light), `index ${n} on white`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("dark", () => {
		for (const n of fgIndexes(COLOR_DARK)) {
			expect(contrast(rgbOf(n), GROUND.dark), `index ${n} on #1e1e1e`).toBeGreaterThanOrEqual(4.5);
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

/**
 * DC-9 (design §2.3) — the failure colour is theme-resolved.
 *
 * ANSI 31 is not theme-safe: 5.89:1 on white, 2.83:1 on #1e1e1e. The one
 * token whose job is "this went wrong" was least readable exactly where
 * a dark-terminal user reads it. The floor gate above already covers the
 * ratios; what this pins is that the token VARIES by ground at all, and
 * that the unknown ground keeps the terminal's own red rather than
 * guessing an absolute one (rung 4's principle, applied to a foreground).
 */
describe("DC-9 — the failure colour knows its ground", () => {
	it("is an absolute index once the ground is known, and a different one per ground", () => {
		expect(COLOR_LIGHT.red).toBe("\x1b[38;5;124m");
		expect(COLOR_DARK.red).toBe("\x1b[38;5;173m");
		expect(COLOR_LIGHT.red).not.toBe(COLOR_DARK.red);
	});

	it("stays the TERMINAL's own red when the ground is unknown", () => {
		expect(COLOR_NEUTRAL.red).toBe("\x1b[31m");
	});

	it("is nothing at all under NO_COLOR", () => {
		expect(COLOR_OFF.red).toBe("");
	});

	it("routes through palette() like every other token", () => {
		const tty = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			setGround("light");
			expect(palette().red).toBe("\x1b[38;5;124m");
			setGround("dark");
			expect(palette().red).toBe("\x1b[38;5;173m");
		} finally {
			Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
		}
	});
});
