/**
 * E2 (1.3.0) — Canonical Usage: the reconciled usage schema (proposal §1
 * as ruled 2026-08-13; R1a-R5 all adopted).
 *
 * THE PINNED SENTENCE (R1a): one canonical meaning for `input`, everywhere
 * in kiso, forever: `input` is FRESH-ONLY — the tokens NOT served from
 * cache. `total = input + cacheRead + cacheWrite` is the derived quantity,
 * never a reported one. A cache ratio is always `cacheRead / total` — the
 * numerator can never exceed the denominator. The >100% disease is
 * structurally impossible under the canonical schema.
 *
 * The mapping keys on the ROUTE, not the provider (R2a): DeepSeek serves
 * both routes and reports input fresh-only on one (anthropic-compat) and
 * TOTAL on the other (openai-compat) — the SAME canonical meaning falls
 * out of the route key (the dual-endpoint closure). The route string is
 * the config adapter identity the guard already holds (`"anthropic" |
 * "openai-compat"`).
 *
 * Cost comes from the versioned pricing table — every cost carries the
 * table version it was computed with (R1c). The built-in v1 table prices
 * both routes at DeepSeek's published rates; the caveat sentence from the
 * bench README carries forward verbatim ("an approximation, not a bill").
 * The commercial table is the product's Phase 10 (the table is injectable;
 * the version travels with every cost).
 *
 * The frozen usage union stays provider-raw — this module derives at the
 * accounting boundary (R4 Case B, pure derivation; the union does not
 * move). Raw is provider observation; canonical is the accounting truth.
 */

/** The union's usage shape (provider-raw — core protocol `events.Usage`). */
export interface RawUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
}

/** The ONE canonical usage record. Every field has exactly one meaning
 *  (proposal §1.2). wall/ttft live in the trace record (latencyMs/ttftMs)
 *  — one source, never duplicated here. */
export interface CanonicalUsage {
	/** FRESH-ONLY — the pinned sentence above. total = input + cacheRead +
	 *  cacheWrite is the derived quantity, never a reported one. */
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	/** null = the provider reports none (openai-compat honestly does). */
	readonly cacheWrite: number | null;
	/** null = no reasoning split reported (reserved — every provider today). */
	readonly reasoning: number | null;
	/** USD, computed from the pricing table below. Never reported without
	 *  its table version (the billing-basis ground). */
	readonly costUsd: number;
	readonly pricingTableVersion: number;
}

/** The versioned pricing table — a rate change is a version bump, never an
 *  edit; every cost records the version it was computed with (R1c). */
export interface PricingTable {
	readonly version: number;
	readonly entries: Readonly<Record<string, PricingEntry>>;
}

export interface PricingEntry {
	/** USD per 1M FRESH input tokens. */
	readonly inputPerM: number;
	readonly outputPerM: number;
	readonly cacheReadPerM: number;
	/** USD per 1M cache-creation tokens. 0 = the provider does not price
	 *  cache writes separately (DeepSeek's automatic caching). */
	readonly cacheWritePerM: number;
}

/** The route → input-convention table (R2a). `input` semantics differ
 *  between the two routes; the convention is a property of the ROUTE, not
 *  the provider. Unknown routes fall back to "total" — exactly the
 *  incumbent guard behavior (the guard's else-branch: non-anthropic =
 *  total), preserved by construction. */
export const INPUT_CONVENTIONS: Readonly<Record<string, "fresh" | "total">> = {
	anthropic: "fresh", // input_tokens excludes the cached prefix
	"openai-compat": "total", // prompt_tokens includes the cached prefix
};

/** Pricing table v1. Freeze date 2026-08-13 (the E2 ruling). Rates:
 *  DeepSeek's published rates (https://api-docs.deepseek.com/quick_start/pricing),
 *  the 0.1 cache-hit ratio the bench has used since the 0.1.23 round. The
 *  caveat sentence carries forward verbatim (bench README): "an
 *  approximation, not a bill." */
