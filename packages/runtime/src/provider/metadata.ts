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

import { OPENROUTER_ROWS } from "./openrouter-rows.js";

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
		/** a route that SPELLS a level differently on the wire (Command Code
		 *  takes `off` for no reasoning, and refuses `none`): the level a
		 *  person picks stays the native name, the wire carries the route's
		 *  word. Absent = every level goes as named. */
		readonly values?: Readonly<Partial<Record<Exclude<ReasoningEffort, "default">, string>>>;
		/** the levels came from the USER's profile, not from a dated source:
		 *  a claim of theirs, shown as such (the profile's `contextWindow` is
		 *  the same kind of claim). Absent on every registry row. */
		readonly declared?: true;
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

/**
 * REG-1 — the OFF-PEAK rates, read from the vendor's pricing table on
 * 2026-09-17. The table carries TWO sets: off-peak and peak, the peak
 * rates exactly double, and peak is 01:00-04:00 and 06:00-10:00 UTC
 * Mon-Fri. `ModelPricing` has one set of rates and no period, so the
 * OFF-PEAK numbers are the row's and the doubling is stated here rather
 * than by inventing a field the type does not have. A bill computed from
 * this row during peak hours is half the truth, and that is the honest
 * shape of a one-rate type against a two-rate vendor.
 */
const DEEPSEEK_FLASH_PRICING: ModelPricing = {
	inputPerM: 0.15,
	outputPerM: 0.6,
	cacheReadPerM: 0.003,
	cacheWritePerM: 0,
	asOf: "2026-09-17",
	source: "https://api-docs.deepseek.com/quick_start/pricing/",
};

const DEEPSEEK_PRO_PRICING: ModelPricing = {
	inputPerM: 0.66,
	outputPerM: 1.98,
	cacheReadPerM: 0.022,
	cacheWritePerM: 0,
	asOf: "2026-09-17",
	source: "https://api-docs.deepseek.com/quick_start/pricing/",
};

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
/** The 5.5 line (Opus 5.5, Sonnet 5.5, Haiku 5.5): the models overview, the
 *  effort page, the thinking table and the pricing page, all read 2026-10-17. */
const ANTHROPIC_ASOF_55 = "2026-10-17";
const ANTHROPIC_THINKING_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting";
const anthropicPricing = (inputPerM: number, outputPerM: number, cacheReadPerM: number, cacheWritePerM: number, asOf: string = ANTHROPIC_ASOF): ModelPricing => ({
	inputPerM,
	outputPerM,
	cacheReadPerM,
	cacheWritePerM,
	asOf,
	source: ANTHROPIC_PRICING_SOURCE,
});
/** The 5-line's effort control: five native levels, default high, wire
 *  output_config.effort (the effort page, read 2026-09-07). The thinking
 *  table (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)
 *  gives the modes per model. */
