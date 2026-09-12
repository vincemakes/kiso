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
	 *  breakpoints (Anthropic); "none" — no caching; "unobservable" — the
	 *  endpoint answers a cache figure that carries no information (OR-10,
	 *  owner 2026-09-09: the ChatGPT backend reports `cached_tokens` 0 to
	 *  a third-party client on every request — three identical 1,922-token
	 *  requests, one prompt_cache_key, 0 at every attribution level — so
	 *  its 0 and "not reported" are one value; a display shows no cache
	 *  meter for such a row, while the record keeps what the backend
	 *  said); null = unknown. */
	readonly promptCaching: "none" | "automatic" | "explicit" | "unobservable" | null;
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
/** `none` is the OpenAI Responses dialect's zero-reasoning level — a NATIVE
 *  value a request carries, distinct from "default" (no field sent).
 *  `ultra` (OR-6) is the vendor CLI presets' top rung for the ChatGPT
 *  backend — native THERE only; the first-party model pages stop at `max`. */
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

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

/** PA-1a: the Anthropic rates as read on 2026-09-07 (base input, output,
 *  cache read = "cache hits and refreshes", cache write = the 5-minute
 *  write). The pricing page notes Sonnet 5's $2/$10 is the standard
 *  price (the announced September increase did not occur). */
const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_MODELS_SOURCE = "https://platform.claude.com/docs/en/models/overview";
const ANTHROPIC_EFFORT_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/effort";
const ANTHROPIC_ASOF = "2026-09-07";
const anthropicPricing = (inputPerM: number, outputPerM: number, cacheReadPerM: number, cacheWritePerM: number): ModelPricing => ({
	inputPerM,
	outputPerM,
	cacheReadPerM,
	cacheWritePerM,
	asOf: ANTHROPIC_ASOF,
	source: ANTHROPIC_PRICING_SOURCE,
});
/** The 5-line's effort control: five native levels, default high, wire
 *  output_config.effort (the effort page, read 2026-09-07). The thinking
 *  table (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)
 *  gives the modes per model. */
const FIVE_LEVELS = { levels: ["low", "medium", "high", "xhigh", "max"] as const, default: "high" as const, wire: "output_config.effort" };
function anthropicLine(): ModelMetadataEntry[] {
	const row = (model: string, capabilities: ModelCapabilities, pricing: ModelPricing): ModelMetadataEntry => ({
		model,
		providerId: "anthropic",
		capabilities,
		capabilitiesAsOf: ANTHROPIC_ASOF,
		capabilitiesSource: ANTHROPIC_MODELS_SOURCE,
		pricing,
	});
	const fiveLine = (thinkingModes: readonly ("adaptive" | "disabled")[], forbidden?: readonly ReasoningSetting[]): ModelCapabilities => ({
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		promptCaching: "explicit",
		reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: thinkingModes, default: "adaptive" },
			effort: FIVE_LEVELS,
			...(forbidden !== undefined ? { forbidden } : {}),
			asOf: ANTHROPIC_ASOF,
			source: ANTHROPIC_EFFORT_SOURCE,
		},
		inputModalities: ["text", "image"],
	});
	const haiku: ModelCapabilities = {
		contextWindow: 200_000,
		maxOutputTokens: 64_000,
		promptCaching: "explicit",
		// Extended thinking only (budget_tokens; adaptive rejected) — the
		// XP-1 setting has no budget axis, so the toggle is not driven;
		// effort: "Not supported" on the models overview. Unknown stays null.
		reasoning: { emitsThinkingStream: true, thinking: null, effort: null, asOf: ANTHROPIC_ASOF, source: ANTHROPIC_EFFORT_SOURCE },
		inputModalities: ["text", "image"],
	};
	const haikuPricing = anthropicPricing(1, 5, 0.1, 1.25);
	return [
		// Fable 5.1: adaptive only, ALWAYS on — "enabled" and "disabled" both 400.
		row("claude-fable-5-1", fiveLine(["adaptive"]), anthropicPricing(10, 50, 0.25, 12.5)),
		// Opus 5: adaptive, on by default; "disabled" accepted at effort high
		// or below — with xhigh or max it is a 400 (the forbidden pair).
		row("claude-opus-5", fiveLine(["adaptive", "disabled"], [{ thinking: "disabled", effort: "xhigh" }, { thinking: "disabled", effort: "max" }]), anthropicPricing(5, 25, 0.5, 6.25)),
		// Sonnet 5: adaptive, on by default; "disabled" accepted.
		row("claude-sonnet-5", fiveLine(["adaptive", "disabled"]), anthropicPricing(2, 10, 0.2, 2.5)),
		// Haiku 4.5: the pinned id and its alias (the registry matches exact ids).
		row("claude-haiku-4-5-20251001", haiku, haikuPricing),
		row("claude-haiku-4-5", haiku, haikuPricing),
	];
}

