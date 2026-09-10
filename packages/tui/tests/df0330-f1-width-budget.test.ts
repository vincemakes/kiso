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
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "@vincemakes/kiso-tui-cells/width";
import { idleStatus, runningStatus } from "../src/status.js";

/** The owner's own, and the reason this finding exists. */
const REAL = "deepseek-v4.1-flash-expires-on-0910"; // 35
const METER = { cacheHitPct: 91, costUsd: null, tokPerSec: 178 };

describe("DF-0330-F1 — the idle row at the widths people use", () => {
	it("at 140 columns nothing is dropped and the row is byte-identical to the unbudgeted one", () => {
		const wide = idleStatus("default", REAL, 0.01, METER, 140);
		expect(wide).toBe(idleStatus("default", REAL, 0.01, METER));
		expect(wide).toContain(REAL);
		expect(wide).toContain("/mode to switch");
		expect(wide).toContain("178 tok/s");
	});

	it("at 100 columns it FITS, the rate survives, and the hint is still there", () => {
		const row = idleStatus("default", REAL, 0.01, METER, 100);
		expect(displayWidth(row), `row was ${displayWidth(row)} columns: ${row}`).toBeLessThanOrEqual(100);
		expect(row).toContain("178 tok/s");
		expect(row).toContain("/mode to switch");
		expect(row).toContain("CH 91%");
		expect(row).toContain("ctx left");
		// the worked number from the finding: 87 with the id elided to twenty
		expect(displayWidth(row)).toBe(87);
	});

	it("the elision keeps the HEAD and the TAIL — the tail is what distinguishes", () => {
		const row = idleStatus("default", REAL, 0.01, METER, 100);
		expect(row).toContain("deepseek-v");
		expect(row).toContain("0910");
		expect(row).not.toContain(REAL);
	});

	it("at 80 columns the HINT goes and every fact stays", () => {
		const row = idleStatus("default", REAL, 0.01, METER, 80);
		expect(displayWidth(row), `row was ${displayWidth(row)} columns: ${row}`).toBeLessThanOrEqual(80);
		expect(row).not.toContain("/mode to switch");
		expect(row).toContain("▸ default");
		expect(row).toContain("CH 91%");
		expect(row).toContain("ctx left");
		expect(row).toContain("178 tok/s");
	});

	it("an ORDINARY model id is untouched at 100 columns — the drop order is a no-op with room", () => {
		const row = idleStatus("default", "gpt-6-astra", 0.01, METER, 100);
		expect(row).toBe(idleStatus("default", "gpt-6-astra", 0.01, METER));
		expect(row).toContain("gpt-6-astra");
		expect(row).toContain("/mode to switch");
	});

	it("the `…` CUT is unreachable at 100 columns for every id up to forty characters", () => {
		for (let n = 1; n <= 40; n += 1) {
			const id = "m".repeat(n);
			const row = idleStatus("default", id, 0.01, METER, 100);
			expect(displayWidth(row), `id of ${n} chars produced ${displayWidth(row)} columns`).toBeLessThanOrEqual(100);
		}
	});

	it("the budget is in DISPLAY COLUMNS, so a wide-character id cannot slip back over it", () => {
		// No model id looks like this today. The guarantee should not depend on
		// that staying true: a first version of the elision sliced code points
		// and produced 28 columns while claiming 20, which would have put the
		// row straight back under invariant ①'s cut — the exact defect this
		// change exists to prevent.
		const wide = "モデル-フラッシュ-expires-on-0910"; // 33 display columns, 25 code points
		const row = idleStatus("default", wide, 0.01, METER, 100);
		expect(displayWidth(row), `row was ${displayWidth(row)} columns: ${row}`).toBeLessThanOrEqual(100);
		expect(row).toContain("178 tok/s");
	});

	it("no width given means no dropping — the callers that do not know stay exactly as they were", () => {
		expect(idleStatus("default", REAL, 0.01, METER)).toContain(REAL);
		expect(idleStatus("default", REAL, 0.01)).toBe("▸ default · /mode to switch · " + REAL + " · ctx left ~99%");
	});
});

describe("DF-0330-F1 — the running row", () => {
	it("with a rate it still fits 100 columns; its text is unchanged by this round", () => {
		const row = runningStatus("✦", Date.now() - 3_000, 398, 0.01, 178);
		expect(row).toContain("178 tok/s");
		expect(displayWidth(row), `running row was ${displayWidth(row)} columns`).toBeLessThanOrEqual(100);
	});
});