export const PRICING_TABLE_V1: PricingTable = {
	version: 1,
	entries: {
		anthropic: { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.027, cacheWritePerM: 0 },
		"openai-compat": { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.027, cacheWritePerM: 0 },
	},
};

export const PRICING_TABLES: Readonly<Record<number, PricingTable>> = {
	1: PRICING_TABLE_V1,
};

/** The table pinned for a version; throws when none is pinned (a cost
 *  recorded against an unpinned version is a ledger corruption). */
export function pricingTableFor(version: number): PricingTable {
	const table = PRICING_TABLES[version];
	if (table === undefined) throw new Error(`no pricing table pinned for version ${version}`);
	return table;
}

export function priceFor(route: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number | null }, table: PricingTable): number {
	// Unknown route → the total-convention entry, matching the convention
	// fallback above (one table, one fallback — no drift).
	const entry = table.entries[route] ?? table.entries["openai-compat"]!;
	return (
		(u.input * entry.inputPerM +
			u.output * entry.outputPerM +
			u.cacheRead * entry.cacheReadPerM +
			(u.cacheWrite ?? 0) * entry.cacheWritePerM) /
		1e6
	);
}

/** Raw → canonical (the accounting boundary). Behavior-preserving against
 *  the guard's incumbent per-provider branch (guard.ts settle): anthropic
 *  input is fresh as-is; every other route subtracts cacheRead. */
export function canonicalizeUsage(route: string, raw: RawUsage): CanonicalUsage {
	const convention = INPUT_CONVENTIONS[route] ?? "total";
	const input =
		raw.inputTokens === null
			? 0
			: convention === "fresh"
				? raw.inputTokens
				: Math.max(0, raw.inputTokens - (raw.cacheRead ?? 0));
	const cacheRead = raw.cacheRead ?? 0;
	const cacheWrite = raw.cacheWrite ?? null;
	const output = raw.outputTokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: null, // reserved — no provider reports a split today
		costUsd: priceFor(route, { input, output, cacheRead, cacheWrite }, PRICING_TABLE_V1),
		pricingTableVersion: PRICING_TABLE_V1.version,
	};
}

// ── The validator ──────────────────────────────────────────────────────────
// Strict by design: closed keys (a misspelled field can never enter a
// ledger), non-negative numbers, the pinned sentence machine-checked, and
// a pinned table version. Cost CONSISTENCY (costUsd recomputed from the
// components × the version's table) needs the ROUTE — it lives in the
// trace record; the trace-level validator cross-checks it there (T3).

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const CANONICAL_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "costUsd", "pricingTableVersion"] as const;

const isNonNegNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The canonical schema's invariants, machine-checked: closed key set;
 *  non-negative numbers; cacheWrite/reasoning null-or-number; the pinned
 *  sentence — cacheRead can never exceed total (= input + cacheRead +
 *  cacheWrite) — structurally true for non-negatives but pinned against
 *  future edits; pricingTableVersion is a pinned table. */
export function validateCanonicalUsage(v: unknown): v is CanonicalUsage {
	if (!isRecord(v)) return false;
	const keys = Object.keys(v);
	if (keys.length !== CANONICAL_FIELDS.length || keys.some((k) => !(CANONICAL_FIELDS as readonly string[]).includes(k))) return false;
	if (!isNonNegNum(v.input) || !isNonNegNum(v.output) || !isNonNegNum(v.cacheRead)) return false;
	if (v.cacheWrite !== null && !isNonNegNum(v.cacheWrite)) return false;
	if (v.reasoning !== null && !isNonNegNum(v.reasoning)) return false;
	if (!isNonNegNum(v.costUsd)) return false;
	if (typeof v.pricingTableVersion !== "number" || !Number.isInteger(v.pricingTableVersion) || v.pricingTableVersion <= 0) return false;
	if (!(v.pricingTableVersion in PRICING_TABLES)) return false;
	const total = v.input + v.cacheRead + (v.cacheWrite ?? 0);
	if (v.cacheRead > total) return false; // the pinned sentence
	return true;
}
