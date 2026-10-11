/**
 * CX-1 F8 — one retry authority: the kernel.
 *
 * The SDK clients retried beneath the kernel's budget (maxRetries = 0
 * still made three requests) and beneath the request trace (audit F8).
 * Ruled: the kernel owns retries. Providers normalize `Retry-After`
 * into the structured error as `retryAfterMs`; the kernel waits
 * max(attempts × 250 ms, retryAfterMs), abortable; a wait above the
 * cap stops the run with an explicit error rather than retrying early;
 * the SDKs' implicit retries are off (proven on a local HTTP rig in the
 * provider suites).
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import type { Adapter } from "../src/protocol/adapter.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { parseRetryAfter } from "../src/errors.js";
import { seedLog } from "./seed.js";

const USER: Message = { role: "user", content: "go" };

/** Throws the structured error on the first N calls, then streams end_turn. */
function flaky(error: object, failures: number): { adapter: Adapter; calls: () => number; at: () => number[] } {
	let n = 0;
	const stamps: number[] = [];
	const adapter = {
		stream: async function* () {
			n += 1;
			stamps.push(Date.now());
			if (n <= failures) throw error;
			yield { type: "stop", reason: "end_turn", seq: 0 } as unknown as Event;
		},
	} as unknown as Adapter;
	return { adapter, calls: () => n, at: () => stamps };
}

async function run(adapter: Adapter, maxRetries: number, signal?: AbortSignal): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "faux", registry: new ToolRegistry(), log: seedLog([USER]), maxRetries, ...(signal !== undefined ? { signal } : {}) })) out.push(ev);
	return out;
}

const terminalOf = (events: Event[]) => events.find((e) => e.type === "terminal") as { outcome: { kind: string; error?: { message: string } } } | undefined;

describe("CX-1 F8 — the kernel honors Retry-After", () => {
	it("waits at least retryAfterMs before the retry (longer than its own backoff)", async () => {
		const f = flaky({ code: "rate_limit", retryable: true, message: "429", retryAfterMs: 800 }, 1);
		const events = await run(f.adapter, 2);
		expect(f.calls()).toBe(2);
		expect(f.at()[1]! - f.at()[0]!).toBeGreaterThanOrEqual(780); // the wait honored the header, not the 250 ms backoff
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});

	// RETIRED at 0.40.0 with the rule it stated: "the ladder is 250, 500"
	// — CX-1 F8's `max(n × 250 ms, Retry-After)`. ADR-0005 Amendment 2
	// replaced that curve: it spent the whole default budget in 750 ms,
	// which is no budget against a gateway that drops a stream and comes
	// back. What SURVIVES from this case is the half that was never about
	// the numbers — the 2026-09-07 review's P3: the first retry's delay is
	// computed for attempt ONE, before the counter advances. It is asserted
	// again below against the new curve, where the off-by-one would show as
	// a first wait from the n = 2 band (1,000–1,250 ms) instead of n = 1's.
	it("no Retry-After: the new ladder is 500 then 1,000 (+≤25% jitter) — and the FIRST wait is attempt one's (P3)", async () => {
		const f = flaky({ code: "rate_limit", retryable: true, message: "429" }, 2);
		const events = await run(f.adapter, 2);
		expect(f.calls()).toBe(3);
		const [t0, t1, t2] = f.at() as [number, number, number];
		expect(t1 - t0).toBeGreaterThanOrEqual(490);
		expect(t1 - t0).toBeLessThan(900); // the off-by-one would give 1,000–1,250
		expect(t2 - t1).toBeGreaterThanOrEqual(990);
		expect(t2 - t1).toBeLessThan(1_600);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});

	it("maxRetries = 0: exactly one attempt, the error is the terminal", async () => {
		const f = flaky({ code: "rate_limit", retryable: true, message: "429", retryAfterMs: 100 }, 1);
		const events = await run(f.adapter, 0);
		expect(f.calls()).toBe(1);
		expect(terminalOf(events)?.outcome.kind).toBe("error");
	});

	it("a Retry-After above the cap stops the run explicitly — never shortened, never retried early", async () => {
		const f = flaky({ code: "rate_limit", retryable: true, message: "429", retryAfterMs: 120_000 }, 1);
		const t0 = Date.now();
		const events = await run(f.adapter, 2);
		expect(f.calls()).toBe(1); // no retry
		expect(Date.now() - t0).toBeLessThan(5_000); // and no long wait either
		const term = terminalOf(events);
		expect(term?.outcome.kind).toBe("error");
		expect(term?.outcome.error?.message).toMatch(/cap|wait/i);
	});

	it("an abort during the wait: no further attempt", async () => {
		const f = flaky({ code: "rate_limit", retryable: true, message: "429", retryAfterMs: 2_000 }, 1);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const events = await run(f.adapter, 2, controller.signal);
		expect(f.calls()).toBe(1);
		expect(terminalOf(events)?.outcome.kind).toBe("aborted");
	});
});

describe("CX-1 F8 — parseRetryAfter", () => {
	it("integer seconds → milliseconds", () => {
		expect(parseRetryAfter("5")).toBe(5000);
		expect(parseRetryAfter("0")).toBe(0);
	});
	it("an HTTP-date in the future → the remaining milliseconds", () => {
		const now = Date.UTC(2026, 8, 7, 12, 0, 0);
		expect(parseRetryAfter("Mon, 07 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
	});
	it("a date already past, garbage, empty, negative → undefined", () => {
		const now = Date.UTC(2026, 8, 7, 12, 0, 0);
		expect(parseRetryAfter("Mon, 07 Sep 2026 11:59:00 GMT", now)).toBeUndefined();
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter("")).toBeUndefined();
		expect(parseRetryAfter("-3")).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
	});
});
