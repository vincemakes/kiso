/**
 * TPS-1 — the settled decode rate on the status row.
 *
 * `rate = outputTokens ÷ seconds from the call's FIRST streamed event to
 * its usage event`. TTFT is excluded on purpose: this is decode
 * throughput, which is what "tokens per second" means to a person
 * watching text arrive.
 *
 * The rate is a PROJECTION of two events already in the log, so the null
 * rule is presentation policy and lives here with the rows it governs
 * (the KC2 §5 split: the CLI keeps the state, the terminal layer decides
 * what a row SAYS).
 *
 * Nothing is rendered when the number would not be a measurement:
 * no usage from the provider, no output count, under half a second of
 * decoding, or an integer that would print as 0 — a `0 tok/s` reads as a
 * stall whether it came from zero tokens or from rounding, and neither
 * tells the reader anything.
 *
 * The FIRST gate here is the compatibility one: with no rate, both rows
 * are byte-identical to the rows they were before this round. That is
 * also why every existing faux-driven CLI test keeps passing untouched —
 * a faux script with no delay streams instantly, lands under the floor,
 * and renders nothing.
 */
import { describe, expect, it } from "vitest";
import { decodeRate, idleStatus, runningStatus } from "../src/status.js";

describe("TPS-1: the rate itself", () => {
	it("is output tokens over the decode seconds, as an integer", () => {
		expect(decodeRate(120, 3_000)).toBe(40);
		expect(decodeRate(87, 2_000)).toBe(44); // 43.5 rounds up
		expect(decodeRate(86, 2_000)).toBe(43);
	});

	it("no output count is no rate — never a zero standing in for a silence", () => {
		expect(decodeRate(null, 3_000)).toBeNull();
	});

	it("under half a second of decoding is not a measurement", () => {
		expect(decodeRate(50, 499)).toBeNull();
		expect(decodeRate(50, 500)).toBe(100);
	});

	it("a call that decoded NOTHING has no rate to report", () => {
		// The row's number is a decode rate. `0 tok/s` would read as a
		// measured speed and it is not one — it is the absence of output,
		// which the transcript already shows. Zero tokens, well above the
		// floor, and still nothing on the row.
		expect(decodeRate(0, 5_000)).toBeNull();
		expect(decodeRate(0, 30_000)).toBeNull();
	});

	it("and neither does one whose rate ROUNDS to zero — same display, same reason", () => {
		// 0.2 tok/s prints as `0 tok/s`, which reads as the same stall
		// whether it came from silence or from a slow trickle. The condition
		// is on the rendered integer, so both reach the same absence.
		expect(decodeRate(2, 10_000)).toBeNull(); // 0.2 → 0
		expect(decodeRate(5, 10_000)).toBe(1); // 0.5 → 1, a real slow rate
	});

	it("a non-positive elapsed is not a measurement either", () => {
		expect(decodeRate(100, 0)).toBeNull();
		expect(decodeRate(100, -5)).toBeNull();
	});
});

describe("TPS-1: the running row", () => {
	it("with no rate the row is byte-identical to the pre-round row", () => {
		const at = Date.now() - 3_000;
		expect(runningStatus("▖", at, 1234, 0.1, null)).toBe(runningStatus("▖", at, 1234, 0.1));
		expect(runningStatus("▖", at, 1234, 0.1)).toBe("▖ working 3s ↓ 1.2k tokens · esc stop · alt+⏎ redirect · ctx left ~90%");
	});

	it("the segment sits between the tokens segment and the stop hint", () => {
		expect(runningStatus("▖", Date.now() - 3_000, 1234, 0.1, 42)).toBe(
			"▖ working 3s ↓ 1.2k tokens · 42 tok/s · esc stop · alt+⏎ redirect · ctx left ~90%",
		);
	});

	it("a rate with no token count yet still renders — the two are independent", () => {
		expect(runningStatus("▘", Date.now(), null, 0, 42)).toBe("▘ working 1s · 42 tok/s · esc stop · alt+⏎ redirect · ctx left ~100%");
	});
});

describe("TPS-1: the idle row", () => {
	it("with no rate the row is byte-identical to the pre-round row", () => {
		expect(idleStatus("default", "faux", 0.25, { cacheHitPct: null, costUsd: null, tokPerSec: null })).toBe(
			"▸ default · /mode to switch · faux · ctx left ~75%",
		);
		expect(idleStatus("default", "faux", 0.25)).toBe("▸ default · /mode to switch · faux · ctx left ~75%");
	});

	it("the segment comes LAST, after the ctx estimate", () => {
		expect(idleStatus("default", "faux", 0.25, { cacheHitPct: null, costUsd: null, tokPerSec: 42 })).toBe(
			"▸ default · /mode to switch · faux · ctx left ~75% · 42 tok/s",
		);
	});

	it("sits beside the cache figure without disturbing its place", () => {
		expect(idleStatus("default", "faux", 0.25, { cacheHitPct: 91, costUsd: null, tokPerSec: 42 })).toBe(
			"▸ default · /mode to switch · faux · CH 91% · ctx left ~75% · 42 tok/s",
		);
	});
});
