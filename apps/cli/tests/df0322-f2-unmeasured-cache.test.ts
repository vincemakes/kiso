/**
 * DF-0322-F2 — a cache the provider never reported is not a 0% cache.
 *
 * Noticed while reading a capture from another round's gate: a usage event
 * with `cacheRead: null` and `known: true` painted `CH 0%` on the status row.
 *
 * The mechanism, read from the source rather than inferred.
 * `canonicalizeUsage` sets `const cacheRead = raw.cacheRead ?? 0` — correct
 * for ACCOUNTING, which has to sum numbers — and `usageFromEvent` handed that
 * canonical zero to the DISPLAY. The row then computed `0 / total` and said
 * the cache hit rate was measured at zero.
 *
 * This is the family OR-10 and DF-0311-F1 belong to: A ROW CLAIMING A
 * MEASUREMENT THAT NEVER HAPPENED. OR-10 closed it for one endpoint known to
 * answer `cached_tokens: 0` to third-party clients, using a registry flag.
 * The general case — a provider that simply omits the field — stayed open.
 *
 * Reachable from the shipped adapters: `packages/provider-openai` emits
 * `cacheRead: details?.cached_tokens ?? null` with `known: true`, and the
 * Anthropic adapter `cache_read_input_tokens ?? null`.
 *
 * THE FIX IS AT THE DISPLAY BOUNDARY, and OR-10's own comment argued for it:
 * "The trace ledger is written by the runtime from the backend's own words
 * and keeps its 0 — the display's rule, not the record's." So the canonical
 * record is untouched and pinned that way below; only what the row is handed
 * changes.
 */

import { describe, expect, it } from "vitest";
import type { Usage } from "@vincemakes/kiso-core";
import { canonicalizeUsage } from "@vincemakes/kiso-runtime";
import { usageFromEvent } from "../src/chat.js";
import { cacheHitPct } from "@vincemakes/kiso-tui";

const usage = (over: Partial<Usage>): Usage =>
	({ seq: 0, type: "usage", inputTokens: 1000, outputTokens: 50, cacheRead: null, cacheWrite: null, known: true, ...over }) as Usage;

describe("DF-0322-F2 — the ROW", () => {
	it("a provider that reported NO cache field renders no CH at all", () => {
		const d = usageFromEvent("openai-compat", usage({ cacheRead: null }), null);
		expect(d.usage.cache, "the display was handed a zero for a figure nobody measured").toBeNull();
		expect(cacheHitPct(d.usage)).toBeNull();
	});

	it("a provider that reported a real ZERO still renders 0% — measured is measured", () => {
		// The distinction the old code could not make. A backend that says
		// `cached_tokens: 0` HAS answered the question, and the row should say
		// what it answered.
		const d = usageFromEvent("openai-compat", usage({ cacheRead: 0 }), null);
		expect(d.usage.cache).toBe(0);
		expect(cacheHitPct(d.usage)).toBe(0);
	});

	it("a reported cache is unaffected", () => {
		const d = usageFromEvent("openai-compat", usage({ inputTokens: 1000, cacheRead: 900 }), null);
		expect(d.usage.cache).toBe(900);
		expect(Math.round(cacheHitPct(d.usage) ?? -1)).toBe(90);
	});

	it("an unknown-usage event still renders nothing, as before", () => {
		const d = usageFromEvent("openai-compat", usage({ inputTokens: null, outputTokens: null, cacheRead: null, known: false }), null);
		expect(d.usage.cache).toBeNull();
	});
});

describe("DF-0322-F2 — the RECORD is untouched", () => {
	it("canonicalizeUsage still coerces a null cacheRead to 0 — accounting sums numbers", () => {
		// Pinned so the display fix cannot drift into the ledger. The trace
		// keeps the backend's own words and its arithmetic; the row's rule is
		// not the record's.
		const c = canonicalizeUsage("openai-compat", usage({ cacheRead: null }));
		expect(c.cacheRead).toBe(0);
		expect(typeof c.input).toBe("number");
	});

	it("and the totals the miss estimate runs on are unchanged", () => {
		const withNull = usageFromEvent("openai-compat", usage({ inputTokens: 1000, cacheRead: null }), null);
		const withZero = usageFromEvent("openai-compat", usage({ inputTokens: 1000, cacheRead: 0 }), null);
		expect(withNull.total).toBe(withZero.total);
		expect(withNull.costUsd).toBe(withZero.costUsd);
	});
});
