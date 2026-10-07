/**
 * DF-0330-F1 — the idle row has a width BUDGET, and a drop order for it.
 *
 * Found in the 0.33.0 pre-publish dogfood: at 100 columns the ` · N tok/s`
 * segment never appeared, at 140 it did. The value was computed, delivered and
 * formatted correctly; the row was simply 102 columns wide and invariant ①
 * cut the end off it. The row had no budget before TPS-1 either — 90 of 100,
 * with a model id eating 35 of them.
 *
 * THE FIXTURE LESSON, pinned here because it is why every gate passed: the
 * PTY suite's model id is `deepseek-v4-flash`, seventeen characters. The
 * owner's is `deepseek-v4.1-flash-expires-on-0910`, thirty-five. A fixture
 * comfortably shorter than reality tests a world with more room in it than
 * the one the product ships into. Every case below uses the REAL id.
 *
 * The drop order, ruled: elide the model id in its middle to twenty visible
 * characters (head and tail kept — the tail is where `-flash` and `-0910`
 * distinguish); if still over, drop `/mode to switch`, which is a teaching
 * hint and not a fact. The FACTS — the tier, CH, ctx left, tok/s — are never
 * dropped and never cut. The unit stays `tok/s`: readable beats two columns.
 * Invariant ①'s `…` cut is the last resort and must be UNREACHABLE at 100
 * columns for any id up to forty characters.
 *
 * RE-DERIVED (the legacy rows retired, owner 2026-10-06): the idle row is
 * the bar now (`statusBar`, §8.9) and the running row the live row
 * (`workingRow`, §8.7). The bar's own drop order (§8.5: the ctrl+o hint,
 * the folder, the branch, the model's middle, last `/mode to switch`) is
 * pinned in graphite-composer with a 23-character id; the lesson above is
 * why it is pinned here again with the REAL one.
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "@vincemakes/kiso-tui-cells/width";
import { statusBar, workingRow, type BarInput } from "../src/status.js";

/** The owner's own, and the reason this finding exists. */
const REAL = "deepseek-v4.1-flash-expires-on-0910"; // 35
const BAR: BarInput = { mode: "default", floorOff: false, model: REAL, ctx: { used: 0.01, soft: 0.5, hard: 0.8 }, tokPerSec: 178, branch: "main", folder: "~/code/kiso" };
const FACTS = ["default", "ctx 1%", "178 tok/s"];

describe("DF-0330-F1 — the bar at the widths people use, with the real id", () => {
	it("at 140 columns nothing gives way", () => {
		const wide = statusBar(BAR, 140, null);
		for (const s of [REAL, "/mode to switch", ...FACTS, "main", "~/code/kiso"]) expect(wide).toContain(s);
	});

	it("at 100 columns it FITS, the rate survives, and the hint is still there", () => {
		const row = statusBar(BAR, 100, null);
		expect(displayWidth(row)).toBeLessThanOrEqual(100);
		for (const s of [REAL, "/mode to switch", ...FACTS]) expect(row).toContain(s);
	});

	it("at 80 the model's middle goes — HEAD and TAIL kept, the tail is what distinguishes — and every fact stays", () => {
		const row = statusBar(BAR, 80, null);
		expect(displayWidth(row)).toBeLessThanOrEqual(80);
		expect(row).toMatch(/deepseek-v…[^ ]*-0910/);
		for (const s of FACTS) expect(row).toContain(s);
	});

	it("the `…` CUT is unreachable at 100 columns for every id up to forty characters", () => {
		for (let L = 1; L <= 40; L += 1) {
			const id = `${"m".repeat(Math.max(0, L - 4))}0910`.slice(-L);
			const row = statusBar({ ...BAR, model: id }, 100, null);
			expect(displayWidth(row), `L=${L}: ${row}`).toBeLessThanOrEqual(100);
			for (const s of FACTS) expect(row, `L=${L}`).toContain(s);
			expect(row, `L=${L}`).toContain(id);
		}
	});

	it("the budget is in DISPLAY COLUMNS, so a wide-character id cannot slip back over it", () => {
		// No model id looks like this today. The guarantee should not depend on
		// that staying true: a first version of the elision sliced code points
		// and produced 28 columns while claiming 20.
		const wide = "モデル-フラッシュ-expires-on-0910"; // 33 display columns, 25 code points
		for (const W of [100, 80]) {
			const row = statusBar({ ...BAR, model: wide }, W, null);
			expect(displayWidth(row), `W=${W}: ${row}`).toBeLessThanOrEqual(W);
			expect(row).toContain("178 tok/s");
		}
	});
});

describe("DF-0330-F1 — the live row", () => {
	it("with a rate it still fits 100 columns", () => {
		const row = workingRow("✦", Date.now() - 3_000, 398, 178, 100);
		expect(row).toContain("178 tok/s");
		expect(displayWidth(row), `live row was ${displayWidth(row)} columns`).toBeLessThanOrEqual(100);
	});
});
