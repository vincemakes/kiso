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
import { decodeRate, statusBar, workingRow, type BarInput } from "../src/status.js";

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

// RE-DERIVED (the legacy rows retired, owner 2026-10-06): the running row
// is the live row (§8.7), the idle row the bar (§8.9). The rules hold:
// no rate, no segment; the rate after the tokens on the live row and last
// on the bar; the two independent.
const BAR: BarInput = { mode: "default", floorOff: false, model: "faux", ctx: { used: 0.25, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null };

describe("TPS-1: the live row", () => {
	it("with no rate there is no segment", () => {
		expect(workingRow("▖", Date.now() - 3_000, 1234, null, 120)).toMatch(/^▖ working 3s · ↓ 1\.2k +esc stop/);
	});

	it("the segment sits after the tokens, before the keys", () => {
		expect(workingRow("▖", Date.now() - 3_000, 1234, 42, 120)).toMatch(/^▖ working 3s · ↓ 1\.2k · 42 tok\/s +esc stop/);
	});

	it("a rate with no token count yet still renders — the two are independent", () => {
		expect(workingRow("▘", Date.now(), null, 42, 120)).toMatch(/^▘ working 1s · 42 tok\/s +esc stop/);
	});
});

describe("TPS-1: the bar", () => {
	it("with no rate there is no segment", () => {
		expect(statusBar(BAR, 120, null)).toBe("▸ default · /mode to switch · faux · ctx 25%");
	});

	it("the segment comes LAST, after the ctx estimate", () => {
		expect(statusBar({ ...BAR, tokPerSec: 42 }, 120, null)).toBe("▸ default · /mode to switch · faux · ctx 25% · 42 tok/s");
	});
});
