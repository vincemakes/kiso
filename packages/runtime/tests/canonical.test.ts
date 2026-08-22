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
	priceFor,
	pricingTableFor,
	validateCanonicalUsage,
} from "../src/usage/canonical.js";
import type { CanonicalUsage, PricingTable, RawUsage } from "../src/usage/canonical.js";

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

describe("R5b-④ — the injection slot, the (id, version) stamp, and the absent cost (2026-08-13)", () => {
	// A foreign table with distinct rates: the injection point live.
	const INJECTED: PricingTable = {
		id: "acme-2026",
		version: 42,
		entries: {
			anthropic: { inputPerM: 9, outputPerM: 9, cacheReadPerM: 9, cacheWritePerM: 0 },
			"openai-compat": { inputPerM: 9, outputPerM: 9, cacheReadPerM: 9, cacheWritePerM: 0 },
		},
	};

	it("④a — canonicalizeUsage(route, raw) defaults to the builtin v1 table", () => {
		const c = canonicalizeUsage("openai-compat", REPRO_RAW_TOTAL);
		expect(c.pricingTableId).toBe("builtin");
		expect(c.pricingTableVersion).toBe(1);
		expect(c.costUsd).not.toBeNull();
	});

	it("④b — the two-tuple stamp: an injected table's id + version ride the record", () => {
		const c = canonicalizeUsage("openai-compat", REPRO_RAW_TOTAL, INJECTED);
		expect(c.pricingTableId).toBe("acme-2026");
		expect(c.pricingTableVersion).toBe(42);
		expect(c.costUsd).not.toBeNull();
	});

	it("④c — an injected table missing a route's rate → costUsd null, never backfilled", () => {
		const HOLEY: PricingTable = {
			id: "acme-partial",
			version: 7,
			entries: { "openai-compat": { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0 } },
		};
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH, HOLEY);
		expect(c.costUsd).toBeNull(); // explicit absent — no builtin backfill
		expect(validateCanonicalUsage(c)).toBe(true); // the validator accepts absent
	});

	it("④c — the validator: null costUsd is valid, non-numbers and negatives are not", () => {
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		expect(validateCanonicalUsage({ ...c, costUsd: null })).toBe(true);
		expect(validateCanonicalUsage({ ...c, costUsd: "0.27" })).toBe(false);
		expect(validateCanonicalUsage({ ...c, costUsd: -0.01 })).toBe(false);
	});

	it("④b — pricingTableId joins the closed field set (7 → 8), a non-empty string", () => {
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		expect(validateCanonicalUsage({ ...c, pricingTableId: "acme-2026" })).toBe(true);
		expect(validateCanonicalUsage({ ...c, pricingTableId: "" })).toBe(false);
		expect(validateCanonicalUsage({ ...c, pricingTableId: 7 })).toBe(false);
		const withoutId: Record<string, unknown> = { ...c };
		delete withoutId.pricingTableId;
		expect(validateCanonicalUsage(withoutId)).toBe(false); // the closed set grew by one
	});

	it("④b — the version pin is builtin-scoped: a foreign id's version is the injector's accounting", () => {
		const c = canonicalizeUsage("anthropic", REPRO_RAW_FRESH);
		expect(validateCanonicalUsage({ ...c, pricingTableVersion: 2 })).toBe(false); // builtin id + unpinned
		expect(validateCanonicalUsage({ ...c, pricingTableId: "acme", pricingTableVersion: 42 })).toBe(true);
	});

	it("④c (superseded by PH-1a) — an unknown route is NEVER priced: no entry → null, never a crash, never a mirror guess", () => {
		// PH-1a sanctioned supersession of the R5b-④c mirror fallback: the
		// "adapter" route (a directly-injected adapter, or a binding with no
		// declared provider) used to be silently priced at the openai-compat
		// mirror entry — a fabricated cost on exactly the runs whose rates
		// are unknown. costUsd = null is the honest stamp (E2's nullable
		// convention); the convention fallback ("total") is unchanged.
		expect(priceFor("bogus-route", { input: 1, output: 0, cacheRead: 0, cacheWrite: null }, PRICING_TABLE_V1)).toBeNull();
		expect(priceFor("adapter", { input: 1, output: 0, cacheRead: 0, cacheWrite: null }, PRICING_TABLE_V1)).toBeNull();
		const ANTHROPIC_ONLY: PricingTable = {
			id: "anthropic-only",
			version: 3,
			entries: { anthropic: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0 } },
		};
		expect(priceFor("bogus-route", { input: 1, output: 0, cacheRead: 0, cacheWrite: null }, ANTHROPIC_ONLY)).toBeNull();
	});

	it("④a — an explicit table drives the cost; the builtin meaning is untouched", () => {
		const raw = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };
		const injected = canonicalizeUsage("anthropic", raw, INJECTED);
		expect(injected.costUsd).toBeCloseTo(18, 9); // 9 + 9 per 1M at the injected rates
		const builtin = canonicalizeUsage("anthropic", raw);
		expect(builtin.costUsd).toBeCloseTo(1.37, 9); // 1.37 at the builtin rates — unchanged
	});
});
