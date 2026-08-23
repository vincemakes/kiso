/**
 * PH-1c — the model metadata table (findings PH-F14/PH-F15/PH-F16).
 *
 * Capabilities and pricing keyed by MODEL (+ optional endpoint), never
 * by route: `anthropic`/`openai-compat` are protocol conventions — the
 * same route serves models whose windows and rates have nothing in
 * common, which is how the old route-keyed table priced an Anthropic
 * run at DeepSeek's rates. The registry's one discipline: **unknown is
 * null, everywhere** — an absent entry, an absent field, an unverified
 * price all surface as null and no layer downstream may guess.
 *
 * Pricing is SEPARATE from capabilities (the review boundary): a price
 * is a dated claim about someone else's billing page, so every entry
 * carries `asOf` (the freeze date) and `source` (the page). A model we
 * can name but not price stays `pricing: null` — the honest stamp the
 * E2 nullable convention already defined.
 *
 * Lives under runtime/internal — the curated root surface (44 names)
 * does not move; core is untouched.
 */

export interface ModelCapabilities {
	/** tokens of context the model accepts; null = unknown. */
	readonly contextWindow: number | null;
	readonly maxOutputTokens: number | null;
	/** "automatic" — the provider caches without request markup (DeepSeek,
	 *  OpenAI); "explicit" — the request must place cache_control
	 *  breakpoints (Anthropic); "none" — no caching; null = unknown. */
	readonly promptCaching: "none" | "automatic" | "explicit" | null;
	/** the model emits a reasoning stream (thinking); null = unknown. */
	readonly reasoning: boolean | null;
}

export interface ModelPricing {
	readonly inputPerM: number;
	readonly outputPerM: number;
	readonly cacheReadPerM: number;
	readonly cacheWritePerM: number;
	/** the date the rates were read — a price is a dated claim. */
	readonly asOf: string;
	/** the billing page the rates came from. */
	readonly source: string;
}

export interface ModelMetadataEntry {
	/** EXACT model id — v1 does no pattern matching. */
	readonly model: string;
	/** origin qualifier (e.g. "https://api.deepseek.com"): when present,
	 *  the entry matches only requests aimed at that endpoint. */
	readonly endpoint?: string;
	readonly capabilities: ModelCapabilities;
	readonly pricing: ModelPricing | null;
}

const DEEPSEEK_PRICING: ModelPricing = {
	// The E2-frozen rates (pricing table v1, freeze date 2026-08-13),
	// re-homed here with their provenance made explicit. The caveat
	// carries forward verbatim: an approximation, not a bill.
	inputPerM: 0.27,
	outputPerM: 1.1,
	cacheReadPerM: 0.027,
	cacheWritePerM: 0,
	asOf: "2026-08-13",
	source: "https://api-docs.deepseek.com/quick_start/pricing",
};

/** The v1 table. Nulls outnumber numbers ON PURPOSE: only values with a
 *  named source enter; everything else waits for one. */
const ENTRIES: readonly ModelMetadataEntry[] = [
	{
		model: "deepseek-chat",
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: false },
		pricing: DEEPSEEK_PRICING,
	},
	{
		model: "deepseek-reasoner",
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: true },
		pricing: DEEPSEEK_PRICING,
	},
	{
		model: "claude-sonnet-5",
		capabilities: { contextWindow: 200_000, maxOutputTokens: null, promptCaching: "explicit", reasoning: true },
		// Priced only when the rates are read from the live billing page
		// and dated — never copied from memory (the review's boundary ②).
		pricing: null,
	},
	{
		model: "gpt-4o",
		capabilities: { contextWindow: 128_000, maxOutputTokens: null, promptCaching: "automatic", reasoning: false },
		pricing: null,
	},
];

/**
 * Look a model up. `endpoint` narrows: an entry WITH an endpoint only
 * matches when the caller's endpoint origin equals it; an entry without
 * one matches any endpoint. Unknown model → null, never a default.
 */
export function lookupModelMetadata(model: string, endpoint?: string): ModelMetadataEntry | null {
	for (const entry of ENTRIES) {
		if (entry.model !== model) continue;
		if (entry.endpoint !== undefined && endpoint !== undefined && entry.endpoint !== originOf(endpoint)) continue;
		return entry;
	}
	return null;
}

function originOf(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint;
	}
}
