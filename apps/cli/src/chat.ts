/**
 * The ergonomics batch B4 (pure move) — the interactive REPL (chat), the run consumer
 * (consumeRun — the single renderer of a run's event stream), the
 * approval-moment mini-diff, the status spinner, and the context
 * estimates. All bodies moved verbatim from index.ts.
 */

import type { SessionRoute } from "./projects.js";
import { readFileSync, statSync } from "node:fs";
import {
	escapeTerminal,
	cacheHitPct,
	decodeRate,
	idleStatus,
	palette,
	renderEvent,
	renderRecap,
	runningStatus,
	toolTarget,
	STATUS_GLYPHS,
	kUnit,
	type PanelArgs,
	type PanelView,
	type RenderInput,
	type RunUsage,
} from "@vincemakes/kiso-tui";
import { askView, coldResumeLine, coldResumeView, deletionRiskHint, editFileDiff, writeFileDiff, type DiffResult, type SaferAnswer, type SaferFailure, type SaferOption } from "@vincemakes/kiso-tui";
import { canonicalTargetPath, isProtectedPath, protectedIdentity, shellProgressPath } from "@vincemakes/kiso-tools-node";
import { mergedConfig, queuedSwitchLines, tasksFor } from "./state.js";
import { taskNoticeRow } from "./task-notice.js";
import { echoText } from "@vincemakes/kiso-tui-cells/render";
import { canonicalizeUsage, RunClosedError } from "@vincemakes/kiso-runtime";
import { canonicalizeUsageForModel, requestBudget } from "@vincemakes/kiso-runtime/internal";
import type { AgentSession, Run } from "@vincemakes/kiso-runtime";
import type { UserInputVia } from "@vincemakes/kiso-core";
import { dispatch, type DispatchCtx, abortBangCommand } from "./dispatch.js";
import { paintWindowTitle } from "./window-title.js";
import { agentBaseUrl, agentModel, body, bodyLog, configuredWindow, dock, retryOnRow, retryShown, setRetryShown, floorOn, protectedFiles, upstreamOf, VERSION, type LineInput } from "./state.js";
import { attachImages } from "./attachments.js";
import { installedVersion, staleVersionNotice } from "./stale-version.js";
import { learnedWindowFor } from "./learned-windows.js";
import { lookupContextWindow, lookupModelMetadata, type ContextWindowSource } from "@vincemakes/kiso-runtime/internal";
import { addDontAskAgainRule, askPanel, fixHintFor, pendingAsk, resolveUncertains } from "./trust-ui.js";
import { FauxExhaustionError, failOnFauxExhaustion } from "./faux-glue.js";
import { MODE_LABEL, OFFERED_MODES, getDontAsk, getMode, modeDisplay, setMode } from "./mode.js";

/** B area: default context window for the ~ctx estimate (config overridable).
 *  CW-1 batch 2: 128,000, down from 200,000 — the figure a model nobody
 *  states a window for is assumed to hold (the reference implementation's
 *  default too). Too small costs an early compaction; too large costs a
 *  refused request on a 128K model. Registered models never reach it. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** The in-process fake provider's id, and the window we declare for it.
 *  Ours to state: faux is not a vendor's model, so "nobody published a
 *  window" — the reason a real model's capacity is unknown — cannot apply.
 *  200,000 is the figure every faux transcript has been measured against
 *  since the fallback existed, so declaring it changes no behaviour; it
 *  only stops an honest `ctx ?` from firing where the honest answer is a
 *  number we own. */
const FAUX_MODEL = "faux";
const FAUX_CONTEXT_WINDOW = 200_000;

/**
 * The ergonomics batch C8 — the /compact auto-trigger, OPT-IN (default off: only an
 * explicit KISO_AUTO_COMPACT=<ratio> enables it — the CLI never defaults
 * it on). After every completed turn the ~ctx ratio is checked; at/over
 * thresholdRatio the /compact full path runs (the same dispatch — same
 * notices, same chain ordering, same mid-run refusal).
 */
export interface AutoCompact {
	/** 0 < r < 1 — the ~ctx ratio that triggers the compaction. */
	readonly thresholdRatio: number;
}

/** Parse KISO_AUTO_COMPACT — an invalid value is OFF, never a crash. */
export function autoCompactFromEnv(): AutoCompact | undefined {
	const raw = process.env.KISO_AUTO_COMPACT;
	if (raw === undefined) return undefined;
	const ratio = Number.parseFloat(raw);
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return undefined;
	return { thresholdRatio: ratio };
}

/**
 * C area: the model window in tokens — env (KISO_CONTEXT_WINDOW) beats the
 * config window (merge round B), both beat the 200k default. The microcompact
 * threshold is derived from it (50%), and the status line's ~ctx estimate
 * is measured against it — one source of truth for the window.
 *
 * CTX-1: with no argument this reads the LIVE binding, which is what every
 * display caller wants. `/model` needs the window of the model it is
 * switching TO, before that binding is live, so it passes the pair
 * explicitly. Reading module state a caller is about to change is how the
 * threshold got stuck in the first place.
 *
 * The argument is a PAIR, never two optional halves: a profile with no
 * `baseUrl` is endpoint-less, and a half-given argument would have it
 * inherit the OUTGOING model's endpoint — the same bug one field over.
 */
/**
 * THE WINDOW SOMEBODY STATED, or null when nobody has.
 *
 * Three sources, in order: the config/profile window, KISO_CONTEXT_WINDOW,
 * and the metadata registry (CW-1: this endpoint's row, the upstream's,
 * then the model's own — see lookupContextWindow). Each is a claim
 * someone made and dated. When
 * none of them speaks, this returns NULL rather than a number — because
 * the question "how much of the window is left" has no answer without a
 * window, and every display that shows a percentage needs this one, not
 * the policy value below.
 *
 * DeepSeek is the live case: its /models endpoint returns ids only, the
 * responses carry no window, and the registry records null on purpose. The
 * display used to divide by a hardcoded 200,000 anyway and print a
 * confident `ctx left ~82%` against a figure nobody had measured.
 */
export function knownContextWindow(of?: { readonly model: string; readonly baseUrl?: string }): number | null {
	return statedContextWindow(of)?.tokens ?? null;
}

/** CW-1: a stated window and WHO stated it — `set` is the user (profile,
 *  config or KISO_CONTEXT_WINDOW), `faux` is ours, the rest are the
 *  registry's steps (lookupContextWindow). */
export interface StatedWindow {
	readonly tokens: number;
	readonly source: "set" | "faux" | "learned" | ContextWindowSource;
	/** the registry row's model id, for the registry's steps */
	readonly from?: string;
	/** CW-1 batch 2: the day an endpoint's refusal stated it, for `learned` */
	readonly observedAt?: string;
}

/** CW-1: `knownContextWindow` with its source — the chain the displays name.
 *  The user's figure is the live binding's unless `own` carries a
 *  profile's: the /model listing passes each row's, and a row with none
 *  must not borrow the live one (`own: { configured: undefined }` — an
 *  optional parameter defaulted to the live value would take it back,
 *  since an explicit undefined selects the default). */
export function statedContextWindow(
	of?: { readonly model: string; readonly baseUrl?: string; readonly upstream?: string },
	own?: { readonly configured: number | undefined },
): StatedWindow | null {
	const configured = own !== undefined ? own.configured : configuredWindow;
	if (configured !== undefined) return { tokens: configured, source: "set" };
	const env = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	if (Number.isFinite(env) && env > 0) return { tokens: env, source: "set" };
	const model = of?.model ?? agentModel;
	// `faux` is OURS. The registry carries no row for it because it is not a
	// vendor's model, but the reason the window is unknown elsewhere — nobody
	// published one — does not apply to a model we wrote. Declaring it is a
	// statement about our own artifact, with ourselves as the source, and it
	// keeps faux mode showing a real percentage instead of the `ctx ?` that
	// belongs to models whose capacity genuinely nobody states.
	if (model === FAUX_MODEL) return { tokens: FAUX_CONTEXT_WINDOW, source: "faux" };
	const baseUrl = of !== undefined ? of.baseUrl : agentBaseUrl;
	// CW-1 batch 2: what this endpoint's own refusal stated, before any
	// statement about the model — a measurement of the route.
	const learned = learnedWindowFor(model, baseUrl);
	if (learned !== undefined) return { tokens: learned.tokens, source: "learned", observedAt: learned.observedAt };
	return lookupContextWindow(model, baseUrl, of?.upstream ?? upstreamOf(baseUrl));
}

/** CW-1: a window as the displays write it — `1M`, `1.05M`, `272K`,
 *  `1,048,576` (a figure that is not round is shown whole). */
export function windowLabel(tokens: number): string {
	if (tokens >= 1_000_000 && tokens % 10_000 === 0) return `${tokens / 1_000_000}M`;
	if (tokens % 1000 === 0) return `${tokens / 1000}K`;
	return tokens.toLocaleString("en-US");
}

/** CW-1: the window and its source, said — /status's line (0.40.6: the
 *  short form that rode each /model row is gone with its caller). */
export function windowSourceNote(w: StatedWindow | null): string {
	if (w === null) return `window unknown — compaction assumes ${windowLabel(DEFAULT_CONTEXT_WINDOW)}; set contextWindow on the profile to state it`;
	const size = windowLabel(w.tokens);
	switch (w.source) {
		case "set":
			return `window ${size}, as you set it`;
		case "faux":
			return `window ${size} (faux)`;
		case "learned":
			return `window ${size}, learned from this endpoint's refusal (${w.observedAt ?? "date unknown"})`;
		case "route":
			return `window ${size}, the registry's for this endpoint`;
		case "upstream":
			return `window ${size}, the registry's for the upstream`;
		case "model":
			return `window ${size}, inferred from the model (${w.from}) — not stated for this endpoint`;
	}
}

export function contextWindowTokens(of?: { readonly model: string; readonly baseUrl?: string }): number {
	const windowOverride = configuredWindow;
	if (windowOverride !== undefined) return windowOverride;
	const window = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	if (Number.isFinite(window) && window > 0) return window;
	// PH-1c (finding PH-F15): the window follows the LIVE model when the
	// metadata registry knows it — /model to a known model moves the
	// window without an env var. The default argument is the same live
	// binding the status row shows; an unknown model keeps the 200k
	// default — the registry never guesses, so neither do we. OR-1: the
	// ENDPOINT narrows the row — gpt-5.5 is 1,050,000 at the first-party
	// API and 272,000 at the subscription backend; the two are set
	// together (setAgentModel).
	//
	// CTX-1 erratum: this comment used to add "(and the microcompact
	// threshold derived from it)". The window moved; the threshold did
	// not — it was computed once at startup and the switch path never
	// asked again. The claim is true now because the switch path calls
	// `microcompactThresholdFor` below, not because deriving a number
	// from this function makes anything follow it.
	//
	// CW-1: the registry's steps are lookupContextWindow's — the route's row,
	// the upstream's, then the model's own identity — the same chain
	// `statedContextWindow` names for the displays.
	const baseUrl = of !== undefined ? of.baseUrl : agentBaseUrl;
	// CW-1 batch 2: faux is declared here too — it read the old 200K
	// fallback by accident, and the fallback moving must not move it.
	if ((of?.model ?? agentModel) === FAUX_MODEL) return FAUX_CONTEXT_WINDOW;
	const learned = learnedWindowFor(of?.model ?? agentModel, baseUrl);
	if (learned !== undefined) return learned.tokens;
	const known = lookupContextWindow(of?.model ?? agentModel, baseUrl, upstreamOf(baseUrl));
	if (known !== null) return known.tokens;
	return DEFAULT_CONTEXT_WINDOW;
}

