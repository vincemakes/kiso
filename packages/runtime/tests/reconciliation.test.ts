/**
 * E2 (1.3.0) — T2: the per-provider reconciliation fixtures (proposal §2.2
 * as ruled). Probe-measured raw values → canonical, field-by-field.
 *
 * Probes:
 *  - openai route: REAL recorded values from the E1 dogfood 2 ledger
 *    (kiso 1.2.0, DeepSeek via openai-compat — /tmp/e1-df2-home/sessions/
 *    traces/dogfood-e1-2.jsonl row 1: fresh 58, cacheRead 1920, output 111;
 *    the raw total reconstructs as fresh + cacheRead = 1978 — the guard's
 *    freshInput derivation is exactly total − cacheRead, the same math the
 *    canonical mapper formalizes).
 *  - anthropic route: the registered disease reproduction (TODO.md:39-47:
 *    anthropic-compat reported inputTokens 59/111 vs cacheRead 1024 — the
 *    111/1024 observation, used throughout).
 * The assertions pin the canonical numbers the trace records (T3's guard
 * computes the block from the same raws — the probe IS the trace record's
 * input side).
 */

import { describe, expect, it } from "vitest";
import { canonicalizeUsage } from "../src/usage/canonical.js";

/** E1 df2 row 1 — the openai-compat probe (real model traffic). */
const OPENAI_PROBE_RAW = { inputTokens: 1978, outputTokens: 111, cacheRead: 1920, cacheWrite: null };
/** The anthropic-compat reproduction — inputTokens 111 vs cacheRead 1024. */
const ANTHROPIC_PROBE_RAW = { inputTokens: 111, outputTokens: 320, cacheRead: 1024, cacheWrite: null };

describe("E2 T2 — reconciliation: probe-measured raw vs canonical, field-by-field", () => {
	it("openai-compat probe: the recorded fresh 58 falls out of the mapping", () => {
		const c = canonicalizeUsage("openai-compat", OPENAI_PROBE_RAW);
		expect(c.input).toBe(58); // the E1 ledger's freshInput, reproduced
		expect(c.cacheRead).toBe(1920);
		expect(c.output).toBe(111);
		expect(c.cacheWrite).toBeNull();
		expect(c.reasoning).toBeNull();
		// the ledger's est−actual basis holds: total = input + cacheRead = 1978
		expect(c.input + c.cacheRead).toBe(1978);
		// the cache ratio on canonical values: 1920/1978 ≈ 97% — never >100%
		expect(Math.round((c.cacheRead / (c.input + c.cacheRead)) * 100)).toBe(97);
	});

	it("anthropic-compat probe: input is fresh as-is — the ratio is 90%, never 923%", () => {
		const c = canonicalizeUsage("anthropic", ANTHROPIC_PROBE_RAW);
		expect(c.input).toBe(111);
		expect(c.cacheRead).toBe(1024);
		expect(c.output).toBe(320);
		expect(Math.round((c.cacheRead / (c.input + c.cacheRead)) * 100)).toBe(90);
	});

	it("the reconciliation is stable across a JSON round-trip (the ledger write path)", () => {
		const c = canonicalizeUsage("openai-compat", OPENAI_PROBE_RAW);
		const roundTripped = JSON.parse(JSON.stringify(c)) as typeof c;
		expect(roundTripped).toEqual(c);
	});

	it("both probes carry the cost of the versioned table v1", () => {
		const o = canonicalizeUsage("openai-compat", OPENAI_PROBE_RAW);
		// fresh 58 × 0.27 + output 111 × 1.1 + cacheRead 1920 × 0.027, per 1M
		expect(o.costUsd).toBeCloseTo((58 * 0.27 + 111 * 1.1 + 1920 * 0.027) / 1e6, 12);
		expect(o.pricingTableVersion).toBe(1);
		const a = canonicalizeUsage("anthropic", ANTHROPIC_PROBE_RAW);
		expect(a.costUsd).toBeCloseTo((111 * 0.27 + 320 * 1.1 + 1024 * 0.027) / 1e6, 12);
	});
});