const OPENAI_MODELS_ASOF = "2026-09-08";
/** the vendor CLI's per-model presets, pinned (the levels it offers a
 *  subscription; a first-party model page says nothing about that backend). */
const CHATGPT_PRESETS_SOURCE = "https://github.com/openai/codex/blob/37f4bb94c9f4e180535a12e3f2c2f93f4a773df0/codex-rs/models-manager/models.json";
const RESPONSES_WIRE = "reasoning.effort";
/** A first-party Responses row: the model page is the source for the
 *  levels, the window, the output cap and the price alike (read the same
 *  day). The adapter asks for no reasoning summaries (encrypted items
 *  only), so no thinking stream is emitted. */
type NativeEffort = Exclude<ReasoningEffort, "default">;
/** OR-6: a row may name its own levels and read date; the 5.5/5.4 rows keep
 *  the 2026-09-08 defaults. A default the page does not state stays null. */
type RowOpts = { readonly levels?: readonly NativeEffort[]; readonly asOf?: string };
const openaiRow = (model: string, effortDefault: NativeEffort | null, rate: { readonly inputPerM: number; readonly outputPerM: number; readonly cacheReadPerM: number }, page: string, opts: RowOpts = {}): ModelMetadataEntry => ({
	model,
	providerId: "openai",
	endpoint: "https://api.openai.com",
	capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000, promptCaching: "automatic", reasoning: {
		emitsThinkingStream: false,
		thinking: null,
		effort: { levels: opts.levels ?? ["none", "low", "medium", "high", "xhigh"], default: effortDefault, wire: RESPONSES_WIRE },
		asOf: opts.asOf ?? OPENAI_MODELS_ASOF,
		source: page,
	}, inputModalities: null },
	capabilitiesAsOf: opts.asOf ?? OPENAI_MODELS_ASOF,
	capabilitiesSource: page,
	pricing: { ...rate, cacheWritePerM: 0, asOf: opts.asOf ?? OPENAI_MODELS_ASOF, source: page },
});
/** The subscription backend's row for the same id: the presets' four
 *  levels (no `none`), the presets' context window, no price, and a cache
 *  figure no client can observe (OR-10 — see ModelCapabilities). */
const chatgptRow = (model: string, opts: RowOpts & { readonly default?: NativeEffort; readonly source?: string } = {}): ModelMetadataEntry => ({
	model,
	providerId: "chatgpt",
	endpoint: "https://chatgpt.com",
	capabilities: { contextWindow: 272_000, maxOutputTokens: null, promptCaching: "unobservable", reasoning: {
		emitsThinkingStream: false,
		thinking: null,
		effort: { levels: opts.levels ?? ["low", "medium", "high", "xhigh"], default: opts.default ?? "medium", wire: RESPONSES_WIRE },
		asOf: opts.asOf ?? OPENAI_MODELS_ASOF,
		source: opts.source ?? CHATGPT_PRESETS_SOURCE,
	}, inputModalities: null },
	capabilitiesAsOf: opts.asOf ?? OPENAI_MODELS_ASOF,
	capabilitiesSource: opts.source ?? CHATGPT_PRESETS_SOURCE,
	pricing: null,
});
/** OR-6 (2026-09-09): the newer line, read the same day — the model pages for
 *  the first-party rows, the presets pinned to a later commit for the
 *  subscription rows (both ids answered on the backend that day). */