/**
 * CTX-1: THE ONE derivation of the compaction threshold from the window.
 *
 * Startup (`index.ts`) and the `/model` switch (`dispatch.ts`) both need
 * this number, and two call sites computing the same thing is how
 * `promptCacheKey` drifted before `adapterOptionsFor` collected it. The
 * policy — half the window — lives here and nowhere else.
 *
 * CAPACITY is not POLICY. The window is what the model can hold; this is
 * when we choose to clear old tool results. They are 2:1 today because
 * that ratio has never been measured, not because it is derived from
 * anything. Moving the policy means changing this line, and the whole
 * product moves with it.
 */
export function microcompactThresholdFor(of?: { readonly model: string; readonly baseUrl?: string }): number {
	return contextWindowTokens(of) / 2;
}

/**
 * B area: approximate context ratio vs the model window. Marked ~
 * everywhere it is shown. 0.40.0: the context as the last bill measured it
 * (session.contextUsed — the estimate only when no bill describes it);
 * chars/4 alone read the owner's 730k Chinese-heavy context as ~470k.
 */
export function estimateCtxRatio(session: AgentSession): number {
	return session.contextUsed() / contextWindowTokens();
}

/** A1a: the ratio the STATUS LINE and the ctx displays show — the request
 *  budget counting the parts (system prompt, tool table, messages with
 *  their continuation envelopes, the output reserve when known) over the
 *  window. Still ~ (chars/4). The auto-compact policy does NOT read this
 *  (see autoCompactRatio) — moving the policy's number is A1b's. */
/** OR-8 (owner, 2026-09-09): the status row names the effort next to the
 *  model — `gpt-5.6-sol · xhigh` — whenever the live binding carries one;
 *  the provider's default shows as the bare model, as before. The effort
 *  is the session's own (the durable profile), never the CLI's memory. */
export function statusModelLabel(session: { readonly reasoning?: { readonly effort: string } }): string {
	const effort = session.reasoning?.effort;
	// The owner's dogfood, 2026-09-21 (the second pass): the status row under
	// the composer is the MODEL's, and only the model's — a host belongs where
	// a choice is being made (`/model`'s rows, the switch notice) and where the
	// identity is asked for (`/status`), not in a row that has ~40 columns and
	// cut the host to `deepseek/d…ndcode.ai`. Unnecessary at best, misleading at
	// worst: it read as a path, not as an account.
	// The owner, 2026-09-22: the row shows the MODEL's name only — a vendor
	// prefix (`deepseek/deepseek-v4.1-flash`) cost the row its tail. The full
	// id stays in `/status` and `/model`, where identity is asked for.
	const name = agentModel.slice(agentModel.lastIndexOf("/") + 1) || agentModel;
	return effort !== undefined && effort !== "default" ? `${name} · ${effort}` : name;
}

/** ADR-0055 Amendment 2 (decision 5): with no stated window the status row
 *  shows `ctx ?`, yet the compaction tiers still assume the fallback (128K
 *  since CW-1 batch 2)
 *  — the assumption is said out loud once, at agent build. */
export function unknownWindowNotice(model: string): string {
	return `[kiso] context window unknown for ${model} at this endpoint — compaction assumes ${DEFAULT_CONTEXT_WINDOW / 1000}K; set contextWindow on the profile to state it`;
}

/** CW-1 batch 2: said once, when an endpoint's refusal states its cap — the
 *  tiers aim below it from the next request, and later sessions start on it. */
export function windowLearnedNotice(model: string, host: string, tokens: number): string {
	return `✦ window learned — ${host === "" ? "the endpoint" : host} refused ${model} past ${windowLabel(tokens)} tokens; compaction now aims below it`;
}

/** ADR-0055 Amendment 2: the notice for a checkpoint the shrink invariant
 *  discarded — chars/4 sizes only; the checkpoint's text is the owner's
 *  work and never reaches the screen. */
export function compactionDiscardedNotice(d: { readonly pre: number; readonly post: number; readonly summary: number }): string {
	return `✦ compaction discarded — the checkpoint did not shrink the context (~${kUnit(d.pre)} → ~${kUnit(d.post)}; it wrote ~${kUnit(d.summary)})`;
}

export function displayCtxRatio(session: AgentSession): number {
	// CAPACITY is not POLICY. `contextWindowTokens` falls back to 128,000 so
	// that the compaction threshold always HAS a value — a policy needs a
	// number. A percentage on screen is a different kind of thing: it is a
	// claim about the model, and an unstated window makes it unanswerable.
	// NaN reaches the status row as `ctx ?`.
	const window = knownContextWindow();
	if (window === null) return Number.NaN;
	// 0.40.0: the last bill is the truth when one describes the context;
	// the parts estimate is for a session no bill describes yet.
	const anchored = session.contextAnchor();
	if (anchored !== undefined) return anchored / window;
	return requestBudget(session.requestParts(), window).ratio;
}

/** 0.40.0 item 9: how long a prompt cache is assumed to live. PROVISIONAL:
 *  DeepSeek does not publish its TTL (the owner's cache was gone after 27
 *  minutes); Anthropic's default is 5 minutes. */
export const COLD_AFTER_MS = 5 * 60_000;

/** 0.40.0 (the owner): the recap's cold-cache wording — only when the turn
 *  began at least COLD_AFTER_MS after the last bill AND the cache really
 *  missed (a surfaced miss, or under half the prompt from cache). */
export function coldAfter(idleMs: number | undefined, missed: number | null, usage: RunUsage): { coldAfterMinutes?: number } {
	if (idleMs === undefined || idleMs < COLD_AFTER_MS) return {};
	const hit = cacheHitPct(usage);
	return missed !== null || (hit !== null && hit < 50) ? { coldAfterMinutes: Math.round(idleMs / 60_000) } : {};
}

/**
 * 0.40.0 item 9 — the cold resume. When the last BILL put the context over
 * the microcompact threshold and that bill is older than COLD_AFTER_MS, the
 * next request re-sends the whole prefix uncached. Compacting first turns
 * that one expensive request into a summary call. Anchored only: a session
 * no bill describes has no known size, and no age to call cold.
 */
export function coldResumeOffer(session: AgentSession, now: number = Date.now()): { tokens: number; minutes: number } | null {
	const tokens = session.contextAnchor();
	const at = session.lastUsageAt;
	if (tokens === undefined || at === undefined) return null;
	if (tokens <= microcompactThresholdFor() || now - at < COLD_AFTER_MS) return null;
	return { tokens, minutes: Math.floor((now - at) / 60_000) };
}

/** A1a: the number the auto-compact decision reads — the pre-A1a estimate,
 *  unchanged this round, named so a gate can pin that it did not move. */
export function autoCompactRatio(session: AgentSession): number {
	return estimateCtxRatio(session);
}

/** R-C item 4: the per-turn cache miss — the overlap with the previous
 *  prompt that SHOULD have been cached but was re-sent uncached:
 *  missed = min(prevIn, in) − cacheRead. Below the 1024-token floor
 *  (Anthropic's minimum cacheable block) it is noise — not surfaced. */
const CACHE_MISS_FLOOR = 1024;

/** E2 (1.3.0) — the CLI's usage consumer: one event in, the RunUsage the
 *  status line and recap render plus the miss estimate. `total` is the
 *  carrier for the NEXT turn's miss estimate — the overlap of consecutive
 *  prompts is a total-side quantity, never a fresh delta. */
export interface UsageDelta {
	readonly usage: RunUsage;
	/** The canonical total (fresh + cache) — the miss estimate's carrier.
	 *  null when the event carried no usage (the canonical total of an
	 *  unknown event is 0, and a 0 carrier keeps the estimate below the
	 *  floor — the old consumer's carrier stayed null forever; this one
	 *  recovers on the next known event). */
	readonly total: number | null;
	readonly missed: number | null;
	/** TUI2-R1 (E): the CANONICAL cost of this request — null when the
	 *  pricing table has no rate for the route (the R5b-④c absent stamp).
	 *  Null is carried, never zeroed: a missing rate is not a free call. */
	readonly costUsd: number | null;
}

/**
 * The CLI's usage consumer (E2 1.3.0, the R2a-1 ruling 2026-08-13) — the
 * HEAL: the mixed-convention consumer is now CANONICAL at the route (the
 * accounting boundary), the same derivation the trace block carries.
 *
 * EXISTING-BEHAVIOR CHANGE — declared, never a silent side-fix:
 *  - openai-compat: `in` was the provider-raw TOTAL (fresh + cache); it is
 *    now the canonical FRESH count. The >100% cache-ratio disease: raw
 *    {input 111, cacheRead 1024} previously rendered "in 111" and the
 *    recap's cache % (then cache/in) read 923%; now "in 0" and the recap
 *    divides cache by the TOTAL (in + cache — T5) — never > 100%.
 *  - the miss estimate is numerically IDENTICAL on openai-compat: its old
 *    `in` WAS the total, and the carrier is the canonical total
 *    (input + cacheRead), which equals the raw total by construction.
 *  - anthropic: `in` was already fresh — unchanged; the miss estimate was
 *    min-of-fresh-deltas − cacheRead (always below the floor — silent);
 *    it is now min-of-totals, the semantics the openai-compat side always
 *    had (a fix, and it can fire).
 *  - the unknown-usage carrier: the old consumer's null carrier killed the
 *    miss signal forever; the canonical total of an unknown event is 0, so
 *    the signal recovers on the next known event.
 * The route key mirrors the trace path's fallback by construction: an
 * absent provider resolves like the tracer's "adapter" identity — the
 * total convention (INPUT_CONVENTIONS), never a crash.
 */
export function usageFromEvent(
	route: string | undefined,
	ev: import("@vincemakes/kiso-core").Usage,
	prevTotal: number | null,
	// PH-1c: the LIVE model — when given, the $cost keys on the model's
	// metadata entry (an unpriced model shows null, never a route-table
	// guess); omitted, the legacy route-keyed path stands (old callers,
	// old tests, unchanged bytes).
	model?: string,
	// OR-1: the live ENDPOINT — the same model id is priced at the
	// first-party API and unpriced at the subscription backend; the
	// session hands it over next to `provider` (one binding, one row).
	endpoint?: string,
): UsageDelta {
	const c = model === undefined ? canonicalizeUsage(route ?? "adapter", ev) : canonicalizeUsageForModel(model, endpoint, route ?? "adapter", ev);
	const total = c.input + c.cacheRead + (c.cacheWrite ?? 0);
	let missed: number | null = null;
	// R-C item 4: min(prevTotal, total) is the part that could have been
	// cached; what cacheRead did NOT cover is the miss. A below-floor or
	// non-positive difference is noise — not surfaced.
	if (prevTotal !== null) {
		const m = Math.min(prevTotal, total) - c.cacheRead;
		missed = m > CACHE_MISS_FLOOR ? m : null;
	}
	// OR-10 (owner, 2026-09-09): a backend whose cache figure cannot be
	// observed has no cache figure. The ChatGPT backend answers
	// `cached_tokens` 0 to a third-party client on every request, so its 0
	// and "not reported" are one value, and a CH 0% built on it claims a
	// measurement that never happened. The registry ROW says which
	// endpoints these are; the status row, the recap and the usage line
	// already render a null cache as nothing ("an unmeasured cache is not
	// a 0% cache"), so this is one decision at the one place the endpoint
	// is known. The trace ledger is written by the runtime from the
	// backend's own words and keeps its 0 — the display's rule, not the
	// record's.
	const unobservable = model !== undefined && lookupModelMetadata(model, endpoint)?.capabilities.promptCaching === "unobservable";
	// DF-0322-F2: the DISPLAY is handed the provider's own word, not the
	// canonical one. `canonicalizeUsage` sets `cacheRead ?? 0` because
	// accounting has to sum numbers — correct there, and pinned that way by
	// the gate — but it erases the difference between "the backend answered
	// zero" and "the backend said nothing about caching". Handing the row the
	// canonical zero made it claim a measurement that never happened, which
	// is the family OR-10 and DF-0311-F1 belong to. OR-10's own comment drew
	// this line first: the ledger keeps the backend's 0, the display's rule
	// is not the record's.
	const reportedCache = ev.cacheRead === null ? null : c.cacheRead;
	return {
		usage: { in: c.input, out: c.output, cache: unobservable ? null : reportedCache, known: ev.known },
		total,
		missed: unobservable ? null : missed,
		costUsd: c.costUsd,
	};
}

