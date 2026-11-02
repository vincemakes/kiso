import { canonicalizeUsage } from "@vincemakes/kiso-runtime";
import type { Event } from "@vincemakes/kiso-core";
import { cacheRate, type UsageFrame, type UsageNumbers } from "../shared/frames.js";

/**
 * The run's usage, read off the durable log — `usage` is not on the wire.
 *
 * The same two rules the terminal's ledger states (apps/cli chat.ts,
 * turnUsageLedger): a CALL is its LATEST report (a gateway may report one
 * request twice), a RUN is the sum over its calls, and an unmeasured term
 * makes the sum unmeasured. `stop` ends a call; `terminal` ends the run.
 * The input is the canonical FRESH count, so the cache rate
 * cache / (fresh + cache) can never pass 100%.
 */

const sum = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

function fold(a: UsageNumbers | null, b: UsageNumbers | null): UsageNumbers | null {
	if (a === null) return b;
	if (b === null) return a;
	return { fresh: sum(a.fresh, b.fresh), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), costUsd: sum(a.costUsd, b.costUsd), known: a.known && b.known };
}

/** One durable usage event as numbers; `route` is the adapter identity the
 *  canonical mapping keys on ("openai-compat", "anthropic", "adapter"). */
export function callNumbers(route: string, ev: Extract<Event, { type: "usage" }>): UsageNumbers {
	const c = canonicalizeUsage(route, ev);
	return { fresh: c.input, output: c.output, cacheRead: ev.cacheRead === null ? null : c.cacheRead, costUsd: c.costUsd, known: ev.known };
}

/** The frame for the usage event at `seq`: the call, and the run so far. */
export function usageFrameAt(events: readonly Event[], seq: number, route: string): UsageFrame | null {
	let settled: UsageNumbers | null = null;
	let inFlight: UsageNumbers | null = null;
	let calls = 0;
	for (const ev of events) {
		if (ev.seq > seq) break;
		if (ev.type === "terminal") {
			settled = null;
			inFlight = null;
			calls = 0;
		} else if (ev.type === "stop") {
			settled = fold(settled, inFlight);
			inFlight = null;
		} else if (ev.type === "usage") {
			if (inFlight === null) calls += 1;
			inFlight = callNumbers(route, ev);
			if (ev.seq === seq) {
				const turn = fold(settled, inFlight)!;
				return { seq, window: null, call: inFlight, turn: { ...turn, cacheRate: cacheRate(turn.fresh, turn.cacheRead), calls } };
			}
		}
	}
	return null;
}

/** The run that ended at the terminal `seq`: its totals. */
export function runTotals(events: readonly Event[], terminalSeq: number, route: string): UsageFrame["turn"] | null {
	let settled: UsageNumbers | null = null;
	let inFlight: UsageNumbers | null = null;
	let calls = 0;
	for (const ev of events) {
		if (ev.seq > terminalSeq) break;
		if (ev.type === "terminal") {
			if (ev.seq === terminalSeq) {
				const turn = fold(settled, inFlight);
				return turn === null ? null : { ...turn, cacheRate: cacheRate(turn.fresh, turn.cacheRead), calls };
			}
			settled = inFlight = null;
			calls = 0;
		} else if (ev.type === "stop") {
			settled = fold(settled, inFlight);
			inFlight = null;
		} else if (ev.type === "usage") {
			if (inFlight === null) calls += 1;
			inFlight = callNumbers(route, ev);
		}
	}
	return null;
}

const CALL_OUTPUT = new Set(["thinking", "text_start", "text_delta", "tool_call_start", "tool_call_end"]);

/** The run's decode rate as the terminal times one call (TPS-1), summed: each call from its first output event to its last usage
 *  report (tool time falls between calls), output over the summed time; null under 0.5 s or with no output ("0 tok/s" is no measurement). */
export function runRate(events: readonly Event[], terminalSeq: number, output: number | null, at: (seq: number) => number): number | null {
	const start = events.reduce((n, ev) => (ev.type === "terminal" && ev.seq < terminalSeq ? ev.seq : n), -1);
	let [ms, first, last] = [0, -1, -1];
	for (const ev of events) {
		if (ev.seq <= start || ev.seq > terminalSeq) continue;
		if (CALL_OUTPUT.has(ev.type) && first < 0) first = ev.seq;
		else if (ev.type === "usage" && first >= 0) last = ev.seq;
		if (ev.type === "stop" || ev.seq === terminalSeq) [ms, first, last] = [ms + (first >= 0 && last >= 0 ? Math.max(0, at(last) - at(first)) : 0), -1, -1];
	}
	const rate = output === null || ms < 500 ? 0 : Math.round(output / (ms / 1000));
	return rate > 0 ? rate : null;
}