const FIVE_LEVELS = { levels: ["low", "medium", "high", "xhigh", "max"] as const, default: "high" as const, wire: "output_config.effort" };
function anthropicLine(): ModelMetadataEntry[] {
	const row = (model: string, capabilities: ModelCapabilities, pricing: ModelPricing, asOf: string = ANTHROPIC_ASOF): ModelMetadataEntry => ({
		model,
		providerId: "anthropic",
		capabilities,
		capabilitiesAsOf: asOf,
		capabilitiesSource: ANTHROPIC_MODELS_SOURCE,
		pricing,
	});
	const fiveLine = (thinkingModes: readonly ("adaptive" | "disabled")[], forbidden?: readonly ReasoningSetting[], opts: { readonly effortDefault?: "medium" | "high"; readonly asOf?: string } = {}): ModelCapabilities => ({
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		promptCaching: "explicit",
		reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: thinkingModes, default: "adaptive" },
			effort: opts.effortDefault === undefined ? FIVE_LEVELS : { ...FIVE_LEVELS, default: opts.effortDefault },
			...(forbidden !== undefined ? { forbidden } : {}),
			asOf: opts.asOf ?? ANTHROPIC_ASOF,
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
		// The 5.5 line (read 2026-10-17; every model id is its own pinned
		// snapshot, so there is no dated alias). All three: 1M window, 128K
		// output, five native effort levels, wire output_config.effort.
		//
		// Opus 5.5: adaptive ALWAYS on ("disabled" is a 400 at every level);
		// the default effort is MEDIUM, one below Opus 5's. Cache hits cost 5%
		// of input.
		row("claude-opus-5-5", fiveLine(["adaptive"], undefined, { effortDefault: "medium", asOf: ANTHROPIC_ASOF_55 }), anthropicPricing(4, 20, 0.2, 5, ANTHROPIC_ASOF_55), ANTHROPIC_ASOF_55),
		// Sonnet 5.5: adaptive, on by default. "disabled" is a 400 at every
		// level; the vendor's own off switch is the new thinking type
		// `between_tools` (accepted only here, only at effort high or below),
		// which the registry's thinking vocabulary does not have, so it is
		// not offered. Default effort high. Cache hits cost 5% of input.
		row("claude-sonnet-5-5", fiveLine(["adaptive"], undefined, { asOf: ANTHROPIC_ASOF_55 }), anthropicPricing(2, 10, 0.1, 2.5, ANTHROPIC_ASOF_55), ANTHROPIC_ASOF_55),
		// Haiku 5.5: adaptive, on by default; "disabled" accepted at effort
		// high or below, a 400 with xhigh or max (the forbidden pair). Default
		// effort medium. PRICE: the vendor prices by PROMPT LENGTH. The row
		// carries the rates for prompts up to 100,000 tokens; a prompt over
		// that pays $0.50 in / $2.50 out / $0.05 cache read / $0.625 cache
		// write, five times the row. ModelPricing has one set of rates, so a
		// bill computed from this row for a long prompt is a fifth of the
		// truth: the one-rate-against-two-rates shape the DeepSeek peak
		// rates already have.
		row("claude-haiku-5-5", fiveLine(["adaptive", "disabled"], [{ thinking: "disabled", effort: "xhigh" }, { thinking: "disabled", effort: "max" }], { effortDefault: "medium", asOf: ANTHROPIC_ASOF_55 }), anthropicPricing(0.1, 0.5, 0.01, 0.125, ANTHROPIC_ASOF_55), ANTHROPIC_ASOF_55),
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
const openaiRow = (model: string, effortDefault: NativeEffort | null, rate: { readonly inputPerM: number; readonly outputPerM: number; readonly cacheReadPerM: number; readonly cacheWritePerM?: number }, page: string, opts: RowOpts = {}): ModelMetadataEntry => ({
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
	pricing: { ...rate, cacheWritePerM: rate.cacheWritePerM ?? 0, asOf: opts.asOf ?? OPENAI_MODELS_ASOF, source: page },
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
/** 0.48.0 (finding 0473-F2): the presets at a later commit, read 2026-10-09.
 *  The owner's `sol` profile moved to `gpt-6.1-sol` on 2026-10-08, and with
 *  no row kiso sent it no effort: the remembered `high` never reached the
 *  wire and no reasoning summary came back. The id answered on the
 *  subscription backend that night (the 0.47.3 live sessions). The
 *  first-party row was added 2026-10-17 (OPENAI_MODELS_ASOF_4). */
const OPENAI_MODELS_ASOF_3 = "2026-10-09";
const CHATGPT_PRESETS_SOURCE_3 = "https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/models-manager/models.json";
/** The first-party pages for the GPT-6.1 / GPT-6 sol and luna rows, read
 *  2026-10-17 (the model page is the source for the levels, the window, the
 *  output cap and the price alike, as for every first-party row). */
const OPENAI_MODELS_ASOF_4 = "2026-10-17";

/** The v1 table. Nulls outnumber numbers ON PURPOSE: only values with a
 *  named source enter; everything else waits for one. */
/** Command Code: what the gateway ACCEPTS (probe, 2026-10-17) intersected with
 *  each model's native levels; `none` is spelled `off` on this route. */
const COMMAND_CODE_EFFORT_SOURCE = "probe 2026-10-17: POST https://api.commandcode.ai/provider/v1/chat/completions with a sentinel reasoning_effort names the legal set; native levels per model: the first-party deepseek-flash row and https://openrouter.ai/api/v1/models";
const COMMAND_CODE_EFFORT: Readonly<Record<"deepseek/deepseek-v4.1-flash" | "z-ai/glm-5.3-flash" | "xai/grok-4.7", NonNullable<ReasoningCapabilities["effort"]>>> = {
	"deepseek/deepseek-v4.1-flash": { levels: ["none", "low", "high", "max"], default: "high", wire: "reasoning_effort", values: { none: "off" } },
	"z-ai/glm-5.3-flash": { levels: ["low", "high", "max"], default: null, wire: "reasoning_effort" },
	"xai/grok-4.7": { levels: ["low", "medium", "high", "xhigh"], default: null, wire: "reasoning_effort" },
};

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
		// REG-1: RETIRED, and the vendor says so in footnote (1) of the
		// pricing table: "The legacy names deepseek-v4-flash and
		// deepseek-v4-flash-vision-exp are still accepted, but the
		// corresponding models have been retired, their requests are served
		// by the DeepSeek-V4.1-Flash model and billed at the Flash price."
		// Still accepted is not still supported: a config naming it works
		// today on borrowed time, which is why the row stays (removing it
		// would break configs that run) and is marked (so the product can
		// say the word it has the evidence for).
		deprecated: { asOf: "2026-09-17", source: "https://api-docs.deepseek.com/quick_start/pricing/" },
		endpoint: "https://api.deepseek.com",
		// REG-1: the window and max output are READ from the vendor's pricing
		// table — "CONTEXT LENGTH 1M", "MAX OUTPUT MAXIMUM: 384K". The date
		// and page live in `capabilitiesAsOf` / `capabilitiesSource`, which
		// exist for exactly this; the reasoning block carries its own pair
		// and already cited the same page. A dated vendor
		// statement is this registry's contract and every other row lives on
		// it; holding DeepSeek to a stricter "nobody measured it" standard
		// left the window null, and a null window sends the CLI to its
		// 200,000 fallback — so the product compacted a 1M model at 100,000
		// tokens, a tenth of its capacity, while sounding principled.
		capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			// `none` added 2026-09-14 from a live probe. The three natives were
			// RIGHT and stay: the endpoint's enum accepts seven values, but
			// the vendor maps minimal->low, medium->high and xhigh->high, so
			// those three are the provider's own aliases and this row's rule
			// is that an alias is never shown as native. Offering `medium`
			// would promise a level the model does not have.
			//
			// `none` is not an alias. It turns thinking OFF: the response
			// carries no reasoning_content and completion_tokens_details is
			// null outright. A distinct behaviour the row simply lacked, and
			// the only reachable way to buy no reasoning at all.
			//
			// Measured, 12 runs per level on one task (median reasoning
			// tokens): minimal 191, low 186 | medium 212, high 199, xhigh 195
			// | max 229. The grouping and the ordering match the vendor's
			// mapping. The unset default sits at 219, which this sample
			// cannot separate from high or from max, so `default` stays what
			// the vendor documents rather than what one task suggests.
			//
			// bench/probe-effort-levels.mjs reads the accepted set from the
			// endpoint's own refusal and costs nothing.
			effort: { levels: ["none", "low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-08-26",
			source: "https://api-docs.deepseek.com/guides/thinking_mode",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-09-17",
		capabilitiesSource: "https://api-docs.deepseek.com/quick_start/pricing/",
		pricing: DEEPSEEK_FLASH_PRICING,
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
		// REG-1: the window and max output are READ from the vendor's pricing
		// table — "CONTEXT LENGTH 1M", "MAX OUTPUT MAXIMUM: 384K". The date
		// and page live in `capabilitiesAsOf` / `capabilitiesSource`, which
		// exist for exactly this; the reasoning block carries its own pair
		// and already cited the same page. A dated vendor
		// statement is this registry's contract and every other row lives on
		// it; holding DeepSeek to a stricter "nobody measured it" standard
		// left the window null, and a null window sends the CLI to its
		// 200,000 fallback — so the product compacted a 1M model at 100,000
		// tokens, a tenth of its capacity, while sounding principled.
		capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			// `none` added 2026-09-14 from a live probe. The three natives were
			// RIGHT and stay: the endpoint's enum accepts seven values, but
			// the vendor maps minimal->low, medium->high and xhigh->high, so
			// those three are the provider's own aliases and this row's rule
			// is that an alias is never shown as native. Offering `medium`
			// would promise a level the model does not have.
			//
			// `none` is not an alias. It turns thinking OFF: the response
			// carries no reasoning_content and completion_tokens_details is
			// null outright. A distinct behaviour the row simply lacked, and
			// the only reachable way to buy no reasoning at all.
			//
			// Measured, 12 runs per level on one task (median reasoning
			// tokens): minimal 191, low 186 | medium 212, high 199, xhigh 195
			// | max 229. The grouping and the ordering match the vendor's
			// mapping. The unset default sits at 219, which this sample
			// cannot separate from high or from max, so `default` stays what
			// the vendor documents rather than what one task suggests.
			//
			// bench/probe-effort-levels.mjs reads the accepted set from the
			// endpoint's own refusal and costs nothing.
			effort: { levels: ["none", "low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-09-12",
			source: "https://api-docs.deepseek.com/quick_start/pricing/",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-09-17",
		capabilitiesSource: "https://api-docs.deepseek.com/quick_start/pricing/",
		pricing: DEEPSEEK_FLASH_PRICING,
	},
	{
		model: "deepseek-v4-pro",
		providerId: "deepseek",
		endpoint: "https://api.deepseek.com",
		// REG-1: the window and max output are READ from the vendor's pricing
		// table — "CONTEXT LENGTH 1M", "MAX OUTPUT MAXIMUM: 384K". The date
		// and page live in `capabilitiesAsOf` / `capabilitiesSource`, which
		// exist for exactly this; the reasoning block carries its own pair
		// and already cited the same page. A dated vendor
		// statement is this registry's contract and every other row lives on
		// it; holding DeepSeek to a stricter "nobody measured it" standard
		// left the window null, and a null window sends the CLI to its
		// 200,000 fallback — so the product compacted a 1M model at 100,000
		// tokens, a tenth of its capacity, while sounding principled.
		capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, promptCaching: "automatic", reasoning: {
			emitsThinkingStream: true,
			thinking: { modes: ["enabled", "disabled"], default: "enabled" },
			// `none` added 2026-09-14 from a live probe. The three natives were
			// RIGHT and stay: the endpoint's enum accepts seven values, but
			// the vendor maps minimal->low, medium->high and xhigh->high, so
			// those three are the provider's own aliases and this row's rule
			// is that an alias is never shown as native. Offering `medium`
			// would promise a level the model does not have.
			//
			// `none` is not an alias. It turns thinking OFF: the response
			// carries no reasoning_content and completion_tokens_details is
			// null outright. A distinct behaviour the row simply lacked, and
			// the only reachable way to buy no reasoning at all.
			//
			// Measured, 12 runs per level on one task (median reasoning
			// tokens): minimal 191, low 186 | medium 212, high 199, xhigh 195
			// | max 229. The grouping and the ordering match the vendor's
			// mapping. The unset default sits at 219, which this sample
			// cannot separate from high or from max, so `default` stays what
			// the vendor documents rather than what one task suggests.
			//
			// bench/probe-effort-levels.mjs reads the accepted set from the
			// endpoint's own refusal and costs nothing.
			effort: { levels: ["none", "low", "high", "max"], default: "high", wire: "reasoning_effort" },
			asOf: "2026-08-26",
			source: "https://api-docs.deepseek.com/guides/thinking_mode",
		}, inputModalities: null },
		capabilitiesAsOf: "2026-09-17",
		capabilitiesSource: "https://api-docs.deepseek.com/quick_start/pricing/",
		pricing: DEEPSEEK_PRO_PRICING,
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
	chatgptRow("gpt-6.1-sol", { levels: ULTRA_LADDER, default: "low", source: CHATGPT_PRESETS_SOURCE_3, asOf: OPENAI_MODELS_ASOF_3 }),
	// 2026-10-17: the first-party rows the 0.48.0 note said were missing
	// ("no model page was read for it"). gpt-6.1-sol: five levels, and the
	// page says `none` and `minimal` are not supported; default medium.
	// gpt-6-sol and gpt-6-luna: `none` through `max`, default medium.
	// PRICE: each page also lists a LONG-PROMPT tier: a prompt over 272,000
	// input tokens pays 2x the input and cache rates and 1.5x the output
	// rate for the whole request. The rows carry the standard rates; a bill
	// computed from them for a long prompt is low (the one-rate-against-
	// two-rates shape the DeepSeek peak rates already have). Cache writes
	// are priced on these pages and carried (sol $2.50, luna $0.125).
	openaiRow("gpt-6.1-sol", "medium", { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 }, "https://developers.openai.com/api/docs/models/gpt-6.1-sol", { levels: ["low", "medium", "high", "xhigh", "max"], asOf: OPENAI_MODELS_ASOF_4 }),
	openaiRow("gpt-6-sol", "medium", { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 }, "https://developers.openai.com/api/docs/models/gpt-6-sol", { levels: ["none", "low", "medium", "high", "xhigh", "max"], asOf: OPENAI_MODELS_ASOF_4 }),
	openaiRow("gpt-6-luna", "medium", { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 }, "https://developers.openai.com/api/docs/models/gpt-6-luna", { levels: ["none", "low", "medium", "high", "xhigh", "max"], asOf: OPENAI_MODELS_ASOF_4 }),
	// The OpenRouter route (origin https://openrouter.ai): generated from
	// OpenRouter's own model list by scripts/registry-or-rows.mjs and kept in
	// openrouter-rows.ts, dated 2026-10-17. It replaces the hand-written
	// z-ai/glm-5.3-flash row of 2026-09-09 (roadmap R3.2 §1a step 1), which
	// the list has since moved past: the efforts are now max / high / low.
	...OPENROUTER_ROWS,
	// The Command Code gateway (origin https://api.commandcode.ai), read by a
	// PROBE on 2026-10-17: a chat completion with a nonsense reasoning_effort
	// and max_tokens 1 is refused before generation and the 400 names the
	// legal set, `off | low | medium | high | xhigh | max`. That enum belongs
	// to the gateway, not to a model: the same list came back for every model
	// probed. So a row here offers the INTERSECTION of that set with the
	// model's own native levels. `none` goes on the wire as `off`: the gateway
	// refuses `none` (400, probed the same day) and accepts `off` (200). Each
	// model's native levels: deepseek from the first-party deepseek-flash row
	// (live-probed 2026-09-14); glm and grok from OpenRouter's list, which is
	// a router's statement and is named as such in `source`. Mimo has no
	// stated efforts anywhere, so it has no row: unknown stays unknown. No
	// default, window, output cap or price is claimed here: the window falls
	// to the model's identity row, and the gateway's plan has no per-token
	// price.
	...(["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "xai/grok-4.7"] as const).map((model): ModelMetadataEntry => ({
		model,
		endpoint: "https://api.commandcode.ai",
		capabilities: {
			contextWindow: null,
			maxOutputTokens: null,
			promptCaching: null,
			reasoning: {
				emitsThinkingStream: null,
				thinking: null,
				effort: COMMAND_CODE_EFFORT[model],
				asOf: "2026-10-17",
				source: COMMAND_CODE_EFFORT_SOURCE,
			},
			inputModalities: null,
		},
		capabilitiesAsOf: "2026-10-17",
		capabilitiesSource: COMMAND_CODE_EFFORT_SOURCE,
		pricing: null,
	})),
];

/** Every row of the table, for the gate that holds the whole table to its
 *  contract (shape, dates, sources, unique keys). Internal; read-only. */
export function modelMetadataRows(): readonly ModelMetadataEntry[] {
	return ENTRIES;
}

/**
 * Look a model up. `endpoint` narrows: an entry WITH an endpoint only
 * matches when the caller's endpoint origin equals it; an entry without
 * one matches any endpoint. Unknown model → null, never a default.
 */
export function lookupModelMetadata(model: string, endpoint?: string): ModelMetadataEntry | null {
	const base = lookupRegistryRow(model, endpoint);
	const declared = DECLARED_EFFORT.get(declarationKey(model, endpoint));
	if (declared === undefined) return base;
	// a profile's declaration wins over the registry's effort for that
	// (model, endpoint); the rest of the row (window, price, thinking modes)
	// stays the registry's, and a model the registry does not know becomes a
	// row that claims nothing but the declared levels
	const reasoning: ReasoningCapabilities = {
		emitsThinkingStream: base?.capabilities.reasoning?.emitsThinkingStream ?? null,
		thinking: base?.capabilities.reasoning?.thinking ?? null,
		effort: declared,
		...(base?.capabilities.reasoning?.forbidden !== undefined ? { forbidden: base.capabilities.reasoning.forbidden } : {}),
		asOf: null,
		source: "declared in the profile",
	};
	if (base !== null) return { ...base, capabilities: { ...base.capabilities, reasoning } };
	return {
		model,
		...(endpoint !== undefined ? { endpoint: originOf(endpoint) } : {}),
		capabilities: { contextWindow: null, maxOutputTokens: null, promptCaching: null, reasoning, inputModalities: null },
		pricing: null,
	};
}

function lookupRegistryRow(model: string, endpoint?: string): ModelMetadataEntry | null {
	for (const entry of ENTRIES) {
		if (entry.model !== model) continue;
		if (entry.endpoint !== undefined && endpoint !== undefined && entry.endpoint !== originOf(endpoint)) continue;
		return entry;
	}
	return null;
}

/** A profile's own effort levels (the CLI reads them from the user's config
 *  at startup). Keyed by (model, endpoint origin); a later declaration for
 *  the same key replaces the earlier. Process-wide, like the table. */
const DECLARED_EFFORT = new Map<string, NonNullable<ReasoningCapabilities["effort"]>>();
const declarationKey = (model: string, endpoint?: string): string => `${model}@${endpoint === undefined ? "" : originOf(endpoint)}`;

export function declareEffort(model: string, endpoint: string | undefined, effort: Omit<NonNullable<ReasoningCapabilities["effort"]>, "declared" | "wire"> & { readonly wire?: string }): void {
	DECLARED_EFFORT.set(declarationKey(model, endpoint), { ...effort, wire: effort.wire ?? "reasoning_effort", declared: true });
}

/** For tests and a config reload: forget every declaration. */
export function clearDeclaredEfforts(): void {
	DECLARED_EFFORT.clear();
}

/**
 * CW-1 — names one set of weights answers to across routes, each a dated
 * vendor statement. The key is the FOLDED name a route serves (vendor
 * prefix off, lower case); the value names the registry row.
 */
const MODEL_ALIASES: Readonly<Record<string, { readonly is: string; readonly asOf: string; readonly source: string }>> = {
	// The pricing table: `deepseek-flash` IS DeepSeek-V4.1-Flash. Gateways
	// serve it by the version name (`deepseek-v4.1-flash`).
	"deepseek-v4.1-flash": { is: "deepseek-flash", asOf: "2026-09-17", source: "https://api-docs.deepseek.com/quick_start/pricing/" },
	// OpenRouter spells the 5.5 line with a dot; the vendor's ids carry dashes
	// (the models overview, read 2026-10-17). Same weights.
	"claude-opus-5.5": { is: "claude-opus-5-5", asOf: "2026-10-17", source: "https://platform.claude.com/docs/en/models/overview" },
	"claude-sonnet-5.5": { is: "claude-sonnet-5-5", asOf: "2026-10-17", source: "https://platform.claude.com/docs/en/models/overview" },
	"claude-haiku-5.5": { is: "claude-haiku-5-5", asOf: "2026-10-17", source: "https://platform.claude.com/docs/en/models/overview" },
};

/** CW-1: the aliases, for the gate that holds each one to a dated source
 *  and a registered target. */
export function modelAliases(): Readonly<Record<string, { readonly is: string; readonly asOf: string; readonly source: string }>> {
	return MODEL_ALIASES;
}

/** CW-1: a model id reduced to the weights it names — `deepseek/DeepSeek-V4.1-Flash`
 *  and `deepseek-v4.1-flash` are both `deepseek-flash`. A variant suffix
 *  (`:free`) is NOT folded: a variant may serve a smaller window. */
export function modelIdentity(model: string): string {
	const folded = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
	return MODEL_ALIASES[folded]?.is ?? folded;
}

/** Where a resolved window came from — the source a display names. */
export type ContextWindowSource = "route" | "upstream" | "model";

export interface ResolvedContextWindow {
	readonly tokens: number;
	readonly source: ContextWindowSource;
	/** the registry row's model id the figure was read from */
	readonly from: string;
}

/**
 * CW-1 (owner, 2026-09-23) — the context window for a route the registry
 * has no row for.
 *
 * Rows are keyed by (model, endpoint) because a route can answer
 * differently from the vendor — gpt-5.5 is 1,050,000 at the first-party
 * API and 272,000 at the subscription backend. The same key made every
 * forwarder, relay and gateway a miss: `deepseek-v4.1-flash` behind a local
 * forwarder to a model gateway read `ctx ?`, and the tiers compacted a 1M model
 * against the CLI's 200K fallback. A window belongs to the weights; a
 * route can only cap it lower. In order:
 *
 *   route    — this model's row at this endpoint (lookupModelMetadata);
 *   upstream — its row at the endpoint a forwarder names as its upstream;
 *   model    — every row of the same model identity, at any endpoint;
 *              where rows disagree, the SMALLEST — the one figure no row
 *              contradicts.
 *
 * A null window falls through; after the last step, null. Only the window
 * resolves this way: price, reasoning wire fields and max output are
 * facts about a route and stay on lookupModelMetadata.
 */
export function lookupContextWindow(model: string, endpoint?: string, upstream?: string): ResolvedContextWindow | null {
	const route = lookupModelMetadata(model, endpoint);
	if (route !== null && route.capabilities.contextWindow !== null) return { tokens: route.capabilities.contextWindow, source: "route", from: route.model };
	if (upstream !== undefined) {
		const up = lookupModelMetadata(model, upstream);
		if (up !== null && up.capabilities.contextWindow !== null) return { tokens: up.capabilities.contextWindow, source: "upstream", from: up.model };
	}
	const identity = modelIdentity(model);
	let found: ResolvedContextWindow | null = null;
	for (const entry of ENTRIES) {
		const tokens = entry.capabilities.contextWindow;
		if (tokens === null || modelIdentity(entry.model) !== identity) continue;
		if (found === null || tokens < found.tokens) found = { tokens, source: "model", from: entry.model };
	}
	return found;
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
		wire.effort = r.effort.values?.[setting.effort] ?? setting.effort;
	}
	for (const f of r.forbidden ?? []) {
		if (f.thinking === setting.thinking && f.effort === setting.effort) {
			return { ok: false, reason: `${model} forbids thinking=${setting.thinking} with effort=${setting.effort}` };
		}
	}
	return { ok: true, wire };
}