const OPENAI_MODELS_ASOF_2 = "2026-09-09";
const CHATGPT_PRESETS_SOURCE_2 = "https://github.com/openai/codex/blob/634ebc1865c6ac840ed3ba118f040d527bf4b55d/codex-rs/models-manager/models.json";
const ULTRA_LADDER: readonly NativeEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

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
	// PA-1a (2026-09-07): the Anthropic first-party line, read from the live
	// docs that day — the models overview (ids, context, max output,
	// modalities, thinking type, default effort), the thinking table
	// (accepted / rejected thinking.type per model, the Opus 5 forbidden
	// pair), the effort page (levels), the pricing page (rates). Each row
	// carries the dates; nothing here is from memory. Extended thinking
	// (`enabled` + budget_tokens) is registered for NO model: the 5-line
	// rejects it, and Haiku 4.5's manual-budget mode has no axis in the
	// XP-1 setting — recorded as `thinking: null` on that row, never guessed.
	...anthropicLine(),
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
		// Astra F5: THE VENDOR'S CURRENT RECOMMENDED NAME, registered so that
		// copying it out of the vendor's own docs does not silently cost the
		// effort controls. `deepseek-flash` had no row, and an unregistered
		// model resolves default/default to an empty wire setting while
		// REFUSING any explicit level by name — correct behaviour (unknown
		// stays unknown) reached for the wrong reason: the model is known,
		// the registry just had not been told its current name.
		//
		// The legacy alias is RETAINED above, not replaced: the vendor still
		// accepts it and routes both to the same weights, so removing it
		// would break configs that work today.
		//
		// SAME capabilities as the legacy row, deliberately. The vendor's
		// page lists a 1M context window, and a window read off a page is not
		// a measurement — it would make the meter claim precision the product
		// has not earned, on the row that decides when context relief fires.
		// contextWindow stays null, the CLI's conservative fallback applies,
		// and the override is documented. Pricing likewise stays null: no
		// price is invented for a name.
		model: "deepseek-flash",
		providerId: "deepseek",
		endpoint: "https://api.deepseek.com",
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			effort: { levels: ["low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-09-12",
			source: "https://api-docs.deepseek.com/quick_start/pricing/",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-09-12",
		capabilitiesSource: "https://api-docs.deepseek.com/quick_start/pricing/",
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
	// OR-1 (2026-09-08): the Responses-dialect rows. The SAME model id gets
	// TWO rows because it answers differently at each endpoint: the
	// first-party API documents `none` and a per-token price; the
	// subscription backend is paid by the subscription (pricing: null — a
	// first-party rate must never be shown as if it were the bill) and
	// offers the levels the vendor's own CLI presets list, pinned to a
	// commit. The first-party row is listed FIRST on purpose: an
	// endpoint-less lookup (a caller with no baseUrl — a direct-write
	// profile, the faux path) resolves to it, and its levels are a
	// superset of the subscription row's. The run-side resolver passes
	// the binding's endpoint (the second OR-1 review), so this ordering
	// is the endpoint-less FALLBACK, not the guard that keeps a
	// subscription run from carrying a level its backend lacks.
	openaiRow("gpt-5.5", "medium", { inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 }, "https://developers.openai.com/api/docs/models/gpt-5.5"),
	openaiRow("gpt-5.4", "none", { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 }, "https://developers.openai.com/api/docs/models/gpt-5.4"),
	chatgptRow("gpt-5.5"),
	chatgptRow("gpt-5.4"),
	// OR-6 (2026-09-09): gpt-6-astra and gpt-5.6-sol. The astra page names
	// no default, so the first-party default stays null (unknown is null);
	// the presets say `low` at the subscription. `ultra` exists only there.
	// The ordering keeps the first-party row first for endpoint-less
	// callers; the run-side resolver passes the endpoint (45a9df5), so the
	// two rows need not be nested — astra's subscription row has a level
	// (ultra) its first-party row lacks.
	openaiRow("gpt-6-astra", null, { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 }, "https://developers.openai.com/api/docs/models/gpt-6-astra", { levels: ["low", "medium", "high", "xhigh", "max"], asOf: OPENAI_MODELS_ASOF_2 }),
	openaiRow("gpt-5.6-sol", "medium", { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4 }, "https://developers.openai.com/api/docs/models/gpt-5.6-sol", { levels: ["none", "low", "medium", "high", "xhigh", "max"], asOf: OPENAI_MODELS_ASOF_2 }),
	chatgptRow("gpt-6-astra", { levels: ULTRA_LADDER, default: "low", source: CHATGPT_PRESETS_SOURCE_2, asOf: OPENAI_MODELS_ASOF_2 }),
	chatgptRow("gpt-5.6-sol", { levels: ULTRA_LADDER, default: "low", source: CHATGPT_PRESETS_SOURCE_2, asOf: OPENAI_MODELS_ASOF_2 }),
	// The compat table's SECOND row (roadmap R3.2 §1a step 1): GLM 5.3 Flash
	// through OpenRouter, read from OpenRouter's models API on 2026-09-09. The
	// id is OpenRouter's, so the row is keyed to that origin; the
	// continuation scope stamps such a profile `custom` at openrouter.ai
	// (manifest.ts's KNOWN_ORIGINS is deliberately not widened — the scope
	// identity is a durable fact and this row needs only the lookup). The
	// window is the TOP provider's (1,048,576), not the listing's 1,310,720:
	// what a request actually gets. No default effort — the page states
	// none. `reasoning_effort` is in the model's supported parameters; the
	// stream's think arrives as `reasoning` (GLM-F1, the compat adapter).
	{
		model: "z-ai/glm-5.3-flash",
		endpoint: "https://openrouter.ai",
		capabilities: {
			contextWindow: 1_048_576,
			maxOutputTokens: 131_072,
			promptCaching: "automatic",
			reasoning: {
				emitsThinkingStream: true,
				thinking: null,
				effort: { levels: ["low", "medium", "high"], default: null, wire: "reasoning_effort" },
				asOf: "2026-09-09",
				source: "https://openrouter.ai/docs/use-cases/reasoning-tokens",
			},
			inputModalities: null,
		},
		capabilitiesAsOf: "2026-09-09",
		capabilitiesSource: "https://openrouter.ai/api/v1/models",
		pricing: { inputPerM: 0.075, outputPerM: 0.25, cacheReadPerM: 0.015, cacheWritePerM: 0, asOf: "2026-09-09", source: "https://openrouter.ai/api/v1/models" },
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
