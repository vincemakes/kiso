/**
 * LT-1 — the stream watchdog, at the guard (fake timers, a stub adapter).
 *
 * The contract: a stream whose events keep arriving inside `idleMs` is
 * never touched; a stream that goes silent for `idleMs` is aborted
 * underneath and the guard throws a retryable `network` error the kernel
 * retries; the caller's own abort still reads as the caller's; `idleMs`
 * off returns the adapter itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterEvent, StreamOptions } from "@vincemakes/kiso-core";
import { DEFAULT_STREAM_IDLE_MS, idleGuard } from "../src/idle-guard.js";

const OPTS: StreamOptions = { model: "m", messages: [{ role: "user", content: "x" }] };
const delta = (text: string): AdapterEvent => ({ seq: 0, type: "text_delta", text });
const stop = (): AdapterEvent => ({ seq: 0, type: "stop", reason: "end_turn" });

/** A stub whose events arrive on a schedule; `hang` after the last one
 *  means the iterator never resolves again (the silent socket). The signal
 *  it was handed is recorded so the tests can see the guard abort it. */
function scheduled(events: { at: number; ev: AdapterEvent }[], hang: boolean): { adapter: Adapter; signals: AbortSignal[]; returned: () => boolean } {
	const signals: AbortSignal[] = [];
	let returned = false;
	const adapter: Adapter = {
		stream(options) {
			signals.push(options.signal as AbortSignal);
			const queue = [...events];
			const t0 = Date.now();
			return {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<AdapterEvent>> {
							const head = queue.shift();
							if (head === undefined) {
								if (hang) return new Promise(() => undefined); // never
								return { done: true, value: undefined as never };
							}
							const wait = Math.max(0, head.at - (Date.now() - t0));
							await new Promise((r) => setTimeout(r, wait));
							return { done: false, value: head.ev };
						},
						async return(): Promise<IteratorResult<AdapterEvent>> {
							returned = true;
							return { done: true, value: undefined as never };
						},
					};
				},
			};
		},
	};
	return { adapter, signals, returned: () => returned };
}

async function drain(adapter: Adapter, options: StreamOptions = OPTS): Promise<{ events: AdapterEvent[]; error: unknown }> {
	const events: AdapterEvent[] = [];
	try {
		for await (const ev of adapter.stream(options)) events.push(ev);
		return { events, error: null };
	} catch (err) {
		return { events, error: err };
	}
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("LT-1 — the stream watchdog", () => {
	it("a stream that keeps arriving inside idleMs passes through untouched, events and all", async () => {
		const { adapter } = scheduled([{ at: 0, ev: delta("a") }, { at: 900, ev: delta("b") }, { at: 1800, ev: stop() }], false);
		const p = drain(idleGuard(adapter, 1000));
		await vi.advanceTimersByTimeAsync(2000);
		const { events, error } = await p;
		expect(error).toBeNull();
		expect(events.map((e) => e.type)).toEqual(["text_delta", "text_delta", "stop"]);
	});

	it("a stream that goes silent is aborted underneath and the guard throws a retryable network error naming the stall", async () => {
		const { adapter, signals, returned } = scheduled([{ at: 0, ev: delta("Harbors") }], true);
		const p = drain(idleGuard(adapter, 1000));
		await vi.advanceTimersByTimeAsync(999);
		expect(signals[0]?.aborted, "tripped early").toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		const { events, error } = await p;
		expect(events.map((e) => e.type)).toEqual(["text_delta"]); // what arrived before the silence is kept
		expect(error).toMatchObject({ code: "network", retryable: true });
		expect(String((error as { message: string }).message)).toContain("stream stalled: no event for 1s");
		expect(signals[0]?.aborted, "the underlying request was not aborted").toBe(true);
		expect(returned(), "the underlying iterator was not released").toBe(true);
	});

	it("the caller's own abort still reads as the caller's — no stall error is invented for it", async () => {
		const { adapter, signals } = scheduled([{ at: 0, ev: delta("a") }], true);
		const ctl = new AbortController();
		const p = drain(idleGuard(adapter, 5000), { ...OPTS, signal: ctl.signal });
		await vi.advanceTimersByTimeAsync(10);
		ctl.abort();
		// the stub never resolves on its own; the guard's own signal carries the abort down
		expect(signals[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(6000);
		const { error } = await p;
		// whatever the stub did with the abort, the guard did NOT turn it into a stall
		expect((error as { code?: string } | null)?.code).not.toBe("network");
	});

	it("idleMs off (undefined or 0) returns the adapter itself — declared off, not silently ignored", () => {
		const { adapter } = scheduled([], false);
		expect(idleGuard(adapter, undefined)).toBe(adapter);
		expect(idleGuard(adapter, 0)).toBe(adapter);
		expect(DEFAULT_STREAM_IDLE_MS).toBe(120_000);
	});
});
