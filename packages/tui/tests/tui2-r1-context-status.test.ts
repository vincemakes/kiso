/**
 * TUI2-R1 slice ⑥ — T-V5 (the render half): /context's attribution rows
 * and the status line's $ / CH%.
 *
 * Both are pure functions of numbers the session ALREADY has, which is
 * the round's zero-rent rule: no new request, no new event, no estimate
 * dressed up as a measurement.
 *
 * The honesty rules, each pinned below:
 *   - $ renders ONLY a canonical costUsd that exists. A route with no
 *     rate in the pricing table records null, and null renders NOTHING.
 *     kiso does not invent a price.
 *   - CH% is cacheRead / (fresh + cacheRead) — the E2 denominator, the
 *     one that cannot exceed 100%.
 *   - a context ledger with no data says so rather than drawing an empty
 *     bar that looks like a measurement of zero.
 */

import { afterEach, describe, expect, it } from "vitest";
import { contextRows, statusBar, type ContextLedger } from "../src/index.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

const LEDGER: ContextLedger = {
	window: 120_000,
	systemPrompt: 2_100,
	systemBase: 1_400,
	appends: 3,
	toolTable: 3_200,
	tools: 10,
	skillsIndex: 400,
	skills: 6,
	envelope: 60,
	messages: 25_700,
	turns: 12,
};

describe("TUI2-R1 T-V5 — the status line's $ and CH%", () => {
	// RE-DERIVED (the legacy rows retired, owner 2026-10-06): the idle row
	// these cases composed is gone. On the bar (§8.9) the cache share is the
	// seal's (owner, 2026-09-29: every run's closing row already says it)
	// and the $ stays retired (the 2026-08-23 directive) — the bar's input
	// carries neither, so neither can render.
	it("the bar carries no $ and no CH — the seal says the cache, and nothing says a price", () => {
		const row = statusBar({ mode: "default", floorOff: false, model: "deepseek-v4-flash", ctx: { used: 0.26, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null }, 120, null);
		expect(row).toBe("▸ default · /mode to switch · deepseek-v4-flash · ctx 26%");
		expect(row).not.toContain("$");
		expect(row).not.toContain("CH");
	});
});

describe("TUI2-R1 T-V5 — /context's attribution", () => {
	it("the prototype's frame: the header, the bar, one row per surface, the free remainder", () => {
		setTTY(false);
		expect(contextRows(LEDGER)).toEqual([
			"context — 31.5k / 120k tokens (26%)",
			"▰▰▰▱▱▱▱▱▱▱▱▱",
			"  ▰ system prompt  2.1k  (base 1.4k + 3 extension appends)",
			"  ▰ tool table     3.2k  10 tools",
			// MOVED (R1.5 slice ⑤, the number-format class — DECLARED THIS
			// ROUND): this row changes unit. k()'s floor was 100, so this
			// very frame stacked "0.4k" and "60" in one right-aligned column
			// (VD-15). The floor is now 1000, matching render.ts's kUnit —
			// the formatter the status row and every settled card already
			// used — so the product reads plain integers below 1000, k above.
			"  ▰ skills index    400  6 skills, tier-1 lines only",
			"  ▰ envelope         60",
			"  ▰ messages      25.7k  12 turns",
			"  ▱ free          88.5k",
		]);
	});

	it("the parts SUM to the header's total — the ledger is an attribution, not a sample", () => {
		const rows = contextRows(LEDGER);
		const sum = LEDGER.systemPrompt + LEDGER.toolTable + LEDGER.skillsIndex + LEDGER.envelope + LEDGER.messages;
		expect(rows[0]).toContain(`${(sum / 1000).toFixed(1)}k / 120k`);
		expect(rows[rows.length - 1]).toContain(`${((LEDGER.window - sum) / 1000).toFixed(1)}k`);
	});

	it("an absent surface is an absent ROW — the rent ledger's own rule (R9)", () => {
		setTTY(false);
		const rows = contextRows({ ...LEDGER, skillsIndex: 0, skills: 0 });
		expect(rows.join("\n")).not.toContain("skills index");
		expect(rows.join("\n")).toContain("tool table");
	});

	it("a window smaller than the usage never draws a negative bar or a negative free", () => {
		setTTY(false);
		const rows = contextRows({ ...LEDGER, window: 1_000 });
		expect(rows[1]).toBe("▰▰▰▰▰▰▰▰▰▰▰▰");
		expect(rows[rows.length - 1]).toContain("free");
		expect(rows[rows.length - 1]).toBe("  ▱ free              0"); // clamped, never negative
	});
});