/** The accumulator's zero value — nothing measured yet. One shared
 *  literal: RunUsage's fields are readonly, and the old code repeated this
 *  object at every reset. */
const UNKNOWN_USAGE: RunUsage = { in: null, out: null, cache: null, known: false };

/** W22 (owner, 2026-09-14) — the TURN's usage, summed across its calls.
 *
 *  EXISTING-BEHAVIOR CHANGE — declared, never a silent side-fix:
 *  the recap and the running row carried the LAST call's figures
 *  (`usage = delta.usage`), and read as the turn's by everyone who saw
 *  them: the owner's own dogfood, a nine-call turn that had spent 120,358
 *  prompt tokens and 4,608 output tokens, reported `in 412 out 924 ·
 *  cache 98%` — the ninth call's fresh input and the ninth call's output.
 *  The variables are the same and the definitions are unchanged; the SCOPE
 *  is the turn's.
 *
 *  Two rules, inherited rather than invented:
 *  - `in` stays the canonical FRESH count (E2, R2a-1): the turn's sum is
 *    the input the turn actually bought at full price. `cache` is summed
 *    too, but only the recap's ratio reads it (cache/(in+cache)) — the raw
 *    total is the ledger's business, never the row's, because a sum over
 *    calls counts the same prefix once per call.
 *  - an unmeasured term makes the sum unmeasured (OR-10's rule, applied to
 *    the sum): `null` propagates, and one call with `known: false` makes
 *    the turn's figure unknown rather than a lower bound dressed as a
 *    total. The row then says nothing, as it always did for an unknown
 *    call.
 *
 *  The miss estimate and the decode rate stay PER CALL: `missed` is the
 *  overlap of consecutive prompts (a total-side quantity), and the rate is
 *  the call that just settled timing itself. */
export function accumulateUsage(prev: RunUsage, delta: RunUsage): RunUsage {
	const sum = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
	return {
		in: sum(prev.in, delta.in),
		out: sum(prev.out, delta.out),
		cache: sum(prev.cache, delta.cache),
		known: prev.known && delta.known,
	};
}

/**
 * W22-R1 (Astra): the turn's usage ledger, as ONE definition.
 *
 * A TURN is the sum over its CALLS; a CALL is its LATEST report. Both
 * halves are load-bearing: the openai-compat adapter yields a usage event
 * from either of two stream shapes and its `usageSent` flag only decides
 * whether to append a trailing unknown — it does not stop both from
 * firing. W22 substituted, so a second report silently replaced the first
 * and no screen changed; summing without the call boundary turned the same
 * stream into a WRONG NUMBER (a ledger of fresh 80 / out 10 shown as
 * 160 / 15).
 *
 * It is a function rather than three variables in the loop because the rule
 * then has one place to be right — the same reason `microcompactThresholdFor`
 * exists, and the drift `promptCacheKey` demonstrated when it did not.
 */
export function turnUsageLedger(): {
	observe: (ev: { readonly type: string }) => void;
	report: (u: RunUsage) => void;
	total: () => RunUsage | null;
} {
	let settled: RunUsage | null = null;
	let inFlight: RunUsage | null = null;
	const fold = (a: RunUsage | null, b: RunUsage | null): RunUsage | null =>
		a === null ? b : b === null ? a : accumulateUsage(a, b);
	return {
		// every event of the run passes through here: a stop ENDS a call, so
		// the report in flight settles and the next call starts its own.
		observe(ev) {
			if (ev.type !== "stop") return;
			settled = fold(settled, inFlight);
			inFlight = null;
		},
		// this call's latest report REPLACES its earlier one.
		report(u) {
			inFlight = u;
		},
		// the turn so far: the settled calls plus the one in flight.
		total() {
			return fold(settled, inFlight);
		},
	};
}

/**
 * The per-CALL view of usage reports for the two figures that must not
 * double: the cache-miss estimate and the session's running cost.
 *
 * A call may report its usage more than once — the op gateway sent two
 * usage chunks for one request (the owner's session
 * 2026-09-23T03-00-01-230c: `fresh 3k · miss 3k` on a first turn, both
 * reports 3,041 in / 69 out). The ledger above already makes a call's
 * LATEST report replace the earlier; the miss and the cost were read per
 * EVENT, so the second report compared itself with the first and called
 * the whole prompt a miss, and a priced route would have been charged
 * twice. Here the carrier is the PREVIOUS call's total, and a call's cost
 * is added as the difference from what that call already added.
 */
export function callUsageMeter(): {
	/** what a report's miss is measured against: the previous call's total */
	carrier: () => number | null;
	/** one report of the current call; returns the cost to ADD (or null) */
	report: (total: number | null, costUsd: number | null) => number | null;
	/** a stop ends the call */
	endCall: () => void;
} {
	let prevCallTotal: number | null = null;
	let callTotal: number | null = null;
	let callCost: number | null = null;
	return {
		carrier: () => prevCallTotal,
		report(total, costUsd) {
			if (total !== null) callTotal = total;
			if (costUsd === null) return null;
			const add = costUsd - (callCost ?? 0);
			callCost = costUsd;
			return add;
		},
		endCall() {
			if (callTotal !== null) prevCallTotal = callTotal;
			callTotal = null;
			callCost = null;
		},
	};
}

/** v2b: the spinner merged into the STATUS BAR (the v2a standalone glyph
 *  is gone) — docked only, 200ms rotation between the request and the
 *  first event. */
export function startStatusSpinner(onTick: (glyph: string) => void): () => void {
	// ADR-0005 Amendment 2: a retry belongs to the run that announced it.
	// Cleared where every run starts and stops — the chat's and the
	// recovery flow's alike — so a stale countdown can never survive into
	// the idle row or the next turn.
	setRetryShown(null);
	if (!dock.active) return () => {};
	// v3 §03/§05: the working glyph family ▖▘▝▗, 200ms rotation — the
	// callback repaints the running status line with the new glyph.
	// KC2 §5: the family itself moved to the tui's status formatters.
	let i = 0;
	const timer = setInterval(() => onTick(STATUS_GLYPHS[i++ % STATUS_GLYPHS.length]!), 200);
	timer.unref();
	return () => {
		clearInterval(timer);
		setRetryShown(null);
	};
}

/**
 * TUI2-R1 (C) — the shell tailer: the READER half of the progress
 * sidecar (the writer is the shell tool, tools-node).
 *
 * The CLI is the only place that holds both facts the derived key needs
 * — the session's id and the running call's command — so the tail is
 * read here and handed to the cell. A poll, not a watcher: fs.watch's
 * behaviour on a file being appended to differs by platform, and the
 * one thing this must never do is misbehave in a way that costs the run.
 *
 * THE FRESHNESS GUARD is the part that makes a kill -9 leftover
 * harmless. A sidecar the writer never got to remove keeps its old
 * mtime; a tail is read only from a file modified AT OR AFTER the call
 * started. A ghost from a previous process cannot be shown as this
 * call's output — and since the tail is display-only, showing nothing is
 * always the safe answer.
 */
const TAIL_POLL_MS = 250;
const TAIL_BYTES = 4096; // the last lines are all the window can hold

