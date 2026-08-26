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
	/** XP-1: the reasoning capability matrix — supersedes the pre-XP-1
	 *  boolean IN PLACE (zero consumers existed, verified). null = unknown:
	 *  no mode list, no effort levels, nothing downstream may guess. */
	readonly reasoning: ReasoningCapabilities | null;
	/** MG-1: the input parts the model accepts (e.g. ["text","image"]);
	 *  null = unknown — the CLI treats unknown as text-only with an honest
	 *  notice, never a guess. Evidenced by 0.15.7's image attachments:
	 *  the gateway must know before the request is built. */
	readonly inputModalities: readonly string[] | null;
}

/** XP-1 (the ratified spec §4.1): the two ORTHOGONAL axes. "default" on
 *  each axis means the provider's own default, displayed honestly as
 *  such. The union nesting effort under enabled stays rejected: Anthropic
 *  effort affects whole responses with or without explicit thinking, and
 *  some model/effort combinations forbid thinking-disabled. */
export type ThinkingMode = "default" | "adaptive" | "enabled" | "disabled";
export type ReasoningEffort = "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ReasoningSetting {
	readonly thinking: ThinkingMode;
	readonly effort: ReasoningEffort;
}

/** XP-1 §4.2: the per-model matrix. A provider's toggle semantics are a
 *  dated claim about someone else's API — the same class as a price, so
 *  the block carries asOf + source exactly as pricing does. */
export interface ReasoningCapabilities {
	/** the old boolean's meaning, preserved under its own name. */
	readonly emitsThinkingStream: boolean | null;
	/** null = no request-time toggle is known for this model. */
	readonly thinking: {
		readonly modes: readonly Exclude<ThinkingMode, "default">[];
		readonly default: Exclude<ThinkingMode, "default"> | null;
	} | null;
	/** null = no effort control is known. `levels` are NATIVE only —
	 *  compatibility mappings are displayed as their resolution, never as
	 *  distinct native levels. `wire` names the dialect parameter. */
	readonly effort: {
		readonly levels: readonly Exclude<ReasoningEffort, "default">[];
		readonly default: Exclude<ReasoningEffort, "default"> | null;
		readonly wire: string;
	} | null;
	/** invalid combinations the provider documents (e.g. thinking-disabled
	 *  at certain efforts). */
	readonly forbidden?: readonly ReasoningSetting[];
	readonly asOf: string | null;
	readonly source: string | null;
}

/** XP-1: the resolved wire values — what an adapter actually serializes.
 *  Empty = provider defaults, byte-identical to a pre-XP-1 request. */
