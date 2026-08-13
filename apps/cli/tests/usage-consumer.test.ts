/**
 * E2 (1.3.0) — the CLI's canonical usage consumer (R2a-1 ruling,
 * 2026-08-13): the mixed-convention consumer at chat.ts was a heal, and
 * this file pins the OLD→NEW difference — an EXISTING-BEHAVIOR CHANGE,
 * declared, never a silent side-fix.
 *
 * OLD (pre-heal, per-route raw):
 *  - openai-compat: `in` was the provider-raw TOTAL (fresh + cache) — the
 *    >100% cache-ratio disease: raw {input 111, cacheRead 1024} rendered
 *    "in 111" and the recap's cache % (then cache/in) was 923%.
 *  - anthropic: `in` was fresh as-is — already canonical; the miss
 *    estimate ran min-of-fresh-deltas − cacheRead → always below the
 *    floor → the miss signal never fired (silent).
 *  - the miss estimate: min(prevIn, in) − cacheRead, prevIn = the raw in.
 *
 * NEW (post-heal, canonical at the route):
 *  - `in` is FRESH-ONLY on BOTH routes (the pinned sentence) — the same
 *    canonical meaning the trace block carries; the recap's cache % is
 *    cache/(in+cache), never > 100% (T5, render.ts).
 *  - the miss estimate runs on the TOTAL side (fresh + cache): on
 *    openai-compat the numbers are IDENTICAL (its old `in` was total); on
 *    anthropic it is the fix (min-of-totals, the semantics the
 *    openai-compat side always had).
 *  - an unknown-usage event cannot kill the signal: the carrier recovers
 *    on the next known event (the old consumer's carrier stayed null
 *    forever).
 */

import { describe, expect, it } from "vitest";
import type { Usage } from "@vincemakes/kiso-core";
import { usageFromEvent } from "../src/chat.js";

/** The canonical df2 fixture (E1's reconciliation probe): raw total 1978,
 *  cache 1920 → canonical fresh 58. */
function df2(): Usage {
	return { seq: 1, type: "usage", inputTokens: 1978, outputTokens: 111, cacheRead: 1920, cacheWrite: null, known: true };
}

function event(partial: Partial<Usage>): Usage {
	return { seq: 1, type: "usage", inputTokens: 1978, outputTokens: 111, cacheRead: 1920, cacheWrite: null, known: true, ...partial };
}

describe("E2 R2a-1 — the CLI usage consumer is canonical (in is FRESH-ONLY)", () => {
	it("openai-compat: in is the canonical fresh count, never the raw total (OLD: in = 111 → NEW: in = 0)", () => {
		const d = usageFromEvent("openai-compat", event({ inputTokens: 111, cacheRead: 1024, outputTokens: 50 }), null);
		// OLD pinned: { in: 111, out: 50, cache: 1024 } — the raw total in the
		// status line (the 923% disease); NEW: the canonical fresh count.
		expect(d.usage).toEqual({ in: 0, out: 50, cache: 1024, known: true });
	});

	it("openai-compat: the df2 fixture canonicalizes (1978 − 1920 = 58 fresh) and total = the raw total", () => {
		const d = usageFromEvent("openai-compat", df2(), null);
		expect(d.usage.in).toBe(58);
		expect(d.usage.out).toBe(111);
		expect(d.usage.cache).toBe(1920);
		expect(d.total).toBe(1978); // the miss estimate's carrier — the raw total, preserved
	});

	it("openai-compat: the miss estimate is numerically IDENTICAL to the pre-heal formula", () => {
		// OLD: min(prev, 50000) − 45000 = 5000 (fired, above the 1024 floor).
		// NEW: total = max(0, 50000−45000) + 45000 = 50000 → identical 5000.
		const d = usageFromEvent("openai-compat", event({ inputTokens: 50000, cacheRead: 45000, outputTokens: 100 }), 50000);
		expect(d.missed).toBe(5000);
	});

	it("anthropic: in was already fresh — unchanged; the miss estimate now runs on totals (OLD: never fired)", () => {
		// OLD: in = 5000 (fresh, as-is — unchanged), but the miss estimate
		// was min(5000, 5000) − 45000 = −40000 → below the floor → silent.
		// NEW: total = 5000 + 45000 = 50000 → min(50000, 50000) − 45000 = 5000.
		const d = usageFromEvent("anthropic", event({ inputTokens: 5000, cacheRead: 45000, outputTokens: 100 }), 50000);
		expect(d.usage.in).toBe(5000);
		expect(d.missed).toBe(5000);
	});

	it("the route fallback is the total convention (the tracer's 'adapter' fallback, by construction)", () => {
		// a session without a provider resolves like the trace path's
		// unknown-route fallback — total convention, never a crash.
		const d = usageFromEvent(undefined, event({ inputTokens: 111, cacheRead: 1024, outputTokens: 50 }), null);
		expect(d.usage.in).toBe(0);
		expect(d.usage.cache).toBe(1024);
	});

	it("below the 1024-token floor the miss is noise — not surfaced", () => {
		const d = usageFromEvent("openai-compat", event({ inputTokens: 50000, cacheRead: 49400, outputTokens: 100 }), 50000);
		expect(d.missed).toBe(null); // min − cache = 600 < 1024
	});

	it("an unknown-usage event cannot corrupt the bookkeeping — the carrier recovers (OLD: null forever)", () => {
		const unknown = event({ known: false, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null });
		const d1 = usageFromEvent("openai-compat", unknown, null);
		// the canonical "0 = unknown" convention (the guard's quartet shape);
		// known:false suppresses every render, so the zeros are invisible
		expect(d1.usage).toEqual({ in: 0, out: 0, cache: 0, known: false });
		expect(d1.missed).toBe(null);
		// the NEXT known turn: the carrier is fresh again → the signal fires
		const d2 = usageFromEvent("openai-compat", df2(), d1.total);
		expect(d2.missed).toBe(null); // min(1978, 1978) − 1920 = 58 < 1024
		expect(d2.total).toBe(1978);
	});

	it("an above-floor miss on the df2 shape fires", () => {
		// a 90%-hit turn: total 50000, cache 45000 → miss 5000; then a
		// 70%-hit turn: total 50000, cache 35000 → miss 15000.
		const d1 = usageFromEvent("openai-compat", event({ inputTokens: 50000, cacheRead: 35000, outputTokens: 100 }), 50000);
		expect(d1.missed).toBe(15000);
	});
});
