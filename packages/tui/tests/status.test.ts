/**
 * KC2 §5 — the status-line FORMATTERS, extracted from the CLI (the
 * ADR-0041 escape hatch: extraction, never a raise). The rows are pinned
 * here byte-for-byte because the e2e transcripts match them by substring:
 * the idle row is UNCHANGED by the move, and the running row's only
 * change is the KC2 §2 hint that names the new gesture.
 */
import { describe, expect, it } from "vitest";
import { STATUS_GLYPHS, idleStatus, runningStatus } from "../src/status.js";

describe("KC2 §5: the idle status row (byte-identical to the pre-extraction CLI)", () => {
	it("names the tier, the /mode hint, the model and the ctx estimate", () => {
		expect(idleStatus("default", "faux", 0.25)).toBe("▸ default · /mode to switch · faux · ctx left ~75%");
	});

	it("takes the tier as GIVEN — the caller spells plan's posture, the formatter never guesses", () => {
		// chat spells it out (W19); the recovery flow passes the bare mode —
		// the move must not silently unify them.
		expect(idleStatus("plan (read-only)", "faux", 0)).toContain("▸ plan (read-only) · /mode to switch");
		expect(idleStatus("plan", "faux", 0)).toContain("▸ plan · /mode to switch");
	});

	it("a non-finite ratio prints the row's long-standing ~null%, never an invented number", () => {
		expect(idleStatus("default", "faux", Number.NaN)).toBe("▸ default · /mode to switch · faux · ctx left ~null%");
	});
});

describe("KC2 §5/§2: the running status row", () => {
	it("carries the glyph, the wall seconds, the token count and the ctx estimate", () => {
		const row = runningStatus("▖", Date.now() - 3_000, 1234, 0.1);
		expect(row).toMatch(/^▖ working 3s ↓ 1\.2k tokens · /);
		expect(row).toContain("ctx left ~90%");
	});

	it("a run that just started still reads 1s — the row never says 0s", () => {
		expect(runningStatus("▘", Date.now(), null, 0)).toMatch(/^▘ working 1s · /);
	});

	it("omits the token segment while the output count is unknown", () => {
		expect(runningStatus("▝", Date.now(), null, 0)).not.toContain("tokens");
	});

	it("KC2 §2 — the hint names BOTH gestures: esc stops, alt+⏎ redirects", () => {
		const row = runningStatus("▗", Date.now(), null, 0.5);
		expect(row).toContain("· esc stop · alt+⏎ redirect ·");
	});

	it("the row still satisfies the v2d transcript gate's shape", () => {
		// apps/cli/tests/tui-v2d.test.ts matches /^[▖▘▝▗] working \d+s.*$/ —
		// every glyph in the family must produce it.
		for (const g of STATUS_GLYPHS) expect(runningStatus(g, Date.now(), null, 0)).toMatch(/^[▖▘▝▗] working \d+s.*$/);
	});
});

describe("KC2 §5: the working glyph family", () => {
	it("is the v3 §03/§05 four-glyph rotation the CLI's spinner walks", () => {
		expect([...STATUS_GLYPHS]).toEqual(["▖", "▘", "▝", "▗"]);
	});
});