export function startShellTail(sessionId: string, callId: string, command: string, startedAt: number): () => void {
	const path = shellProgressPath(sessionId, command);
	const read = (): void => {
		try {
			const stat = statSync(path);
			if (stat.mtimeMs + 1000 < startedAt) return; // a ghost from a killed run — never this call's
			const text = readFileSync(path, "utf8");
			body.toolProgress(callId, text.slice(-TAIL_BYTES).trimEnd());
		} catch {
			// no sidecar yet, removed at settle, or unreadable — the tail
			// is an observation, and its absence is never an error
		}
	};
	read();
	const timer = setInterval(read, TAIL_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** v2e: the approval-moment mini-diff — edit_file/write_file changes as
 *  ± lines; other tools get null (no diff, no cost). The file read is
 *  best-effort: an unreadable file yields NO diff, never a failure —
 *  the diff must never break the approval. */
function approvalDiff(name: string, input: Record<string, unknown>): DiffResult | null {
	if (name !== "edit_file" && name !== "write_file") return null;
	const path = typeof input.path === "string" ? input.path : "";
	if (path === "") return null;
	// the tool refuses a protected file whatever the answer; the panel
	// must not print the store on the way there
	if (isProtectedPath(path, protectedIdentity(protectedFiles()))) return null;
	let oldContent: string | null = null;
	try {
		oldContent = readFileSync(path, "utf8");
	} catch {
		// a new write_file target (or an unreadable one) — all + degrades
	}
	try {
		if (name === "edit_file") {
			const search = typeof input.search === "string" ? input.search : "";
			const replace = typeof input.replace === "string" ? input.replace : "";
			if (search === "") return null;
			// TUI2-R1.5 ② (VD-2): the path rides along so a miss can name the
			// file in its honest note instead of fabricating a diff.
			return editFileDiff(oldContent ?? "", search, replace, path);
		}
		const content = typeof input.content === "string" ? input.content : "";
		return writeFileDiff(oldContent, content);
	} catch {
		return null; // never let the diff break the approval
	}
}

/**
 * TUI2-R3v2 ③ — the safer-options request: its prompt, and its parser.
 *
 * The prompt is deliberately small. It carries the pending call and
 * nothing else — no conversation, no tools, no project context — because
 * everything it does not send is rent the human pays for pressing a
 * button, and because "propose a safer version of THIS command" is a
 * question that needs no history to answer.
 */
/** TUI2-R3v2 ③: tools whose NEXT approval is the model's answer to a
 *  refusal — the "(amended)" marker's source. Per process, cleared as
 *  soon as it is shown: the marker describes ONE call, not a mode. */
const amendedCalls = new Set<string>();

/**
 * R3v2-F1: the format contract, stated FIRMLY. The first cut asked for
 * "JSON ONLY" and left it there, which a verbose model reads as a
 * preference — it wrote three sentences of preamble, opened a fence, and
 * the cap ended the reply mid-string. Forbidding prose, naming the exact
 * schema, and giving the nothing-is-safer case its own literal answer
 * are all the same instruction: there is one thing to emit and no room
 * to be helpful in the margins.
 *
 * The schema is an ENVELOPE rather than a bare array because a single
 * top-level object leaves the model nowhere to put a preamble.
 */
export const SAFER_SYSTEM_PROMPT = [
	"You propose safer alternatives to a single shell/tool call a human is being asked to approve.",
	"Reply with JSON ONLY — no prose, no preamble, no code fence, nothing before or after the JSON.",
	'The exact schema is {"alternatives":[{"command":"...","reason":"..."}]}, with 2-3 entries.',
	'"command" is the full replacement call. "reason" is ONE line of plain language saying what it does differently.',
	'Prefer alternatives that avoid irreversible deletion. If you cannot improve on it, reply {"alternatives":[]}.',
].join(" ");

/**
 * R3v2-F1: the side query's output ceiling — raised from 500, which was
 * the cap the live failures hit EXACTLY.
 *
 * The JSON-only reply the prompt now asks for is about 200 tokens for
 * three alternatives, so this ceiling is a runaway guard and not a
 * budget the answer is expected to approach: it exists so a model that
 * ignores the contract and writes an essay still stops, not so the
 * answer has room. Output is billed only when generated, and the query
 * fires only on a press, so the raise costs nothing on the path that
 * works and removes the one that could not.
 */
export const SAFER_MAX_TOKENS = 1500;

/**
 * R3v2-F1: WHY the ask failed, when the reply's own text can prove it.
 *
 * This side reports the cause and never the copy — the sentences live in
 * the panel package, next to each other, so there is one place where the
 * words are chosen and one place they can drift from.
 *
 * "Cut short" is a DIAGNOSIS, so it is only claimed when the text shows
 * it: a reply that closed its JSON and then failed our SHAPE returns
 * null and gets the unqualified line, because telling that human their
 * reply was truncated would be a confident wrong answer.
 */
export function saferFailure(text: string): SaferFailure | null {
	return jsonBody(text) === "truncated" ? { reason: "truncated" } : null;
}

/**
 * R3v2-F1: find the reply's JSON body by BALANCING brackets rather than
 * by first-and-last.
 *
 * `indexOf("[")` / `lastIndexOf("]")` had two failure modes a verbose
 * model hits constantly: a bracket in the trailing prose moved the end
 * past the array, and a reply the cap cut in half had no end at all.
 * Both returned null, and null could not say which — which is why the
 * degradation line could not either.
 *
 * Returns the balanced slice, `"truncated"` when a value opens and the
 * text ends before it closes, or null when there is no JSON value at
 * all.
 */
function jsonBody(text: string): string | "truncated" | null {
	// a CLOSED fence is content-preserving to strip. An OPEN one means
	// the reply ended inside the block — drop the opener and let the scan
	// below reach the same verdict from the content.
	const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = closed?.[1] ?? text.replace(/^[\s\S]*?```(?:json)?[ \t]*\r?\n/, "");
	const start = body.search(/[[{]/);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < body.length; i += 1) {
		const c = body[i]!;
		if (escaped) {
			escaped = false;
		} else if (inString) {
			if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
		} else if (c === "[" || c === "{") {
			depth += 1;
		} else if (c === "]" || c === "}") {
			depth -= 1;
			if (depth === 0) return body.slice(start, i + 1);
			if (depth < 0) return null;
		}
	}
	return "truncated";
}

/**
 * Parse the model's answer DEFENSIVELY — anything unexpected is a
 * failure, and a failure degrades honestly.
 *
 * The temptation here is to be clever: salvage a half-parse, coerce a
 * string into a command, accept an object where an array was asked for.
 * All of that produces a list of alternatives the model did not propose,
 * shown to a human deciding whether to run a destructive command. The
 * only honest failure mode is the dim line, so anything that is not
 * exactly the requested shape returns null.
 *
 * A fenced code block is the one accommodation, because models emit it
 * constantly and it changes no content.
 *
 * R3v2-F1 widens that accommodation and NOTHING else. Unwrapping the
 * named `alternatives` envelope, and reading `reason` as the spelling of
 * `why` the prompt now asks for, are transport details: the entries that
 * come out are verbatim the entries the model put in. That is the line
 * between an accommodation and the salvage this parser refuses — a
 * salvage changes WHICH alternatives are shown, and every rule that does
 * that is still here. One bad entry still poisons the batch.
 */
export function parseSaferOptions(text: string): SaferOption[] | null {
	const body = jsonBody(text);
	// truncation and absence part ways in saferFailureNote(), which reads
	// the same scan; for the list itself both are the same nothing.
	if (body === null || body === "truncated") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	const envelope = typeof parsed === "object" && parsed !== null ? (parsed as { alternatives?: unknown }).alternatives : undefined;
	const list = Array.isArray(parsed) ? parsed : Array.isArray(envelope) ? envelope : null;
	if (list === null || list.length === 0) return null;
	const out: SaferOption[] = [];
	for (const item of list.slice(0, 3)) {
		if (typeof item !== "object" || item === null) return null;
		const { command, reason, why } = item as { command?: unknown; reason?: unknown; why?: unknown };
		if (typeof command !== "string" || command.trim() === "") return null;
		const line = typeof reason === "string" ? reason : typeof why === "string" ? why : "";
		out.push({ command: command.trim(), why: line.trim() });
	}
	return out.length === 0 ? null : out;
}

/** W21 — the panel view for a permission_requested: the rule line (the
 *  why-asked speaker + the §3.5 fix hint), the toolTarget title, the
 *  "❯ run paused" status, and the ALWAYS-verbose args. */
function approvalView(name: string, ev: { speaker?: string; input?: Record<string, unknown> }, amended = false): PanelView {
	const speaker = ev.speaker ?? "kiso";
	const input = ev.input ?? {};
	// exactOptionalPropertyTypes: the hint is OMITTED when the speaker has
	// no fix (mode:accept-edits, shell in default) — never `hint: undefined`.
	const hint = fixHintFor(speaker, name);
	// TUI2-R3v2 ④: the deletion-risk line, for shell calls whose command
	// matches one of the four irreversible patterns. Local rules, no
	// request, and absent for every other command — which is most of them.
	const risk = name === "shell" ? deletionRiskHint(String(input.command ?? "")) : null;
	return {
		flavor: "approval",
		name,
		title: toolTarget(name, input),
		speaker,
		...(hint !== undefined ? { hint } : {}),
		...(risk !== null ? { riskHint: risk } : {}),
		statusText: "❯ run paused",
		args: approvalArgs(name, input),
		fallbackQuestion: `approve ${escapeTerminal(name)}? (y/n) `,
		// TUI2-R3v2 ③: the v4 frame's "(amended)" marker. It says WHY this
		// call looks different from the one just refused — without it, a
		// second approval for the same tool reads as the product asking
		// twice rather than as the model answering.
		...(amended ? { amended: true } : {}),
	};
}

/** The panel's ALWAYS-verbose args: edit_file/write_file → the full ±
 *  diff (the tool cell's capped copy never reaches the panel — the
 *  human approves the WHOLE change), shell → the full command line,
 *  anything else → the pretty-printed JSON. Nothing that is asked for
 *  approval is ever truncated. */
function approvalArgs(name: string, input: Record<string, unknown>): PanelArgs {
	if (name === "edit_file" || name === "write_file") {
		return { kind: "diff", diff: approvalDiff(name, input)?.lines ?? null };
	}
	if (name === "shell") {
		return { kind: "text", lines: [String(input.command ?? "")] };
	}
	return { kind: "text", lines: JSON.stringify(input, null, 2).split("\n") };
}

/**
 * The ergonomics batch C5 — the translation layer: the tui renders its OWN data shape
 * (RenderInput, zero kiso-core imports); the CLI translates its Event
 * stream here. Events without a render (stop, expired, resolved, …) → null,
 * and the consumer skips them — the pipe bytes stay identical.
 */

function toRenderInput(ev: import("@vincemakes/kiso-core").Event): RenderInput | null {
	switch (ev.type) {
		case "user_input":
			return { type: "user_input", content: ev.content };
		case "text_delta":
			return { type: "text_delta", text: ev.text };
		case "text_end":
			return { type: "text_end" };
		case "thinking":
			return { type: "thinking", text: ev.text };
		case "tool_call_end":
			return { type: "tool_call_end", name: ev.name, input: ev.input };
		case "tool_execution_started":
			return { type: "tool_execution_started" };
		case "tool_execution_succeeded":
			return { type: "tool_execution_succeeded" };
		case "tool_execution_failed":
			return { type: "tool_execution_failed", error: ev.error };
		case "tool_result":
			return { type: "tool_result", content: ev.content, isError: ev.isError };
		case "permission_requested":
			return { type: "permission_requested", name: ev.name, input: ev.input };
		case "permission_decided":
			return { type: "permission_decided", decision: ev.decision, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
		case "terminal":
			return { type: "terminal", outcome: ev.outcome };
		case "compacted":
			return { type: "compacted", cleared: ev.cleared };
		case "summarized":
			return { type: "summarized", coversToSeq: ev.coversToSeq };
		case "uncertain_pending":
			return { type: "uncertain_pending", name: ev.name, executionId: ev.executionId, error: ev.error };
		default:
			return null; // events without a render (stop, expired, resolved, …)
	}
}

/**
 * Consume a run, answering approval pauses as they arrive. `resumeMode`
 * marks a session.resume() continuation. `faux` picks the status line's
 * form. W22: EVERY user_input event renders its UserMessage chip in the
 * body — the v2a double-echo filter is retired (the transient input-row
 * echo is UI, the chip is the record; the momentary double-render is
 * the design's explicit point).
 */
export async function consumeRun(
	session: AgentSession,
	run: Run,
	input: LineInput,
	turnNo: number,
	faux: boolean,
	statusCb: ((usage: RunUsage, ctxRatio: number, costUsd?: number | null, tokPerSec?: number | null) => void) | null,
	/** W21: the amend words ("Yes + feedback") ride the NEXT user turn —
	 *  threaded from chat's submitTurn; absent in the recovery flow
	 *  (resume) where a dropped amend is noticed instead. */
	submitTurn?: (line: string) => void,
	/** ADR-0057: a steer landed — an input after the run's own. */
	onInputLanded?: () => void,
): Promise<import("@vincemakes/kiso-core").Event | undefined> {
	let last: import("@vincemakes/kiso-core").Event | undefined;
	let inputsSeen = 0;
	// W22: the TURN's usage — null until a call settles, then the sum of
	// every call in this turn (accumulateUsage). Null rather than an empty
	// accumulator, so the first call is the sum rather than an addition to
	// nothing.
	//
	// W22-R1 (Astra): one call can report TWICE, so the turn is a sum over
	// CALLS and a call is its LATEST report — see `turnUsageLedger`, which
	// holds that rule. Every event passes through `observe` (a stop ends a
	// call); the usage case reports; the status line and the recap read
	// `total()`.
	const ledger = turnUsageLedger();
	const turnUsage = (): RunUsage | null => ledger.total();
	// TPS-1: the decode clock, armed by the FIRST streamed event of a call
	// and read at that call's usage event. Per CALL, not per turn — a turn
	// with three model calls reports the third, and each one times itself.
	let callFirstEventAt: number | null = null;
	const meter = callUsageMeter();
	let missed: number | null = null;
	// v3 §02: the recap line derives ENTIRELY from the local event stream
	// (zero tokens). R3g: what it derives is the turn's COST — wall
	// seconds, usage, ctx left. The turn's WORK is the fold line's, said
	// once, where the work happened.
	const turnStart = Date.now();
	// 0.40.0 (the owner): how long the session had been idle when this turn
	// began — the recap names a cold cache instead of a bare fresh figure.
	const idleMs = session.lastUsageAt === undefined ? undefined : turnStart - session.lastUsageAt;
	// W14: the thinking event carries NO timestamp — the CLI wall-clocks
	// the thinking window: it opens at the first thinking event and closes
	// at the first non-thinking event (the fold needs the seconds).
	let thoughtSeconds = 0;
	let thinkingSince: number | null = null;
	// TUI2-R1 (C): the shell commands seen this run, and the tailers
	// running for them. A tailer is started when the execution starts and
	// stopped at the call's result — and the finally below stops any that
	// an abort left behind, so a poller can never outlive its run.
	const shellCommands = new Map<string, string>();
	const tailers = new Map<string, () => void>();
	const stopTail = (callId: string): void => {
		tailers.get(callId)?.();
		tailers.delete(callId);
	};
	try {
	for await (const ev of run) {
		last = ev;
		// ADR-0005 Amendment 2: an event from the run means the retried
		// attempt got through — the row stops saying it is waiting.
		if (retryShown !== null) setRetryShown(null);
		// LT2B-F1: a turn count is not evidence of a loop. Keep consuming
		// healthy runs without a periodic presence check; explicit cancellation,
		// the stream watchdog and the repeated-failure breaker remain active.
		// W22-R1: the ledger sees every event; a stop is what ends a call.
		ledger.observe(ev);
		if (ev.type === "stop") meter.endCall();
		// ADR-0055 Amendment 1 (A1b): a compaction inside the run says so, once.
		if (ev.type === "summarized" || ev.type === "microcompacted") {
			const r = displayCtxRatio(session);
			const ctx = Number.isFinite(r) ? ` · ctx now ~${Math.round(r * 100)}% used` : "";
			body.notice(ev.type === "summarized" ? `✦ compacted mid-run — the conversation before this point is a summary now${ctx}` : `✦ pruned old tool output mid-run${ctx}`);
		}
		if (ev.type !== "thinking") {
			if (thinkingSince !== null) {
				thoughtSeconds += (Date.now() - thinkingSince) / 1000;
				thinkingSince = null;
			}
		} else if (thinkingSince === null) {
			thinkingSince = Date.now();
		}
		// v2d: EVERY event only mutates a cell — the Body is the single
		// writer of the scroll region, so interleaving is impossible by
		// construction (ADR-0040).
		switch (ev.type) {
			case "user_input":
				inputsSeen += 1;
				if (inputsSeen > 1) onInputLanded?.();
				// The window title is re-derived here because THIS is when a
				// session stops being nameless: the tab opened as `kiso —
				// <workspace>` and the first substantive prompt is what gives
				// it a name. Re-derived rather than set, so the opener rule is
				// `sessionTitle`'s and a greeting-first session upgrades when
				// the real prompt lands instead of keeping "hi" forever.
				paintWindowTitle(session.log.all);
				// TV-1B: a system-sourced input is PRODUCT MACHINERY — visible
				// (every durable input renders) but never painted as the
				// user's words. Provenance is honest on screen, not only in
				// the log. Since 0.44.0 (the verify offer retired) the CLI
				// starts no such run itself; the branch keeps the rule for
				// any run that carries one, as replay.ts does for old logs.
				// ADR-0058: a task notice is a row, never the person's chip
				if (ev.via?.kind === "tasks") {
					body.notice(taskNoticeRow(ev.via.items));
					break;
				}
				if (ev.source === "system") {
					// R2 (law 1.3): the ◆ said nothing the words did not. What
					// makes this row honest is that it NAMES itself machinery.
					body.notice("verification pass");
					body.notice(`  ${typeof ev.content === "string" ? ev.content : ""}`);
					break;
				}
				// 0.40.0: a skill turn's chip is the line the person TYPED — the
				// SKILL.md body is what the model read, not what they said.
				if (ev.via?.kind === "skill") {
					body.userLine(ev.via.line);
					break;
				}
				// DC-60: a turn that carries an image is a content ARRAY — its words
				// still echo, the image as a mark; an empty chip was the bug.
				body.userLine(echoText(ev.content));
				break;
			case "thinking":
				callFirstEventAt ??= Date.now(); // TPS-1: reasoning IS decoding
				body.thinkingAppend(ev.text);
				break;
			case "tool_call_end":
				body.toolStart(ev.name, ev.callId, ev.input ?? {});
				// TUI2-R1 (C): the command is the sidecar key's other half —
				// remembered here, used when the execution actually starts.
				if (ev.name === "shell" && typeof ev.input?.command === "string") shellCommands.set(ev.callId, ev.input.command);
				break;
			case "tool_execution_started": {
				body.toolRunning(ev.callId);
				const command = shellCommands.get(ev.callId);
				if (command !== undefined) tailers.set(ev.callId, startShellTail(session.id, ev.callId, command, Date.now()));
				break;
			}
			case "tool_execution_succeeded":
				body.toolSucceeded(ev.callId);
				break;
			case "tool_execution_failed":
				body.toolFailed(ev.callId, ev.error);
				break;
			case "tool_result": {
				// TUI2-R1 (C): the observation window closes the instant the
				// real result exists — the tail must never race it.
				stopTail(ev.callId);
				const text = typeof ev.content === "string" ? ev.content : "";
				// W19: a DENIED call carries its reason — extracted from the
				// result's "[Permission denied] " prefix, keyed on the
				// "denied" tag (the tag declares, the prefix confirms). The ToolCell renders the
				// pinned row (full name, target, reason, no timing).
				let reason: string | null = null;
				if ((ev.tags ?? []).includes("denied")) {
					const m = /^\[Permission denied\] (.*)$/.exec(text);
					if (m !== null) reason = m[1]!;
				}
				body.toolResult(ev.callId, { content: text, isError: ev.isError, reason });
				break;
			}
			case "text_delta":
				callFirstEventAt ??= Date.now(); // TPS-1
				body.textAppend(ev.text);
				break;
			case "text_end":
				body.textEnd();
				break;
			case "model_output_abandoned":
				// F4: the transcript must not glue drafts — the durable void
				// closes the abandoned draft VISIBLY, and the retried stream
				// (or the error terminal) opens on a fresh block. Without
				// this, the projection is clean while the screen welds two
				// answers into one — the surface-lying class.
				body.textEnd();
				body.notice("stream interrupted — the draft above is abandoned");
				break;
			case "usage": {
				const delta = usageFromEvent(session.provider, ev, meter.carrier(), agentModel, session.baseUrl);
				// W22-R1: this call's LATEST report replaces its earlier one;
				// the turn's figure is the settled calls plus this one. The
				// miss and the cost follow the same rule (callUsageMeter).
				ledger.report(delta.usage);
				const costToAdd = meter.report(delta.total, delta.costUsd);
				missed = delta.missed;
				// TUI2-R1 (E): the request's canonical cost rides the same
				// callback the usage does — one settled request, one addition.
				// TPS-1: the rate of the call that just settled. The clock is
				// cleared here rather than at the turn boundary, so a turn's
				// second call is timed from ITS own first event.
				const tokPerSec = callFirstEventAt === null ? null : decodeRate(ev.outputTokens, Date.now() - callFirstEventAt);
				callFirstEventAt = null;
				statusCb?.(turnUsage() ?? UNKNOWN_USAGE, displayCtxRatio(session), costToAdd, tokPerSec);
				break;
			}
			case "uncertain_pending":
				// ruling #12 (ADR-0038): the notice line is pure INFORMATION now — the
				// approval chain guards retries, and the human question belongs
				// only to the crash window's recovery flow (resolveUncertains).
				body.notice(`${escapeTerminal(ev.name)} FAILED — the side effect may have applied. ${escapeTerminal(ev.error)}`);
				break;
			case "permission_requested": {
				// v2d: the ToolCell shows the ❯ badge; the question takes over
				// the dock status position; the answer lands at the input line.
				// v2e: the mini-diff for edit/write at the approval moment —
				// the human sees the change BEFORE deciding (auto-allowed tools
				// skip the diff: nobody is looking).
				// W21: the PANEL replaces the line question — the bounded block
				// with the ALWAYS-verbose args (the full diff / command / JSON,
				// nothing the human approves is ever cut) and the numbered
				// options. The verdict maps to the session approvals:
				//  - bare No   → approve(false) FIRST (the denial settles the
				//    request), THEN run.abort() — the run's aborted terminal
				//    closes the cell;
				//  - No+words  → approve(false, words) — the words become the
				//    tool_result, the run continues;
				//  - Yes+amend → approve(true), the words ride the NEXT turn;
				//  - esc       → cancel, the conservative denial.
				const name = (ev as { name: string }).name;
				const decisionId = (ev as { decisionId: string }).decisionId;
				// Launch-weekend plan §2 — dontAsk: the chain's final ASK is
				// denied HERE, at the one place kiso asks, so every allow the
				// chain gave still stands (a tier deny would outrank them). The
				// reason is the tool result: the model sees why and goes on.
				if (getDontAsk()) {
					body.notice(`[dontAsk] ${escapeTerminal(name)} would ask — denied`);
					await session.approve(decisionId, false, `dontAsk: ${name} needs a human's approval, and this session never asks — denied`);
					break;
				}
				body.toolApproval(ev.callId, approvalDiff(name, ev.input ?? {}));
				// TUI2-R3v2 ③: the on-demand alternatives provider. It is built
				// per approval and captured by the panel; it fires ONLY if the
				// human presses option 3, which is the whole zero-ambient-rent
				// mechanism — no press, no request, nothing in the trace.
				const safer = async (): Promise<SaferAnswer> => {
					const answer = await session.sideQuery({
						purpose: "safer-options",
						systemPrompt: SAFER_SYSTEM_PROMPT,
						prompt: `the pending call is: ${name} ${JSON.stringify(ev.input ?? {})}`,
						maxTokens: SAFER_MAX_TOKENS,
					});
					// R3v2-F1: a failure reports its CAUSE when the reply can
					// prove one, so the panel can say which failure this was.
					// saferFailure() returns null for every cause we cannot
					// demonstrate, which is the unqualified line — unchanged.
					return parseSaferOptions(answer) ?? saferFailure(answer);
				};
				const verdict = await askPanel(
					input,
					approvalView(name, ev as { speaker?: string; input?: Record<string, unknown> }, amendedCalls.has(name)),
					{ safer },
				);
				amendedCalls.delete(name);
				switch (verdict.action) {
					case "cancel": {
						// round 10: a cancellation is a CONSERVATIVE denial,
						// explicitly distinguished from the user typing "n".
						body.notice("[approval cancelled — treated as a denial]");
						await session.approve(decisionId, false);
						break;
					}
					case "allow": {
						await session.approve(decisionId, true);
						if (verdict.reason.trim() !== "") {
							if (submitTurn !== undefined) submitTurn(verdict.reason);
							else body.notice("[amend words dropped — the recovery flow has no live prompt]");
						}
						break;
					}
					case "allow-rule": {
						// R3: the don't-ask-again extension is ALLOW-ONLY (never
						// emits deny or ask — the mode and safe-defaults moats
						// keep their teeth); the generated file is human-editable
						// and human-deletable — that IS the revocation path.
						await session.approve(decisionId, true);
						await addDontAskAgainRule(verdict.rule);
						break;
					}
					case "deny": {
						if (verdict.reason.trim() !== "") {
							// No+words — the words become the tool_result; the
							// run continues with the model seeing the denial.
							// TUI2-R3v2 ③: whatever the model proposes next for
							// this tool IS the amended call, and the panel says so.
							amendedCalls.add(name);
							await session.approve(decisionId, false, verdict.reason);
						} else {
							// bare No — the denial settles the pause FIRST, then
							// the run aborts.
							await session.approve(decisionId, false);
							run.abort();
						}
						break;
					}
				}
				break;
			}
			case "permission_decided": {
				// A5: the verdict binds INTO the tool cell — the aggregated
				// head row (name + status + decidedBy in ONE row), never a
				// free-standing `  approved` orphan. The render.ts case stays
				// for the PIPE path (the transcript is the raw event stream).
				body.toolVerdict(ev.callId ?? "", ev.decision, ev.decidedBy, ev.reason);
				break;
			}
			case "terminal": {
				// v3 §02: the run's recap line REPLACES the old "done" label
				// + status line — one local line, derived from this run's
				// events (zero tokens). The dock's status bar still paints.
				statusCb?.(turnUsage() ?? UNKNOWN_USAGE, displayCtxRatio(session));
				const ratio = displayCtxRatio(session);
				// W14: the turn record closes HERE — before the recap logs, so
				// the commit loop folds the quiet turn's held cells first (the
				// fold line lands above the recap, natural cell order).
				body.endTurn(Math.round(thoughtSeconds));
				// D4: the max_tokens truncation is named, never silent — the
				// honest notice rides after the partial answer, before the
				// recap (the truncation-guard philosophy: the cut is visible
				// in the scrollback, the model's own text intact).
				// R3d: the TURN LIMIT is named. `max_turns` was the one
				// terminal outcome that ended a run without saying so — the
				// session simply stopped, mid-task, and read as a hang. A
				// guardrail that fires silently is indistinguishable from a
				// crash, which is the one thing this product must never be.
				if (ev.outcome.kind === "max_turns") {
					body.notice(`stopped at the ${ev.outcome.turns}-turn limit — the work is durable; say "continue" to carry on`);
				}
				if (ev.outcome.kind === "max_tokens") {
					// R2 (law 1.1): the notice was wearing a box corner. A notice
					// is a sentence addressed to a human; it needs no edge.
					body.notice('answer truncated at max_tokens — say "continue" to finish');
				}
				// OR-5 (the ChatGPT real leg, 2026-09-09): a run that ended in an
				// ERROR terminal printed nothing but the recap — the vendor's 400
				// lived in the durable log alone and the turn read as "took 1s".
				// A failure that fires silently is indistinguishable from a
				// crash, the one thing this product must never be: the mapped
				// error is named here, before the recap, code and status and the
				// provider's own words.
				if (ev.outcome.kind === "error") {
					const e = ev.outcome.error as { code: string; message: string; retryable: boolean; status?: number };
					body.notice(`run failed — ${e.code}${e.status !== undefined ? ` ${e.status}` : ""}${e.retryable ? " (retryable)" : ""}: ${escapeTerminal(e.message)}`);
				}
				bodyLog(
					renderRecap({
						seconds: Math.round((Date.now() - turnStart) / 1000),
						// R3g: the work terms are NOT passed — the fold line
						// says what the turn did, once, where it happened and
						// with the key that reopens it. This row is the turn's
						// cost: how long it took and what it spent.
						// R3g: `?? 80` is NOT enough — a PTY opened without a
						// winsize reports 0 columns, and 0 is not nullish, so
						// the recap cut itself down to one character. A width
						// that is not a positive number is not a width.
						width: process.stdout.columns > 0 ? process.stdout.columns : 80,
						usage: turnUsage() ?? UNKNOWN_USAGE,
						// R-C item 4: only an above-floor miss is surfaced —
						// the recap gains "· miss N" on the cache segment.
						...(missed !== null ? { missed } : {}),
						// Cold: idle past the cache's assumed life (the #77
						// constant, provisional) AND the turn did re-send a
						// prefix uncached — the time alone is not evidence.
						...(coldAfter(idleMs, missed, turnUsage() ?? UNKNOWN_USAGE)),
						ctxLeftPct: Number.isFinite(ratio) ? (1 - ratio) * 100 : null,
						// W19: under plan the recap becomes the way-forward row
						// (the /mode hints are the mode's exits).
						mode: getMode(),
					}),
				);
				break;
			}
			default: {
				// Events without a cell (stop, …) — the generic render, byte-
				// preserved for the pipe path (C5: Event → RenderInput first).
				const input = toRenderInput(ev);
				if (input === null) break;
				const rendered = renderEvent(input, false, canonicalTargetPath);
				if (rendered.text !== "") {
					body.raw(rendered.text.replace(/\n$/, "").split("\n"));
				}
				break;
			}
		}
	}
	body.thinkingEnd(); // a trailing thinking block folds at the run's end
	} finally {
		// TUI2-R1 (C): an abort or a throw leaves the loop without a
		// tool_result — every tailer stops here regardless, so no poller
		// outlives the run that started it.
		for (const callId of [...tailers.keys()]) stopTail(callId);
	}
	return last;
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
/** The chat loop's ENDING: exit closes the process's REPL for good; a
 *  switch hands main another session id to re-enter chat with — the
 *  editor survives, the durable law is untouched (the /resume+/clear
 *  mini-spec). */
export type ChatEnd =
	| { readonly next: "exit" }
	| { readonly next: "switch"; readonly id: string; readonly lines?: readonly string[] }
	/** §2.5: the caller REBUILDS the agent and re-enters on the same id.
	 *  Not "switch": switching keeps the agent and only changes the id,
	 *  which would reload nothing at all — the tool registry lives in the
	 *  agent's constructor. */
	| { readonly next: "reload"; readonly id: string; readonly lines?: readonly string[] };

/** The session-navigation seam main provides: the OTHER sessions'
 *  ids, and (when a dock is up) the existing picker. */
export interface ChatNav {
	readonly sessions: () => readonly string[];
	/** 0.40.0: an id outside this project's folder — refused, or opened where it is */
	readonly route?: (id: string) => SessionRoute | null;
	readonly pick?: () => Promise<string | null>;
}

export async function chat(session: AgentSession, faux: boolean, input: LineInput, autoCompact?: AutoCompact, nav?: ChatNav, seed?: readonly string[]): Promise<ChatEnd> {
	// the switch directive — set once by dispatch's /clear or /resume,
	// resolved through the end signal so the final awaits still run
	let switchTo: string | null = null;
	// §2.5: the reload directive — same resolution path as switchTo, so the
	// final awaits still run before chat() returns.
	let reloadReq = false;
	let resolveEnd: () => void = () => {};
	const endSignal = new Promise<void>((r) => {
		resolveEnd = r;
	});
	let currentRun: Run | null = null;
	let cancelled = false;
	// E group (the graceful-exit gate ③, R-G 0.1.48): the terminal can
	// close MID-run — the stream 'end' fires while currentRun is set, so
	// the EOT callback defers. eotSeen remembers it; each run's end
	// re-evaluates the exit condition (the safe point), so the release
	// always runs.
	let eotSeen = false;
	/** The exit condition, shared by the EOT callback and the deferred
	 *  re-check: no pending ask, an empty line. currentRun is checked by
	 *  the callers (the callback when 'end' fires; the run-end re-checks
	 *  run only after currentRun was nulled). */
	const exitAtEmptyPrompt = (): void => {
		if (pendingAsk !== null || input.line() !== "") return;
		cancelled = true;
		console.log("\n[exit requested]");
		input.close();
	};

	const turn = (text: string, via?: UserInputVia): Promise<void> =>
		new Promise((resolve, reject) => {
			queued = Math.max(0, queued - 1); // a queued turn starts
			// REL-0152-D11: a turn that names an image file carries it. The
			// scan returns the STRING unchanged when it finds nothing, so a
			// turn without one is byte-identical to before the feature.
			// REL-0152-D16: the capsules' files come from the editor, which
			// is the only thing that knows which number stands for which
			// screenshot.
			//
			// 0.40.0: a skill turn is not scanned either — its text is a
			// SKILL.md body, and a body that mentions `diagram.png` must not
			// attach a file from the workspace the person never pointed at.
			const content = via !== undefined ? text : attachImages(text, input.attachments?.(), protectedFiles());
			// ADR-0058: a task notice is the runtime's input — source "system"
			const run = via !== undefined ? session.run(content, { via, ...(via.kind === "tasks" ? { source: "system" as const } : {}) }) : session.run(content);
			currentRun = run;
			turnNo += 1;
			const myTurn = turnNo;
			// v3 §03: the running state owns the status bar — the glyph
			// rotates every 200ms; the idle state returns after the run.
			runStart = Date.now();
			runUsage = { in: null, out: null, cache: null, known: false };
			lastTokPerSec = null; // TPS-1: nothing has settled in THIS turn yet
			const stopSpinner = startStatusSpinner((g) => {
				runGlyph = g;
				paintRunning();
			});
			(async () => {
				let last: import("@vincemakes/kiso-core").Event | undefined;
				try {
					last = await consumeRun(session, run, input, myTurn, faux, statusCb, submitTurn, landed);
					stopSpinner();
					paintIdle();
					currentRun = null;
					handBack(run);
					// 0.40.5: the kiso on disk may no longer be the one this
					// session runs (an upgrade since it started) — said once per
					// installed version (stale-version.ts).
					const stale = staleVersionNotice(installedVersion(), VERSION, session.id);
					if (stale !== null) body.notice(stale);
					// round 8: a faux script that ran out of declared turns exits
					// loudly with a non-zero status — never a silent status 0.
					// round 4 (adversarial): the exhaustion is a CONTROLLED rejection of
					// this turn's promise — it propagates through the chain to
					// chat to main's finally/catch, never an orphaned
					// unhandled rejection from the IIFE.
					failOnFauxExhaustion(last, faux, input);
					// E group (the graceful-exit gate ③): the fd may have closed
					// mid-run — the run's end is the safe point for the deferred
					// exit, so the release always runs.
					if (eotSeen) exitAtEmptyPrompt();
					// round 8: after EVERY turn the prompt is re-armed — the human
					// never types blind after the first turn.
					input.prompt();
					// the ergonomics batch C8: the opt-in auto-compact — checked AFTER the
					// turn ended (the run's terminal is in the log, the ratio
					// is post-run).
					await maybeAutoCompact();
					resolve();
				} catch (err) {
					// A run failure must not freeze the REPL (review finding
					// 11): surface it and re-arm the prompt.
					if (err instanceof FauxExhaustionError) {
						currentRun = null;
						reject(err);
						return;
					}
					console.error(`\n[run failed] ${err instanceof Error ? err.message : String(err)}\n`);
					currentRun = null;
					handBack(run);
					input.prompt();
					resolve();
				}
			})();
		});

	input.onSigint(() => {
		if (currentRun) {
			// round 8: Ctrl+C cancels BOTH the pending question (if one is
			// awaiting a line) and the run — the run then writes its unique
			// aborted terminal, which the consumer keeps consuming.
			console.log("\n[aborting run]");
			pendingAsk?.();
			giveBack();
			currentRun.abort();
		} else if (pendingAsk !== null) {
			pendingAsk?.(); // a startup/trust question — cancel it
		} else if (input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		} else {
			input.clearLine(); // v2c: Ctrl+C on a non-empty line clears it
		}
	});
	input.onEot(() => {
		// E group (the graceful-exit gate ③): the 'end' may fire MID-run —
		// the exit defers to the run's end (the re-checks below).
		eotSeen = true;
		if (!currentRun) exitAtEmptyPrompt();
	});
	input.onEscape(() => {
		// §2.2: a `!` command is offered the key FIRST. The two are never
		// both in flight — the dispatcher is serialized on the chain — so
		// this is an ordering, not a precedence rule.
		if (abortBangCommand()) {
			console.log("\n[aborting command]");
			return;
		}
		if (currentRun) {
			console.log("\n[aborting run]");
			pendingAsk?.();
			giveBack();
			currentRun.abort();
		}
	});
	// KC2 §2/§3 — the redirect: "stop, and do THIS instead". No stream
	// injection, no new durable or op state — the run aborts (its terminal
	// is an honest `aborted`) and the buffer's text becomes the next turn.
	// With no run in flight the gesture is simply an Enter, which is what
	// the human means by it: there is nothing to stop.
	input.onRedirect?.((line) => {
		if (currentRun === null) return dispatch(line, dispatchCtx);
		console.log("\n[redirecting run]");
		pendingAsk?.();
		// ADR-0057: steers that had not landed ride the correction — one next
		// message, not a queue; the correction first (§3: it corrects them).
		const unsent = handed(currentRun.retract().length);
		currentRun.abort();
		// §3: a correction must run BEFORE the follow-ups queued earlier —
		// it is a correction OF them. The existing slot mechanics compose
		// it: every pending slot leaves through the SAME pop the ↑ key uses
		// (cancelled, so its chain segment skips), then they re-enter
		// BEHIND the correction, in their original order. Ephemeral
		// reordering of ephemeral state; the durable log still just records
		// what ran, in the order it ran.
		// A slot re-enters with its CONTENT and its `via`, never its display
		// line: a queued skill re-submitted as `/review x` would reach the
		// model as the literal text of the command.
		const jumped = pendingTurns.map((s) => ({ content: s.content, via: s.via }));
		for (let i = jumped.length; i > 0; i -= 1) popQueue();
		queueTurn(unsent.length > 0 ? [line, ...unsent.map((u) => u.content)].join("\n\n") : line);
		for (const j of jumped) queueTurn(j.content, j.via);
	});

	// round 5 (P1-11): the PERSISTENT line listener is installed BEFORE the
	// startup recovery — a cancelled question's re-emitted "line" needs a
	// listener from the very first instant, or the input is silently lost.
	// Turns are SERIALIZED on a chain — piped lines arrive faster than
	// turns complete, and concurrent runs are forbidden. Lines that arrive
	// while the recovery is still running are QUEUED and replayed once the
	// REPL is ready (they are never dropped).
	const chainRef: { current: Promise<void> } = { current: Promise.resolve() };
	let replReady = false;
	const queuedLines: string[] = [...(seed ?? []), ...queuedSwitchLines.splice(0)];
	// DC-57 (the owner's ruling, 2026-09-21): once the session is LEAVING —
	// a switch or a reload has been requested — a line that arrives belongs
	// to the session the person asked for, not to the one they are leaving.
	// One read can carry several lines (a paste, a pipe, a scripted
	// driver), and the departing instance used to dispatch them; they are
	// queued here and replayed by the NEXT chat() entry, exactly as
	// pre-ready lines are replayed by this one.
	let leaving = false;
	// B area: user-turn counter for the status line. /last and /think read
	// the body (the ToolCell / ThinkingCell final states).
	let turnNo = 0;
	// v2c: turns submitted while another runs are QUEUED on the chain —
	// the live count rides the status bar (+N queued).
	let queued = 0;
	// W22: the pending turns — the LIVE slots the chips + the ↑/esc pop
	// read (the dock renders the lines, the editor pops the last one).
	// A slot leaves the queue when its turn STARTS or when the user
	// pops it (cancelled — the chain segment skips it).
	// 0.40.0: `line` is what the chip shows and what a pop hands back to
	// the editor — for a skill, the line the person TYPED; `content` is
	// what the turn submits (the skill's body and args).
	const pendingTurns: { line: string; content: string; via?: UserInputVia; cancelled: boolean }[] = [];
	// v2b: the live status bar (docked only). Modes: /mode switches repaint
	// it immediately through paintStatus (the last turn stats are kept).
	// v3 §03: the status bar has TWO states. Idle: the mode is ALWAYS
	// shown (default included) with the /mode hint. Running: the working
	// glyph (▖▘▝▗ — the spinner drives it) + wall seconds + ↓ out tokens
	// + the interrupt hint. ctx left is the live estimate everywhere.
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	// TUI2-R1 (E): the session's spend so far — the CANONICAL cost of every
	// request this process has seen, summed. Null stays null: a route with
	// no rate in the pricing table contributes nothing and the row shows no
	// $ at all, because a partial total presented as a total is a lie.
	let spentUsd: number | null = null;
	let runGlyph = "▖";
	let runStart = Date.now();
	// TPS-1: the decode rate of the last SETTLED call. One variable serves
	// both rows because they want the same number at different moments;
	// only the reset points differ, and they are all on the ENTRY side —
	// cleared when a turn starts (so the running row never shows the
	// previous turn's figure while a new one is in flight) and when the
	// binding changes (DF-0311-F1: a model that has not run has no
	// measurement), never at a turn's END, so the idle row can carry the
	// last call of the last turn.
	let lastTokPerSec: number | null = null;
	// DF-0330-F1: the terminal's own width, read at paint time so a resize
	// is honoured. winsize reports 0 columns in some hosts and 0 is not
	// nullish, so the guard is `> 0` rather than `??` (the same shape the
	// compositor's own width call uses).
	const rowWidth = (): number => (process.stdout.columns > 0 ? process.stdout.columns : 80);
	// KC2 §5: the STATE (the glyph, the run's start, the usage, the dock)
	// stays here; the ROW's text is the tui's status formatter.
	const paintRunning = (): void => {
		// ADR-0005 Amendment 2: the running row gets the idle row's budget
		// (DF-0330-F1). A pending retry makes it thirty columns longer, and
		// composed blind it would be cut from the END — the context figure,
		// a fact, going before the gesture hints.
		if (dock.active) dock.setStatus(runningStatus(runGlyph, runStart, runUsage.out, displayCtxRatio(session), lastTokPerSec, rowWidth(), retryOnRow()));
	};
	// W19: under plan the idle row makes the posture unmistakable — the W4
	// parentheses idiom names the read-only constraint. The tier is the
	// CALLER's word (the recovery flow passes the bare mode).
	const paintIdle = (): void => {
		if (!dock.active) return;
		// TUI2-R1 (E): the meter rides the idle row — both fields omitted
		// when unknown, so a session that has not called the model paints
		// exactly the pre-round row.
		dock.setStatus(
			idleStatus(
				modeDisplay(),
				statusModelLabel(session),
				displayCtxRatio(session),
				{
					cacheHitPct: cacheHitPct(runUsage),
					costUsd: spentUsd,
					tokPerSec: lastTokPerSec,
				},
				// DF-0330-F1: the row's budget. Without it the row is composed
				// blind and invariant ① cuts whatever sits last — which is how
				// a measured rate went missing at 100 columns.
				rowWidth(),
				!floorOn,
			),
		);
	};
	// TUI2-R2 ⑥ — the BOOT status line. The row is the product's one
	// persistent claim about itself (the tier, how to change it, the model,
	// the context left), and it used to appear after turn ONE: the
	// idle-fresh screen — the screen every session opens on — showed an
	// empty row where all of that belongs.
	//
	// Nothing had to be computed to fix it. paintIdle already had every
	// field at this point: the mode is set before the agent is built, the
	// model is resolved inside it, and an unstarted session's context
	// estimate is a perfectly good 100%. It was simply never called until
	// a turn ended. One call, and the SAME formatter — a boot-time copy of
	// the row would drift from the real one the moment either changed.
	paintIdle();
	// DF-0311-F1 (the 0.31.1 dogfood, reproduced by the owner): the meter is
	// the last TURN's figure. After /model the row named the NEW model beside
	// the OLD model's CH until the next recap — and beside a model whose
	// cache is unobservable (OR-10) that is a measurement it never had. A new
	// binding starts with no meter; its first turn paints the first figure.
	// The session's running cost is untouched: it is the session's, not the
	// binding's, and the row does not render it anyway.
	const modelSwitched = (): void => {
		runUsage = { in: null, out: null, cache: null, known: false };
		lastTokPerSec = null; // TPS-1: the rate belonged to the old binding
		paintIdle();
	};
	const statusCb = (u: RunUsage, ctx: number, costUsd?: number | null, tokPerSec?: number | null): void => {
		runUsage = u;
		addCost(costUsd ?? null);
		// TPS-1: a call that could not be measured leaves the row as it was
		// rather than blanking a figure the previous call earned.
		if (tokPerSec != null) lastTokPerSec = tokPerSec;
		paintRunning();
	};
	// TUI2-R1 (E): the canonical cost of one settled request, added to the
	// session's running total. A null cost (no rate for the route) adds
	// nothing and leaves the total as it was.
	const addCost = (usd: number | null): void => {
		if (usd === null) return;
		spentUsd = (spentUsd ?? 0) + usd;
	};
	const queueTurn = (line: string, via?: UserInputVia): void => {
		const slot = { line: via?.kind === "skill" ? via.line : via?.kind === "tasks" ? taskNoticeRow(via.items) : line, content: line, ...(via !== undefined ? { via } : {}), cancelled: false };
		pendingTurns.push(slot);
		queued += 1;
		chainRef.current = chainRef.current.then(async () => {
			if (slot.cancelled) return; // the pop already dropped it — no double count
			const idx = pendingTurns.indexOf(slot);
			if (idx >= 0) pendingTurns.splice(idx, 1); // the chip leaves when the turn STARTS
			// KC2 §4 — the FRESH-TURN uncertainty gate. The runtime's fresh
			// path checks only the open-run gate before persisting
			// user_input (ResumeBlockedError guards the RESUME derivation
			// alone), and the CLI resolved uncertains at startup recovery
			// only — so a turn queued behind an abort-mid-tool could reach
			// the model before the human said whether the side effect
			// applied. It asks HERE, before the turn starts, with the same
			// recovery UI; a human who declines leaves it uncertain and the
			// turn does not start. The resolution's own model-facing fill
			// also answers the dangling tool_use, so the next request never
			// carries an unanswered call. Composed from existing APIs: zero
			// core lines, zero runtime lines.
			if (session.uncertainExecutions().length > 0) await resolveUncertains(session, input, () => cancelled);
			if (session.uncertainExecutions().length === 0) return turn(line, via);
			// The human declined (round 10: a cancelled ask records NOTHING —
			// the execution stays uncertain and durable), so the turn does not
			// start. It is never swallowed in silence: the held text is
			// printed back, so the human can see what is waiting on them.
			queued = Math.max(0, queued - 1);
			body.notice(`[turn held — the interrupted execution is still undecided] ${escapeTerminal(line)}`);
		});
	};
	// W22: the ↑/esc pop — the LAST queued slot leaves the queue
	// (cancelled + spliced + counted down); null when the queue is
	// empty. The chain segment skips the cancelled slot, so the popped
	// message NEVER runs — it returns to the editor instead.
	const popQueue = (): string | null => {
		const slot = pendingTurns[pendingTurns.length - 1];
		if (slot === undefined) return null;
		slot.cancelled = true;
		pendingTurns.pop();
		queued = Math.max(0, queued - 1);
		return slot.line;
	};
	// ADR-0057 (the owner's ruling, 2026-09-28): Enter while a run is live
	// is a STEER — there is no queue. `steering` mirrors what the run holds
	// and has not admitted; the run takes ALL of it at its next quiescent
	// boundary, and the landed user_input clears the rows. Piped and
	// task-file input keep one turn per line: a script has nobody steering.
	const steerable = process.stdin.isTTY === true && input.literal !== true;
	type Steer = { readonly line: string; readonly content: string; readonly via?: UserInputVia };
	let steering: Steer[] = [];
	const steer = (line: string, via?: UserInputVia): boolean => {
		if (!steerable || currentRun === null) return false;
		try {
			currentRun.steer(via !== undefined ? line : attachImages(line, input.attachments?.(), protectedFiles()));
		} catch (err) {
			if (err instanceof RunClosedError) return false; // the run is ending: this is the next turn
			throw err;
		}
		steering.push({ line: (via?.kind === "skill" ? via.line : undefined) ?? line, content: line, ...(via !== undefined ? { via } : {}) });
		return true;
	};
	const submitTurn = (line: string, via?: UserInputVia): void => {
		if (!steer(line, via)) queueTurn(line, via);
	};
	// ADR-0058 (3c): the session's task transitions reach the model — into a
	// live run at its next safe point, or, idle, as one wake turn through
	// the same chain a person's turn takes (taskWake: false keeps it for
	// the next message). Released when this chat ends.
	const taskManager = tasksFor(session.id);
	const stopTasks = taskManager === undefined ? () => {} : session.useTasks(taskManager, { wake: mergedConfig.taskWake !== false, onWake: (w) => queueTurn(w.content, w.via) });
	/** The mirror of the last `n` steers the run handed back; clears it. */
	const handed = (n: number): Steer[] => {
		const out = n > 0 ? steering.slice(-n) : [];
		steering = [];
		return out;
	};
	const landed = (): void => {
		steering = [];
	};
	/** A run sealed with steers still pending (max_turns, an END_TURN
	 *  result, an error): they are the person's next message, sent now. */
	const handBack = (run: Run): void => {
		const left = handed(run.unadmitted().length);
		if (left.length === 1) queueTurn(left[0]!.content, left[0]!.via);
		else if (left.length > 1) queueTurn(left.map((s) => s.content).join("\n\n"));
	};
	/** Esc / ctrl+c: a stop is not a send — steers that have not landed
	 *  go back to the editor. */
	const giveBack = (): void => {
		if (currentRun === null) return;
		const back = handed(currentRun.retract().length);
		if (back.length > 0) input.restore?.(back.map((s) => s.line).join("\n"));
	};
	/** ↑ takes back the LAST steer that has not landed (the others go back
	 *  in, in order); with none, the pipe-era queue pop. */
	const popPending = (): string | null => {
		if (currentRun !== null && steering.length > 0) {
			const back = currentRun.retract();
			const mine = handed(back.length);
			const last = mine.pop();
			for (const c of back.slice(0, -1)) currentRun.steer(c);
			steering = mine;
			if (last !== undefined) return last.line;
		}
		return popQueue();
	};
	// W22: the visibility invariant's binds — the dock renders the
	// pending chips, the editor routes the pop keys.
	const pendingLines = (): readonly string[] => [...steering.map((s) => s.line), ...pendingTurns.map((s) => s.line)];
	dock.bindQueue(pendingLines);
	input.bindQueue(pendingLines, popPending);
	const dispatchCtx: DispatchCtx = {
		session,
		input,
		chainRef,
		isRunning: () => currentRun !== null,
		paintIdle,
		modelSwitched,
		submitTurn,
		estimateCtx: () => displayCtxRatio(session),
		contextWindow: () => contextWindowTokens(),
		// the /resume+/clear mini-spec: the switch directive and the
		// session-navigation seam (absent nav = the commands degrade to
		// an honest refusal in dispatch)
		// DC-57: the dispatch edge asks this before it answers a line, so the
		// decision is made when the line's segment runs — not when its bytes
		// arrived, which can be before the switch was even requested.
		leaving: () => leaving,
		requestSwitch: (id: string) => {
			switchTo = id;
			leaving = true;
			resolveEnd();
		},
		requestReload: () => {
			reloadReq = true;
			leaving = true;
			resolveEnd();
		},
		sessions: () => nav?.sessions() ?? [],
		...(nav?.route !== undefined ? { route: nav.route } : {}),
		...(nav?.pick !== undefined ? { pickSession: nav.pick } : {}),
	};
	// the ergonomics batch C8: the auto-compact check — the /compact FULL path via the
	// shared dispatch (same notices, same chain ordering, same mid-run
	// refusal — the isRunning guard here only avoids the refusal's noise).
	// The appended segment is NOT awaited here on purpose: from inside a
	// chain segment, awaiting the append would be circular (the segment
	// chains after THIS segment's promise). The exit path re-awaits the
	// chain once more after the turn — see the final awaits in chat().
	const maybeAutoCompact = (): void => {
		if (autoCompact === undefined) return;
		if (currentRun !== null) return; // dispatch would refuse — skip the noise
		const ratio = autoCompactRatio(session); // A1a: the policy keeps the pre-A1a number — A1b decides if it moves
		if (!Number.isFinite(ratio) || ratio < autoCompact.thresholdRatio) return;
		dispatch("/compact", dispatchCtx);
	};
	// CX-1 F5: a literal input (task-file mode) submits the turn directly —
	// its bytes never meet the slash dispatcher.
	const route = (line: string): void => {
		if (input.literal === true) dispatchCtx.submitTurn(line);
		else dispatch(line, dispatchCtx);
	};
	input.onLine((line) => {
		if (!replReady || leaving) {
			queuedLines.push(line);
			return;
		}
		route(line);
	});
	// W15: the expand key — the editor forwards ctrl+o; dispatch runs the
	// chain action (the sentinel's control char marks the key, so a typed
	// "expand" turn is never intercepted).
	input.onExpand(() => dispatch("\x12expand", dispatchCtx));
	input.onThink?.(() => dispatch("\x14think", dispatchCtx));
	input.onEditor?.(() => dispatch("\x07editor", dispatchCtx));
	// E1 §3 — ctrl+x and `/copy` are the same action reached two ways, so
	// they are the same sentinel: one implementation, one behaviour.
	input.onCopy(() => dispatch("\x18copy", dispatchCtx));
	// R3a — Shift+Tab: the approval-tier cycle (the /mode ring, in the
	// OFFERED order — a session started in `manual` steps to the first).
	// The switch is the SAME live-extension flip /mode performs; the status
	// row repaints at once with a one-line notice.
	input.onModeCycle?.(() => {
		const next = OFFERED_MODES[(OFFERED_MODES.indexOf(getMode()) + 1) % OFFERED_MODES.length]!;
		const wasOn = getDontAsk();
		setMode(next);
		paintIdle();
		body.notice(`mode → ${MODE_LABEL[next]} (shift+tab cycles)`);
		// the switch came with the old dontAsk tier, and left with it
		if (getDontAsk() !== wasOn) body.notice("don't ask → off");
	});

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// round 8: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, input, () => cancelled);
	// 0.40.0 item 9: a big session whose cache has gone cold compacts BEFORE
	// its first request, on the person's word — or without asking in
	// dontAsk, where compacting is not an approval. A piped session is left
	// to the auto policy, which fires above the hard tier on its own. Lines
	// typed meanwhile queue behind the compaction.
	//
	// The owner's dogfood: asked BEFORE the recovery run. A session whose
	// last run was cut resumes that run at once, and the resume's first
	// request is the whole cold prefix — asked afterwards, the question is
	// about a bill already paid (and the in-run tiers have usually shrunk the
	// context by then, so it is never asked at all). The compaction settles
	// before the run resumes: the run continues on the compacted projection.
	const cold = !cancelled && process.stdin.isTTY ? coldResumeOffer(session) : null;
	if (cold !== null) {
		if (getDontAsk()) {
			body.notice(`[dontAsk] ${coldResumeLine(cold.tokens, cold.minutes)} — compacting first`);
			dispatch("/compact", dispatchCtx);
		} else if ((await askPanel(input, coldResumeView(cold.tokens, cold.minutes))).action === "allow") {
			dispatch("/compact", dispatchCtx);
		}
		await chainRef.current;
	}
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		turnNo += 1;
		// TUI2-R1.5 ③ (VD-3 family): stamp the run's start AT the run's
		// entry. Every other run path does; this one inherited the value
		// from the process's own startup, so its "working Ns" was the
		// session's age rather than the recovery's. The drift is small
		// today (recovery follows startup closely) and unbounded in
		// principle — a slow MCP connect is seconds the recovery never
		// spent, reported as seconds it did.
		runStart = Date.now();
		runUsage = { in: null, out: null, cache: null, known: false };
		lastTokPerSec = null; // TPS-1: nothing has settled in THIS turn yet
		const last = await consumeRun(session, recoveryRun, input, turnNo, faux, statusCb, submitTurn, landed);
		currentRun = null;
		handBack(recoveryRun);
		failOnFauxExhaustion(last, faux, input);
		// E group (the graceful-exit gate ③): the same deferred re-check
		// as the turn path — the recovery run's end is also a safe point.
		if (eotSeen) exitAtEmptyPrompt();
		maybeAutoCompact(); // the ergonomics batch C8: the recovery run ended too — same check (awaited by the exit re-await)
	}
	if (cancelled) {
		input.close();
		await input.closed;
		return { next: "exit" };
	}
	// The REPL is ready: replay anything that arrived during recovery.
	replReady = true;
	// v2c: dispatch SYNCHRONOUSLY — each call appends its segment to the
	// chain variable; the final `await chain` then covers every replayed
	// turn. A chain.then(() => dispatch()) indirection would capture the
	// chain BEFORE the appends and the replayed turns would never be
	// awaited (the F-group regression).
	for (const line of queuedLines) {
		route(line);
	}
	queuedLines.length = 0;
	input.prompt();
	// the REPL ends by CLOSE (exit) or by SWITCH (/clear, /resume) — the
	// switch leaves the editor alive for the next chat() entry
	await Promise.race([input.closed, endSignal]);
	await chainRef.current; // never exit while a turn is in flight
	// the ergonomics batch C8: the auto-compact may have appended ITS segment inside the
	// turn (the check runs at the turn's end, after the exit-await above
	// already captured the chain) — re-await once so the summarize either
	// runs before the exit or the chain is already settled. One level is
	// enough: the /compact segment appends nothing of its own.
	await chainRef.current;
	stopTasks();
	if (switchTo !== null) return { next: "switch", id: switchTo, lines: queuedLines.slice() };
	// a switch beats a reload: /resume and /clear are going somewhere else,
	// and the agent they land on is rebuilt by the caller either way.
	return reloadReq ? { next: "reload", id: session.id, lines: queuedLines.slice() } : { next: "exit" };
}
