/**
 * ADR-0005 Amendment 2 — the backoff, the budget, and a retry you can see.
 *
 * CX-1 F8's `max(n × 250 ms, Retry-After)` with a default budget of 2 spent
 * every retry inside 750 ms: no budget at all against a gateway that drops
 * a stream and comes back. 0.39.1 had just made that failure RETRYABLE,
 * and the kernel then gave it three-quarters of a second.
 *
 * The amendment changes three things, each pinned here:
 *  - the curve: min(500 ms × 2^(n−1), 32 s) + up to 25% jitter, never
 *    below the provider's Retry-After;
 *  - the default budget: 10;
 *  - the retry is ANNOUNCED before each wait (`onRetry`), because a budget
 *    measured in minutes with nothing on screen is indistinguishable from
 *    a hung session.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import type { Adapter } from "../src/protocol/adapter.js";
import type { RetryInfo } from "../src/kernel/hooks.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { DEFAULT_MAX_RETRIES, RETRY_AFTER_MAX_MS, loop, retryDelayMs } from "../src/kernel/loop.js";
import { seedLog } from "./seed.js";

const USER: Message = { role: "user", content: "go" };

describe("the curve", () => {
	it("doubles from 500 ms and stops at 32 s (no jitter)", () => {
		const zero = (): number => 0;
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => retryDelayMs(n, undefined, zero))).toEqual([
			500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000,
		]);
	});

	it("jitter adds at most a quarter, never subtracts", () => {
		for (const n of [1, 3, 7, 10]) {
			const base = retryDelayMs(n, undefined, () => 0);
			expect(retryDelayMs(n, undefined, () => 0.999999)).toBeLessThanOrEqual(Math.round(base * 1.25));
			expect(retryDelayMs(n, undefined, () => 0.5)).toBeGreaterThanOrEqual(base);
		}
	});

	it("the provider's Retry-After is a FLOOR, never shortened", () => {
		expect(retryDelayMs(1, 5_000, () => 0)).toBe(5_000); // asked for more than the curve
		expect(retryDelayMs(7, 5_000, () => 0)).toBe(32_000); // the curve is already longer
	});

	it("the curve alone never reaches the cap — only a provider's own ask can", () => {
		// 32 s × 1.25 = 40 s < RETRY_AFTER_MAX_MS: the explicit "beyond the
		// cap; not retried" stop stays reserved for a Retry-After above it.
		expect(retryDelayMs(10, undefined, () => 0.999999)).toBeLessThan(RETRY_AFTER_MAX_MS);
	});

	it("the default budget is ten", () => {
		expect(DEFAULT_MAX_RETRIES).toBe(10);
	});
});

/** Fails the first N calls with the given error, then ends the turn. */
function flaky(error: object, failures: number, streamFirst = false): Adapter {
	let n = 0;
	return {
		stream: async function* () {
			n += 1;
			if (streamFirst) yield { seq: 0, type: "text_delta", text: "half" } as unknown as Event;
			if (n <= failures) throw error;
			yield { seq: 0, type: "stop", reason: "end_turn" } as unknown as Event;
		},
	} as unknown as Adapter;
}

async function run(adapter: Adapter, maxRetries: number, onRetry?: (i: RetryInfo) => Promise<void>): Promise<Event[]> {
	const out: Event[] = [];
	const hooks = onRetry !== undefined ? { onRetry } : undefined;
	for await (const ev of loop({ adapter, model: "faux", registry: new ToolRegistry(), log: seedLog([USER]), maxRetries, ...(hooks !== undefined ? { hooks } : {}) })) out.push(ev);
	return out;
}

const outcome = (events: Event[]): string | undefined => (events.find((e) => e.type === "terminal") as { outcome: { kind: string } } | undefined)?.outcome.kind;

describe("the retry is announced before its wait", () => {
	it("each retry is announced with its attempt, the budget, the code and the wait — BEFORE the wait", async () => {
		const seen: { info: RetryInfo; at: number }[] = [];
		const t0 = Date.now();
		const events = await run(flaky({ code: "network", retryable: true, message: "cut" }, 2), 3, async (info) => {
			seen.push({ info, at: Date.now() - t0 });
		});
		expect(outcome(events)).toBe("completed");
		expect(seen.map((s) => [s.info.attempt, s.info.maxRetries, s.info.code, s.info.midStream])).toEqual([
			[1, 3, "network", false],
			[2, 3, "network", false],
		]);
		// announced BEFORE the wait: the first announcement arrives almost at
		// once, not after its own 500 ms+ delay
		expect(seen[0]!.at).toBeLessThan(300);
		expect(seen[0]!.info.delayMs).toBeGreaterThanOrEqual(500);
		expect(seen[1]!.info.delayMs).toBeGreaterThanOrEqual(1_000);
	});

	it("a mid-stream retry says so — its draft was voided first", async () => {
		const seen: RetryInfo[] = [];
		await run(flaky({ code: "network", retryable: true, message: "cut" }, 1, true), 2, async (i) => {
			seen.push(i);
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]!.midStream).toBe(true);
	});

	it("a throwing observer changes nothing — the retry still happens and the turn completes", async () => {
		const events = await run(flaky({ code: "network", retryable: true, message: "cut" }, 1), 2, async () => {
			throw new Error("a broken status row");
		});
		expect(outcome(events)).toBe("completed");
	});

	it("nothing is announced when nothing is retried — a permanent error, or an empty budget", async () => {
		const seen: RetryInfo[] = [];
		const obs = async (i: RetryInfo): Promise<void> => {
			seen.push(i);
		};
		await run(flaky({ code: "invalid_request", retryable: false, message: "400" }, 1), 3, obs);
		await run(flaky({ code: "network", retryable: true, message: "cut" }, 1), 0, obs);
		expect(seen).toEqual([]);
	});
});
