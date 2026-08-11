/**
 * W18 — the faux adapter's `delay` pseudo-event: the harness's ONLY
 * honest way to make an adapter call genuinely slow at the process level
 * (the CLI e2e's slow-summarize). Pins what the delay IS: real elapsed
 * milliseconds, and nothing else — the following events yield unchanged.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "../src/index.js";

describe("the faux delay pseudo-event", () => {
	it("awaits REAL milliseconds before the following events, yielding nothing itself", async () => {
		const script: FauxScript = [
			{ events: [{ type: "delay", ms: 400 }, { type: "text_delta", text: "late" }, { type: "stop", reason: "end_turn" }] },
		];
		const adapter = createFauxProvider(script);
		// performance.now() — the monotonic clock; Date.now's wall-clock
		// truncation could read below the timer's deadline under load.
		// The 10ms slack: macOS kernel timer coalescing can deliver a
		// 400ms timer a FRACTION of a millisecond early even on the
		// monotonic clock (measured 399.83) — the gate's purpose is
		// "the delay really waits", not "within 1ms of nominal".
		const t0 = performance.now();
		const events = [];
		for await (const ev of adapter.stream({ model: "faux", messages: [] })) events.push(ev);
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeGreaterThanOrEqual(400 - 10); // REAL elapsed milliseconds
		expect(events.map((e) => e.type)).toEqual(["text_delta", "stop"]);
		expect(events[0]).toMatchObject({ type: "text_delta", text: "late", seq: 0 });
	});

	it("a delay inside a turn does not disturb the per-stream seq assignment", async () => {
		const script: FauxScript = [
			{ events: [{ type: "delay", ms: 5 }, { type: "text_delta", text: "a" }, { type: "stop", reason: "end_turn" }] },
		];
		const adapter = createFauxProvider(script);
		const events = [];
		for await (const ev of adapter.stream({ model: "faux", messages: [] })) events.push(ev);
		expect(events.map((e) => (e as { seq: number }).seq)).toEqual([0, 1]);
	});
});
