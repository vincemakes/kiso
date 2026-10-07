import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { statusBar, type BarInput } from "../src/status.js";
import { setGround } from "../src/lines.js";

/**
 * A PERCENTAGE NEEDS A DENOMINATOR.
 *
 * `ctx left ~82%` was printed against a hardcoded 200,000 whenever the
 * model's real window was unknown — which is every DeepSeek session, since
 * the vendor publishes no window, its /models endpoint returns ids only,
 * and the registry records null on purpose. A reader had no way to tell
 * that percentage from one computed against a real window.
 *
 * The row's own rule, written on the token-rate beside it, is that a number
 * here is a measurement or it is absent. This applies it to the context
 * estimate: a known window gives a percentage, an unknown one gives `ctx ?`.
 *
 * RE-DERIVED (the legacy rows retired, owner 2026-10-06): the estimate is
 * the bar's (§8.9) — the live row carries none — and on a painted ground
 * an unknown window draws no meter at all, only the `?`.
 */
const BAR: BarInput = { mode: "bypass", floorOff: false, model: "m", ctx: { used: 0.18, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

describe("the context segment says `?` rather than a percentage of a guess", () => {
	it("a known window prints the percentage", () => {
		expect(plain(statusBar(BAR, 120, null))).toContain("ctx 18%");
	});

	it("an unknown window prints `ctx ?` on both grounds — never a percentage, never `null`, never a meter", () => {
		for (const g of ["unknown", "dark"] as const) {
			setGround(g);
			const row = plain(statusBar({ ...BAR, ctx: null }, 120, null));
			expect(row, g).toContain("ctx ?");
			expect(row, g).not.toContain("null");
			expect(row, g).not.toMatch(/ctx[^·]*\d+%/);
			expect(row, g).not.toContain("▆");
		}
	});

	it("the rest of the row is untouched when the window is unknown", () => {
		// The context estimate going quiet must not take the model name, the
		// tier or the token rate with it.
		const row = plain(statusBar({ ...BAR, model: "deepseek-flash", ctx: null, tokPerSec: 183 }, 120, null));
		expect(row).toContain("bypass");
		expect(row).toContain("deepseek-flash");
		expect(row).toContain("183 tok/s");
	});
});
