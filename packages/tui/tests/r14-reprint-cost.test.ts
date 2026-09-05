/**
 * R14 / G9 — WHAT A REPRINT COSTS.
 *
 * Route B trades bytes for correctness: where the old settle repainted
 * the live region and left the committed rows to the terminal's own
 * reflow, this one re-emits the entire session. That is the whole point
 * — the terminal ends holding one correct rendering — but a cost paid
 * on every drag deserves a number rather than an assurance, and a
 * number that is recorded rather than merely asserted, so the next
 * round can see it move.
 *
 * The bound below is deliberately loose. This case is a TRIPWIRE against
 * an order-of-magnitude change (a reprint that starts emitting per-row
 * escapes it does not need, or one that runs more than once per settle),
 * not a budget: pinning the exact byte count would make every rendering
 * change land here for no reason, and the honest measurement is the
 * number this test prints.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const ROWS = 5_000;

function harness(W: number, H: number) {
	let w = W;
	let h = H;
	let bytes = 0;
	const body = new Body({
		active: () => true,
		height: () => h,
		width: () => w,
		editCol: () => 1,
		write: (s) => {
			bytes += s.length;
		},
	});
	return { body, size: (nw: number, nh: number) => { w = nw; h = nh; }, bytes: () => bytes, reset: () => { bytes = 0; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("G9 — the reprint's cost, measured", () => {
	it("a 5,000-row session's settle: bytes and wall recorded", async () => {
		// REAL TIMERS for this case, and the reason is worth keeping.
		// Under vitest's fake clock `process.hrtime` is faked too, so the
		// first draft of this measurement reported 200.0 ms of work against
		// a 200.0 ms baseline — both were the advance itself, and the
		// "work" figure was identically zero. A wall-clock number that a
		// release report will carry cannot come from a faked clock.
		vi.useRealTimers();
		const h = harness(80, 24);
		h.body.enter();
		for (let i = 0; i < ROWS; i += 1) h.body.raw([`row ${String(i).padStart(4, "0")} of the session`]);
		await new Promise((r) => setTimeout(r, 50));
		h.reset();

		const t0 = process.hrtime.bigint();
		h.size(100, 30);
		h.body.onResize();
		await new Promise((r) => setTimeout(r, 250)); // RESIZE_SETTLE_MS is 80
		const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
		const bytes = h.bytes();

		// eslint-disable-next-line no-console
		console.log(`[G9] ${ROWS} rows, 80x24 -> 100x30: ${bytes.toLocaleString()} bytes, ${(wallMs - 250).toFixed(1)} ms above the 250 ms wait`);

		// the transcript really was reprinted, not skipped
		expect(bytes, "the settle emitted nothing — the measurement is vacuous").toBeGreaterThan(ROWS * 10);
		// the tripwire: an order of magnitude over the content itself
		expect(bytes, "a reprint costs an order of magnitude more than the rows it carries").toBeLessThan(ROWS * 400);
	}, 30_000);

	it("one drag storm is ONE reprint, whatever its length", () => {
		const h = harness(80, 24);
		h.body.enter();
		for (let i = 0; i < 200; i += 1) h.body.raw([`row ${i}`]);
		vi.advanceTimersByTime(100);
		h.reset();

		let erases = 0;
		const spy = new Body({
			active: () => true,
			height: () => 24,
			width: () => 80,
			editCol: () => 1,
			write: (s) => {
				erases += s.split("\x1b[3J").length - 1;
			},
		});
		spy.enter();
		for (let i = 0; i < 200; i += 1) spy.raw([`row ${i}`]);
		vi.advanceTimersByTime(100);
		erases = 0;
		// 20 winches inside one settle window
		for (let i = 0; i < 20; i += 1) {
			spy.onResize();
			vi.advanceTimersByTime(2);
		}
		vi.advanceTimersByTime(300);
		expect(erases, "a 20-winch drag storm erased more than once").toBeLessThanOrEqual(1);
	});
});
