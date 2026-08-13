/**
 * E2 (1.3.0) — T1/T2: the canonical schema, the route-keyed mapping, and
 * the reconciliation fixtures (proposal §1/§2, ruled 2026-08-13).
 *
 * Red→green anchors: fixture 1 is the registered disease reproduction
 * (TODO.md:39-47 — raw {inputTokens 111, cacheRead 1024} on a fresh route
 * rendered "cache 923%" by the old recap formula cache/in); the canonical
 * schema renders it 90.2% — the >100% disease structurally impossible
 * (T5's display gate re-pins it on the TUI recap).
 */

import { describe, expect, it } from "vitest";
import {
	INPUT_CONVENTIONS,
	PRICING_TABLE_V1,
	canonicalizeUsage,
	pricingTableFor,
	validateCanonicalUsage,
} from "../src/usage/canonical.js";
import type { CanonicalUsage, RawUsage } from "../src/usage/canonical.js";

/** Fixture 1 — the registered reproduction (fresh route): fresh input 111
 *  vs cacheRead 1024. The old recap formula (cache/in) rendered 923%; the
 *  canonical ratio cacheRead/(input+cacheRead) renders 90%. */
const REPRO_RAW_FRESH: RawUsage = { inputTokens: 111, outputTokens: 320, cacheRead: 1024, cacheWrite: null };
/** The same underlying request as reported by a TOTAL-convention route
 *  (input = fresh + cached): the DeepSeek dual-endpoint closure. */
const REPRO_RAW_TOTAL: RawUsage = { inputTokens: 1135, outputTokens: 320, cacheRead: 1024, cacheWrite: null };

const pct = (c: CanonicalUsage): number => Math.round((c.cacheRead / (c.input + c.cacheRead)) * 100);

describe("E2 T1 — the pinned sentence (R1a): input is FRESH-ONLY", () => {
	it("the registered reproduction: canonical input is the fresh 111, the ratio is 90%, never 923%", () => {
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		expect(c.input).toBe(111);
		expect(c.cacheRead).toBe(1024);
		expect(pct(c)).toBe(90);
		// the pinned sentence, machine-checked: the numerator can never
		// exceed the denominator — a ratio >100% is structurally impossible
		expect(c.cacheRead).toBeLessThanOrEqual(c.input + c.cacheRead);
		expect(pct(c)).toBeLessThanOrEqual(100);
	});

	it("total is the derived quantity, never a reported one", () => {
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		expect(c.input + c.cacheRead).toBe(1135); // total, derived
	});

	it("a request that reports NO usage yields zeros, never faked numbers", () => {
		const c = canonicalizeUsage("anthropic", { inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null });
		expect(c.input).toBe(0);
		expect(c.output).toBe(0);
		expect(c.cacheRead).toBe(0);
		expect(c.cacheWrite).toBeNull();
	});
});

describe("E2 T1 — the route-keyed mapping (R2a) and the dual-endpoint closure", () => {
	it("the conventions are pinned by route, not provider", () => {
		expect(INPUT_CONVENTIONS).toEqual({ anthropic: "fresh", "openai-compat": "total" });
	});

	it("the DeepSeek dual-endpoint closure: BOTH routes land on the SAME canonical numbers", () => {
		const fresh = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		const total = canonicalizeUsage("openai-compat", REPRO_RAW_TOTAL);
		expect(total.input).toBe(fresh.input); // 111 — same meaning, by construction
		expect(total.cacheRead).toBe(fresh.cacheRead);
		expect(total.output).toBe(fresh.output);
		expect(pct(total)).toBe(pct(fresh)); // 90% on both routes — the closure
	});

	it("anthropic input is fresh as-is; openai-compat input = prompt_tokens − cached_tokens", () => {
		const raw = { inputTokens: 1135, outputTokens: 320, cacheRead: 1024, cacheWrite: null };
		expect(canonicalizeUsage("anthropic", raw).input).toBe(1135);
		expect(canonicalizeUsage("openai-compat", raw).input).toBe(111);
	});

	it("behavior-preserving against the guard's incumbent branch: unknown route falls back to total, never negative", () => {
		// the guard's settle: anthropic ? inputTokens : max(0, inputTokens − cacheRead)
		expect(canonicalizeUsage("bogus-route", { inputTokens: 100, outputTokens: 0, cacheRead: 40, cacheWrite: null }).input).toBe(60);
		expect(canonicalizeUsage("openai-compat", { inputTokens: 100, outputTokens: 0, cacheRead: 200, cacheWrite: null }).input).toBe(0);
	});
});