export interface WireReasoning {
	readonly thinking?: "adaptive" | "enabled" | "disabled";
	readonly effort?: string;
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
	/** MG-1: the provider identity (manifest id) — retires the string
	 *  inference from the model id's hyphen prefix. */
	readonly providerId?: string;
	readonly capabilities: ModelCapabilities;
	/** XP-1: a provider-announced retirement, dated and sourced. */
	readonly deprecated?: { readonly asOf: string; readonly source: string };
	/** MG-1: capability values are dated claims exactly as prices are —
	 *  null marks an undated legacy claim (the pre-MG-1 table). */
	readonly capabilitiesAsOf?: string | null;
	readonly capabilitiesSource?: string | null;
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
		providerId: "deepseek",
		// XP-1: the changelog entry dated 2026-04-24 discontinues the two
		// legacy names on 2026-07-24 (they pointed at v4-flash during the
		// transition). v6's "unsourced" rider cited the wrong page.
		deprecated: { asOf: "2026-07-24", source: "https://api-docs.deepseek.com/updates/" },
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: { emitsThinkingStream: false, thinking: null, effort: null, asOf: null, source: null }, inputModalities: null },
		pricing: DEEPSEEK_PRICING,
	},
	{
		model: "deepseek-reasoner",
		providerId: "deepseek",
		// XP-1: the changelog entry dated 2026-04-24 discontinues the two
		// legacy names on 2026-07-24 (they pointed at v4-flash during the
		// transition). v6's "unsourced" rider cited the wrong page.
		deprecated: { asOf: "2026-07-24", source: "https://api-docs.deepseek.com/updates/" },
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: { emitsThinkingStream: true, thinking: null, effort: null, asOf: null, source: null }, inputModalities: null },
		pricing: DEEPSEEK_PRICING,
	},
	{
		model: "claude-sonnet-5",
		providerId: "anthropic",
		capabilities: { contextWindow: 200_000, maxOutputTokens: null, promptCaching: "explicit",
			reasoning: {
				emitsThinkingStream: true,
				thinking: null,
				effort: { levels: ["low", "medium", "high", "xhigh", "max"], default: "high", wire: "output_config.effort" },
				asOf: "2026-08-26",
				source: "https://platform.claude.com/docs/en/build-with-claude/effort",
			},
			inputModalities: null },
		// Priced only when the rates are read from the live billing page
		// and dated — never copied from memory (the review's boundary ②).
		pricing: null,
	},
	{
		// XP-1: the current DeepSeek line — the model every RD-1 benchmark
		// artifact was produced with, previously ABSENT (null pricing and
		// capabilities everywhere). Thinking is a request-time toggle,
		// default-ENABLED; effort is native low/high/max (foreign levels
		// are the provider's own mapping, never shown as native). Pricing
		// stays null until read from the live billing page and dated.
		model: "deepseek-v4-flash",
		providerId: "deepseek",
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			effort: { levels: ["low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-08-26",
			source: "https://api-docs.deepseek.com/guides/thinking_mode",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-08-26",
		capabilitiesSource: "https://api-docs.deepseek.com/guides/thinking_mode",
		pricing: null,
	},
	{
		model: "deepseek-v4-pro",
		providerId: "deepseek",
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			effort: { levels: ["low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-08-26",
			source: "https://api-docs.deepseek.com/guides/thinking_mode",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-08-26",
		capabilitiesSource: "https://api-docs.deepseek.com/guides/thinking_mode",
		pricing: null,
	},
	{
		model: "gpt-4o",
		providerId: "openai",
		capabilities: { contextWindow: 128_000, maxOutputTokens: null, promptCaching: "automatic", reasoning: { emitsThinkingStream: false, thinking: null, effort: null, asOf: null, source: null }, inputModalities: null },
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

/**
 * XP-1 §4.2 — native-only resolution. The rules, in order:
 *   default/default → NO wire fields (the byte-identity anchor — a
 *   default-profile session's requests are byte-identical to pre-XP-1);
 *   an unknown model refuses any non-default selection (unknown stays
 *   unknown — nothing downstream guesses a level into existence);
 *   a value outside the matrix's NATIVE list is refused with the native
 *   list named — never silently downgraded, never silently mapped.
 */
export function resolveReasoning(
	model: string,
	setting: ReasoningSetting,
	endpoint?: string,
): { readonly ok: true; readonly wire: WireReasoning } | { readonly ok: false; readonly reason: string } {
	if (setting.thinking === "default" && setting.effort === "default") return { ok: true, wire: {} };
	const r = lookupModelMetadata(model, endpoint)?.capabilities.reasoning ?? null;
	if (r === null) {
		return { ok: false, reason: `no reasoning capabilities are known for ${model} — unknown stays unknown; only default/default resolves` };
	}
	const wire: { thinking?: "adaptive" | "enabled" | "disabled"; effort?: string } = {};
	if (setting.thinking !== "default") {
		if (r.thinking === null || !r.thinking.modes.includes(setting.thinking)) {
			const modes = r.thinking === null ? "none known" : r.thinking.modes.join("/");
			return { ok: false, reason: `${model} does not support thinking mode "${setting.thinking}" (native: ${modes})` };
		}
		wire.thinking = setting.thinking;
	}
	if (setting.effort !== "default") {
		if (r.effort === null || !r.effort.levels.includes(setting.effort)) {
			const levels = r.effort === null ? "none known" : r.effort.levels.join("/");
			return { ok: false, reason: `${model} does not support effort "${setting.effort}" (native: ${levels})` };
		}
		wire.effort = setting.effort;
	}
	for (const f of r.forbidden ?? []) {
		if (f.thinking === setting.thinking && f.effort === setting.effort) {
			return { ok: false, reason: `${model} forbids thinking=${setting.thinking} with effort=${setting.effort}` };
		}
	}
	return { ok: true, wire };
}
