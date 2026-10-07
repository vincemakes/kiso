/**
 * KC2 §5 — the status-line FORMATTERS, extracted from the CLI (the
 * ADR-0041 escape hatch: extraction, never a raise).
 *
 * RE-DERIVED (the legacy rows retired, owner 2026-10-06: delete them when
 * tui/graphite merges into main): `idleStatus` and `runningStatus` — the pre-Graphite rows —
 * are gone; the CLI draws the bar (`statusBar`, §8.9) and the live row
 * (`workingRow`, §8.7). Every rule these cases guarded still holds on
 * them, and is pinned on them here; only the old row's own format went.
 */
import { describe, expect, it } from "vitest";
import { STATUS_GLYPHS, statusBar, workingRow, type BarInput } from "../src/status.js";

const BAR: BarInput = { mode: "default", floorOff: false, model: "faux", ctx: { used: 0.25, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null };

describe("KC2 §5: the idle row — the bar, off a painted ground", () => {
	it("names the tier, the /mode hint, the model and the ctx estimate", () => {
		expect(statusBar(BAR, 100, null)).toBe("▸ default · /mode to switch · faux · ctx 25%");
	});

	it("takes the tier as GIVEN — the caller spells plan's posture, the formatter never guesses", () => {
		expect(statusBar({ ...BAR, mode: "plan (read-only)" }, 100, null)).toContain("▸ plan (read-only) · /mode to switch");
		expect(statusBar({ ...BAR, mode: "plan" }, 100, null)).toContain("▸ plan · /mode to switch");
	});

	it("no known window prints `ctx ?`, never an invented number", () => {
		// The invented number is the failure it guards: until 2026-09-14 the
		// window fell back to a hardcoded 200,000 whenever a model published
		// none, and every DeepSeek session printed a confident figure
		// computed against a number nobody had measured.
		const row = statusBar({ ...BAR, ctx: null }, 100, null);
		expect(row).toBe("▸ default · /mode to switch · faux · ctx ?");
		expect(row).not.toMatch(/\d+%/);
	});
});

describe("KC2 §5/§2: the running row — the live row", () => {
	it("carries the glyph, the wall seconds and the token count", () => {
		expect(workingRow("▖", Date.now() - 3_000, 1234, null, 100)).toMatch(/^▖ working 3s · ↓ 1\.2k /);
	});

	it("a run that just started still reads 1s — the row never says 0s", () => {
		expect(workingRow("▘", Date.now(), null, null, 100)).toMatch(/^▘ working 1s /);
	});

	it("omits the token segment while the output count is unknown", () => {
		expect(workingRow("▝", Date.now(), null, null, 100)).not.toContain("↓");
	});

	it("KC2 §2 — the keys name the gestures: esc stops, ⏎ steers, alt+⏎ redirects", () => {
		expect(workingRow("▗", Date.now(), null, null, 100)).toMatch(/ esc stop · ⏎ steer · alt\+⏎ redirect$/);
	});

	it("the row still satisfies the v2d transcript gate's shape", () => {
		// apps/cli/tests/tui-v2d.test.ts matches /^[✧✦✶✸✺] working \d+s.*$/ —
		// every glyph in the family must produce it.
		for (const g of STATUS_GLYPHS) expect(workingRow(g, Date.now(), null, null, 100)).toMatch(/^[✧✦✶✸✺] working \d+s.*$/);
	});
});

describe("KC2 §5: the working glyph family", () => {
	// DECLARED SUPERSESSION (R3, design §5.2): the four quadrant blocks
	// are retired for the TWINKLE. Two reasons, both in the contract:
	// §5.3 forbids a mark that ROTATES on a call whose duration cannot be
	// predicted (it implies progress the product does not have), and §4.1
	// wants the running mark to be the mark that STAYS — the twinkle
	// settles onto `✦`, which is what a folded segment keeps.
	it("is design §5.2's seven-frame twinkle, settling on the fold's own mark", () => {
		expect([...STATUS_GLYPHS]).toEqual(["✧", "✦", "✶", "✸", "✺", "✸", "✦"]);
		expect(STATUS_GLYPHS[STATUS_GLYPHS.length - 1]).toBe("✦"); // §4.1: it settles where the fold lives
		expect(STATUS_GLYPHS).toHaveLength(7); // §5.1: seven steps of the 200ms tick = 1.4s
	});
});

describe("one duration form — the live row uses the shared label (0.39.1)", () => {
	// The row that started the item: the helper existed at 0.39.0, and a
	// call site that was not swept still read `working 637s`.
	it("past a minute the working row reads in minutes, not a four-figure second count", () => {
		const row = workingRow("✦", Date.now() - 637_000, null, null, 100);
		expect(row).toContain("working 10m 37s");
		expect(row).not.toContain("637s");
	});

	it("under a minute nothing moved", () => {
		expect(workingRow("✦", Date.now() - 5_000, null, null, 100)).toContain("working 5s");
	});
});