describe("E2 T1 — cost from the versioned pricing table (R1c)", () => {
	it("the v1 table: DeepSeek's published rates, version 1, cache-hit ratio 0.1", () => {
		expect(PRICING_TABLE_V1.version).toBe(1);
		for (const e of Object.values(PRICING_TABLE_V1.entries)) {
			expect(e.cacheReadPerM / e.inputPerM).toBeCloseTo(0.1, 10);
		}
		expect(PRICING_TABLE_V1.entries.anthropic).toEqual({ inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.027, cacheWritePerM: 0 });
	});

	it("every cost carries its table version; the version is pinned", () => {
		const c = canonicalizeUsage("openai-compat", REPRO_RAW_TOTAL);
		expect(c.pricingTableVersion).toBe(1);
		expect(pricingTableFor(1)).toBe(PRICING_TABLE_V1);
		expect(() => pricingTableFor(2)).toThrow(/no pricing table pinned/i);
	});

	it("cost is computed from the components × the table rates", () => {
		// 1M fresh input ($0.27) + 1M output ($1.10) → $1.37 exactly
		const c = canonicalizeUsage("openai-compat", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null });
		expect(c.costUsd).toBeCloseTo(1.37, 9);
		// cache hits are 0.1×: 1M cacheRead → $0.027
		const cached = canonicalizeUsage("openai-compat", { inputTokens: 1_001_000, outputTokens: 0, cacheRead: 1_000_000, cacheWrite: null });
		expect(cached.input).toBe(1_000); // fresh
		expect(cached.costUsd).toBeCloseTo(0.00027 + 0.027, 9);
	});
});

describe("E2 T1 — the validator (invariants machine-checked)", () => {
	const canonical = (): CanonicalUsage => canonicalizeUsage("anthropic", REPRO_RAW_FRESH);

	it("accepts the canonical record; rejects extra and missing keys (the closed set)", () => {
		expect(validateCanonicalUsage(canonical())).toBe(true);
		expect(validateCanonicalUsage({ ...canonical(), bogus: 1 })).toBe(false);
		const keys = Object.keys(canonical());
		for (const k of keys) {
			const broken: Record<string, unknown> = { ...canonical() };
			delete broken[k];
			expect(validateCanonicalUsage(broken), `missing ${k}`).toBe(false);
		}
	});

	it("rejects negative numbers and untyped fields", () => {
		expect(validateCanonicalUsage({ ...canonical(), input: -1 })).toBe(false);
		expect(validateCanonicalUsage({ ...canonical(), cacheRead: "1024" })).toBe(false);
		expect(validateCanonicalUsage({ ...canonical(), output: Number.NaN })).toBe(false);
		expect(validateCanonicalUsage({ ...canonical(), costUsd: -0.01 })).toBe(false);
	});

	it("cacheWrite/reasoning are null-or-number; reasoning stays null by contract", () => {
		expect(validateCanonicalUsage({ ...canonical(), cacheWrite: 42 })).toBe(true);
		expect(validateCanonicalUsage({ ...canonical(), cacheWrite: -1 })).toBe(false);
		expect(validateCanonicalUsage({ ...canonical(), reasoning: 17 })).toBe(true);
		expect(validateCanonicalUsage({ ...canonical(), reasoning: -1 })).toBe(false);
		expect(canonical().reasoning).toBeNull(); // no provider reports a split
	});

	it("pins the table version to a pinned table; the pinned sentence holds", () => {
		expect(validateCanonicalUsage({ ...canonical(), pricingTableVersion: 2 })).toBe(false); // unpinned
		expect(validateCanonicalUsage({ ...canonical(), pricingTableVersion: 1.5 })).toBe(false);
		// the reproduction record passes — cacheRead 1024 with input 111 is
		// canonical-true (the ratio is 90%, computed over the total)
		expect(validateCanonicalUsage(canonical())).toBe(true);
	});
});
