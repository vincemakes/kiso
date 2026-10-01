/**
 * The /compact summary layer (ADR-0044) — the MODEL-GENERATED half of
 * context economy. the home-relocation extraction (0.1.26 gate ruling): this OFF-LOOP
 * ORCHESTRATION lived in the kernel by a context-round expedience; it
 * calls the ADAPTER to generate the summary, which is the RUNTIME's
 * business — the kernel's duty is the `summarized` EVENT TYPE and the
 * projection semantics (kernel/project.ts), not who calls the model.
 * The mechanical half (microcompact) stays in the kernel (compaction.ts).
 *
 * The summary call is OFF-LOOP: it goes through the session's OWN adapter
 * (no new dependency), writes no events, and never touches the log — a
 * failure throws, the caller reports it honestly, and the session is
 * unchanged ("nothing happened"). Only the generated `summarized` event
 * lands on disk; the original events stay there forever.
 */

import { DO_NOT_COMPACT, DEFAULT_MAX_RETRIES, RETRY_AFTER_MAX_MS, retryDelayMs } from "@vincemakes/kiso-core";
import type { AbortSignalLike, Adapter, RetryInfo, ToolSpec } from "@vincemakes/kiso-core";
import type { Event } from "@vincemakes/kiso-core";
import type { Message } from "@vincemakes/kiso-core";
import { estimateTokens } from "./estimate-tokens.js";
import type { RawUsage } from "./usage/canonical.js";

/** K (ADR-0044): the recent ROUNDS kept intact by /compact — a constant,
 *  not a knob. The covered range ends just before the K-th most recent
 *  round, so the model still reasons over the recent conversation. */
export const KEEP_RECENT_ROUNDS = 4;

/** E6 (a) — the input-side DSML guard (the finding E6-F4/F5 follow-up):
 *  the guard sentence sits at the TOP of the system prompt (the BEFORE
 *  copy of the sandwich) AND again after the </conversation> block in the
 *  serialized input (the AFTER copy). The summarizer is a side-channel
 *  task — it must never continue the work, never touch tools, and only
 *  emit the summary text. */
export const SUMMARY_GUARD = "Only output the summary. Do not continue the conversation. Do not use any tools.";

/** The tool-result truncation ceiling in the serialized input: a huge
 *  result must not dominate the summary input, and the truncation is
 *  MARKED with the discarded character count — never silent. */
export const SUMMARY_RESULT_MAX_CHARS = 2000;

/**
 * E6 (g) — the reserve arithmetic (the pre-registered numbers): the
 * armed trigger is WINDOW − RESERVE, never a fixed low absolute (the
 * e6probe's fixed 1300 fired 16-19× a session — the pathology the
 * window math kills). The reserve is what ONE fire must buy back:
 * the summary's own output budget (4,000), the kept-suffix token
 * floor (20,000, item (f)), and the current run's in-flight context
 * while the post-fire projection settles (8,000).
 */
export const SUMMARY_MAX_OUTPUT = 4000;
export const KEEP_TOKENS_DEFAULT = 20000;
export const IN_FLIGHT_HEADROOM = 8000;
/** ONE NUMBER, TWO CONSUMERS. `SUMMARY_MAX_OUTPUT` is both the summary
 *  call's output budget AND a term of this reserve — the reserve buys
 *  back room for exactly that much summary. Change one and you have
 *  changed the other; see `MANUAL_SUMMARY_BUDGET` for why the manual
 *  gesture's larger budget does NOT reach the auto policy that reads this. */
export const POLICY_RESERVE = SUMMARY_MAX_OUTPUT + KEEP_TOKENS_DEFAULT + IN_FLIGHT_HEADROOM;

/**
 * 0.39.2 — the output budget of a MANUAL `/compact`, and it is MEASURED.
 *
 * The fixed 4,000 failed live sessions: `the summary turn ended with
 * max_tokens`. On the failing profile (an unregistered DeepSeek model
 * behind a gateway), a covered range the size of the reported one —
 * ~100k tokens of real source — was run three ways:
 *
 *   budget  4,000  → max_tokens   reasoning 3,093   checkpoint    828   3 of 7 sections
 *   budget  8,391  → max_tokens   reasoning 1,613   checkpoint  6,544   4 of 7
 *   budget 32,000  → end_turn     reasoning 3,557   checkpoint 15,261   7 of 7
 *
 * A complete checkpoint took 18,837 output tokens. At 4,000 the reasoning
 * LOOKED like the cause (77% of the budget) only because the budget was
 * too small for the checkpoint to get going; with room, reasoning is a
 * fifth and the checkpoint itself is the size. A rule scaled from the
 * covered estimate (a twelfth: 8,391, doubling to 16,782 on retry) was
 * built first and failed BOTH attempts on this data — it was a guess, and
 * the measurement is what falsified it.
 *
 * So the budget is not scaled; it is a generous flat CAP, because a cap
 * is not a charge — the model is billed for what it writes, and a higher
 * limit costs nothing unless the output would have run away anyway. The
 * one thing a lower first budget buys is a failed call before the one
 * that works. 32,000 holds the measured 18,837 with room, and bounds what
 * a genuinely runaway summary can cost: a checkpoint larger than this has
 * stopped being a summary.
 *
 * MANUAL ONLY, and that is the patch boundary. The auto policy's
 * `POLICY_RESERVE` assumes `SUMMARY_MAX_OUTPUT`; giving the policy a larger
 * budget without moving its reserve would let a fire leave less room than
 * the reserve promised, and moving the reserve moves every session's
 * compaction trigger — BM-1 §3's compaction tier, where the paired bench
 * blocks. That belongs to A1b, and the measurement above is its input.
 */
export const MANUAL_SUMMARY_BUDGET = 32_000;

/** Thrown by an attempt that stopped on `max_tokens`, and it NAMES the
 *  budget: "not a complete turn" alone told the person nothing about what
 *  ran out. Still an `Error`, and still carries the `max_tokens … not a
 *  complete turn` wording the CX-1 F3 gate matches. */
export class SummaryBudgetExhausted extends Error {
	constructor(readonly budget: number | undefined) {
		super(
			budget === undefined
				? "the summary turn ended with max_tokens — not a complete turn"
				: `the summary turn ended with max_tokens — it needed more than its ${budget}-token output budget, not a complete turn`,
		);
	}
}

/** The reference context-window scale (the flash-family window); the
 *  env overrides. The default arming point is 120,000 − 32,000 =
 *  88,000 — a post-fire projection (≥ 24k) can never re-cross it, so
 *  the session settles after one fire. */
export const DEFAULT_CONTEXT_WINDOW = 120000;

/** The armed trigger for a context window: window − POLICY_RESERVE. A
 *  window below the reserve arms a NEGATIVE trigger — the session
 *  never fires (the honest inert refusal: the window cannot hold even
 *  the post-fire projection, so the policy stays off, never clamped
 *  into pretending). */
export function policyTriggerFromWindow(windowTokens: number = DEFAULT_CONTEXT_WINDOW): number {
	return windowTokens - POLICY_RESERVE;
}

/**
 * E6 (h) — the circuit breaker: MAX_SUMMARY_FAILURES consecutive
 * summary failures per session stand the auto policy down (no further
 * auto-fire attempts; a success resets). Both adapter failures and the
 * (b) validation rejections count — they throw through the policy's
 * safe catch. A persistent summary failure (a broken provider, a
 * hostile model) must never wedge the session into paying the call
 * every run.
 */
export const MAX_SUMMARY_FAILURES = 3;

/**
 * E6 (a) — the covered range serialized to FLAT TEXT, one <conversation>
 * block, role-labeled lines ([user]/[assistant]/[tool call name]/[tool
 * result]), tool results truncated at SUMMARY_RESULT_MAX_CHARS with a
 * "(… N more chars truncated)" marker, and the SUMMARY_GUARD sentence
 * past the block's close. The model never sees the raw message array —
 * the auto-T5-1 tool-call DSML garbage (the E6-F4/F5 signature) was the
 * model echoing provider markup back from a raw-message-shaped input.
 * The serializer only renders the surface the summary is about; thinking
 * and other non-transcript events stay out of the input.
 */
export interface SerializeCoveredOptions {
	readonly events: readonly Event[];
	/** The previous summary point — events at/before it are already covered. */
	readonly prevPoint: number;
	/** The covered range's end — the covered range is (prevPoint, boundary]. */
	readonly boundary: number;
}

export function serializeCovered(options: SerializeCoveredOptions): string {
	const { events, prevPoint, boundary } = options;
	const lines: string[] = ["<conversation>"];
	// ADR-0055 Amendment 2 (E6 (d)'s "do not re-summarize" retired): the
	// new checkpoint REPLACES the previous one, so the summariser is given
	// exactly the checkpoint the projection shows — the latest at or before
	// prevPoint — as material to fold in. The superseded ones are not shown:
	// the latest already restates them.
	let previous: (Event & { type: "summarized" }) | undefined;
	for (const e of events) {
		if (e.type === "summarized" && e.coversToSeq <= prevPoint && (previous === undefined || e.coversToSeq >= previous.coversToSeq)) previous = e;
	}
	if (previous !== undefined) {
		lines.push("[previous checkpoint — the new checkpoint replaces it: carry forward everything in it that is still true]");
		lines.push(previous.summary);
		lines.push("[end previous checkpoint]");
	}
	for (const ev of events) {
		if (ev.seq <= prevPoint || ev.seq > boundary || ev.type === "summarized") continue;
		switch (ev.type) {
			case "user_input":
				lines.push(`[user] ${ev.content}`);
				break;
			case "text_delta":
				lines.push(`[assistant] ${ev.text}`);
				break;
			case "tool_call_end":
				lines.push(`[tool call ${ev.name}] ${JSON.stringify(ev.input ?? null)}`);
				break;
			case "tool_result": {
				const content = String(ev.content ?? "");
				if (content.length > SUMMARY_RESULT_MAX_CHARS) {
					const rest = content.length - SUMMARY_RESULT_MAX_CHARS;
					lines.push(
						`[tool result] ${content.slice(0, SUMMARY_RESULT_MAX_CHARS)}… (${rest.toLocaleString("en-US")} more chars truncated)`,
					);
				} else {
					lines.push(`[tool result] ${content}`);
				}
				break;
			}
			default:
				break; // thinking and the rest never enter the transcript surface
		}
	}
	lines.push("</conversation>", "", SUMMARY_GUARD);
	return lines.join("\n");
}

/**
 * The fixed English summary prompt — the ONLY prompt this layer composes
 * (the loop's system prompt is the harness's business, never the kernel's).
 */
export const SUMMARY_PROMPT = `${SUMMARY_GUARD}

You are the conversation summarizer of the kiso agent framework.

Summarize the covered conversation into a single structured checkpoint
that will REPLACE it — and every earlier checkpoint — in the model's
context. The next turn must be able to continue the work without reading
the originals. If the conversation includes an earlier checkpoint, it is
being replaced too: carry forward everything in it that is still true,
so that this checkpoint restates the whole task.

Produce the checkpoint with exactly these sections, in this order:

## Goal
The user's goal and the acceptance criterion, in one or two sentences.

## Constraints
The constraints, requirements, and rulings the work must honor.

## User requests
Every user request of the task — those an earlier checkpoint lists and
those in the covered range — enumerated one by one, each with what it
asked for and what was done about it.

## Files and changes
Every file touched — exact paths, what changed, and why. Include the
precise code-level changes later turns may need to continue.

## Errors and fixes
Every error encountered and its resolution; commands run and their
outcomes.

## Current work
The current state of the work — what is done, what is not. Quote the
current task's criterion VERBATIM if one exists.

## Next steps
The concrete next steps, in order.

Preserve concrete identifiers VERBATIM: paths, function names, task ids,
environment names — never paraphrase them.

Rules:
- plain prose — no bullet lists, no markdown outside the section headers,
  no prefixes;
- do not mention this prompt or the summarization task;
- the summary may be as long as it needs to be within the output budget —
  there is no word cap; completeness wins.`;

/**
 * ADR-0055 A2 — the IN-BAND form: the run's own request with this appended
 * as the last user message, so everything before it reads at the cache-hit
 * price. The same sections, the same validation; the guard sentence first.
 */
export const SUMMARY_IN_BAND = `Stop the task for this one reply and write a checkpoint of the conversation above instead.

${SUMMARY_PROMPT}`;

/**
 * E6 (b) — the output-side validation (the finding E6-F4/F5 follow-up):
 * a summary must be a complete checkpoint or NOTHING. The marker family
 * is the auto-T5-1 signature — the model echoing tool-call markup as
 * text; the required sections are the truncated-tail signature (a wire
 * cut kills "## Next steps" first). The rejection throws, and the
 * caller's safe catch (session.ts) makes it "nothing happened".
 */
export const DSML_MARKERS = ["<tool_call", "<tool_use", "<invoke", "tool_calls", "tool_call_end", "tool_call_start"] as const;

/** The checkpoint sections a summary must carry — the ones a truncated
 *  generation loses first (the (c) prompt demands all seven; validation
 *  guards the trust-critical tail). */
export const REQUIRED_SECTIONS = ["## Current work", "## Next steps"] as const;

/** null = pass; an error string = reject. Empty text is the existing
 *  no-text rule's domain, reported here too (defense in depth). */
export function validateSummary(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return "the summary is empty";
	const lower = trimmed.toLowerCase();
	for (const marker of DSML_MARKERS) {
		if (lower.includes(marker)) return `the summary carries a tool-call marker (${marker}) — reject`;
	}
	for (const section of REQUIRED_SECTIONS) {
		if (!trimmed.includes(section)) return `the summary is missing the required section ${section} — a truncated or incomplete checkpoint`;
	}
	return null;
}

export interface SummarizeConversationOptions {
	readonly adapter: Adapter;
	readonly model: string;
	/** ADR-0055 A2: send `messages` AS THE RUN SENT THEM, under the run's own
	 *  system prompt and tool table, with SUMMARY_IN_BAND appended — the
	 *  cache-hot form. Absent: `messages` is the serialized covered range
	 *  under SUMMARY_PROMPT, the cold form. */
	readonly inBand?: { readonly systemPrompt?: string; readonly tools: readonly ToolSpec[]; readonly focus?: string };
	/** The covered conversation — the ONLY material the summary is about. */
	readonly messages: readonly Message[];
	readonly signal?: AbortSignalLike;
	/** E6 (g): the summary call's explicit output budget (adapter maxTokens). */
	readonly maxOutputTokens?: number;
	/** 0.39.2: the RESOLVED reasoning for the summary call — native wire
	 *  values from `resolveReasoning`, never a raw field. Absent sends
	 *  nothing, and the provider's default applies. */
	readonly reasoning?: { readonly thinking?: "adaptive" | "enabled" | "disabled"; readonly effort?: string };
	/** ADR-0005 Amendment 2: the kernel's retry budget, applied to this
	 *  off-loop call. Absent, the kernel's default. */
	readonly maxRetries?: number;
	/** ADR-0005 Amendment 2: announced before each wait, as the kernel
	 *  announces its own. Observation only — a throw is swallowed. */
	readonly onRetry?: (info: RetryInfo) => Promise<void> | void;
	/** 0.40.0: how much of the OUTPUT budget the call has spent so far —
	 *  reported at each attempt's start (zero) and as text, reasoning and
	 *  the final usage arrive. Observation only: a throw is swallowed, and
	 *  the request is identical with or without it. */
	readonly onProgress?: (progress: SummaryProgress) => void;
}

/**
 * 0.40.0 — the summary call's progress against its output budget.
 *
 * `produced` counts streamed text AND streamed reasoning (owner's ruling —
 * a bar over text alone sits low while thinking spends the budget, and the
 * call then fails at "full"), by the session's chars/4 proxy, until the
 * provider reports its output total, which replaces the estimate
 * (`reported`). `reasoningUnseen`: the provider billed reasoning that never
 * streamed, so the jump to the reported total has a named cause.
 */
export interface SummaryProgress {
	readonly produced: number;
	/** the call's output budget; null when the call carries none */
	readonly budget: number | null;
	readonly reasoningUnseen: boolean;
	readonly reported: boolean;
}

/** The summary call's result — the text PLUS the provider-reported usage
 *  (E6: the honest accounting — the summary call's cost rides the trace
 *  ledger; the E5-era extraction could not see it). Null when the
 *  provider reported no usage (known:false). */
export interface SummarizeConversationResult {
	readonly text: string;
	readonly usage: RawUsage | null;
}

/** A thrown value the adapter CLASSIFIED — `{ code, retryable, message }`
 *  (ADR-0005 rule 1). The core's own guard is private, and this asks a
 *  narrower question than that one: is this a failure someone already
 *  decided is worth trying again. A validation rejection below is a plain
 *  `Error` and can never match, which is the separation E6 (b) wants —
 *  "the model wrote a bad summary" is not retried, ever. */
function retryableStructured(err: unknown): boolean {
	if (err === null || typeof err !== "object") return false;
	const e = err as { code?: unknown; retryable?: unknown; message?: unknown };
	return typeof e.code === "string" && typeof e.message === "string" && e.retryable === true;
}

/** The provider's own Retry-After, when the adapter normalized one. */
function askedWaitMs(err: unknown): number | undefined {
	const asked = (err as { retryAfterMs?: unknown }).retryAfterMs;
	return typeof asked === "number" && Number.isFinite(asked) && asked >= 0 ? asked : undefined;
}

/** The kernel's abortable wait, restated for the one call that is not the
 *  kernel's: a cancel during the backoff wakes it at once. */
function wait(ms: number, signal?: AbortSignalLike): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener?.(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * The summary call, retried under the KERNEL'S policy.
 *
 * 0.39.1: `/compact` had no retry at all. The kernel owns retries
 * (ADR-0005) and this path does not go through the kernel — it calls the
 * adapter directly — so a gateway that drops a 95k-token summary stream
 * failed `/compact` every single time, with an honest message and no way
 * forward. The adapter classifies that as a retryable `network` failure
 * (the transport-failure-after-headers class); here is the only place
 * that can act on it.
 *
 * 0.39.1 gave it ONE retry after 250 ms. ADR-0005 Amendment 2 gives it the
 * kernel's rule instead, because a dropped summary stream is the same
 * failure as a dropped turn and meets the same gateway: the same curve,
 * the same budget (the same `maxRetries` knob), Retry-After as a floor and
 * a wait beyond RETRY_AFTER_MAX_MS as an explicit stop — never a retry
 * that comes early — and the same announcement before each wait. Each
 * retry re-pays the summary's input, exactly as each turn retry re-pays
 * the turn's; the budget that bounds one bounds the other.
 *
 * A permanent error still throws on the first attempt — the retry is
 * keyed on the classification the adapter already made, never on the
 * fact that something failed.
 */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeConversationResult> {
	// Asked as a CALL, twice, because `aborted` is a readonly property and
	// the narrowing from the first read would otherwise be carried across
	// the await — where the whole point is that it can have changed.
	const aborted = (): boolean => options.signal?.aborted === true;
	// A `max_tokens` stop is NOT retried here. A retry at the same budget
	// buys the same truncation, and a retry at a larger one is only worth
	// having if the first budget was chosen small — which is why the manual
	// gesture now asks for the whole measured budget up front instead
	// (see `MANUAL_SUMMARY_BUDGET`).
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	for (let attempts = 0; ; attempts += 1) {
		try {
			return await summaryAttempt(options);
		} catch (err) {
			// The caller's cancel is the caller's: an aborted `/compact` must
			// not spend another call on its way out.
			if (!retryableStructured(err) || aborted() || attempts >= maxRetries) throw err;
			const asked = askedWaitMs(err);
			const delay = retryDelayMs(attempts + 1, asked);
			const e = err as { code: string; message: string };
			if (delay > RETRY_AFTER_MAX_MS) {
				throw { ...e, retryable: false, message: `${e.message} (the provider asked to wait ${asked}ms — beyond the ${RETRY_AFTER_MAX_MS}ms cap; not retried)` };
			}
			try {
				await options.onRetry?.({ attempt: attempts + 1, maxRetries, code: e.code, delayMs: delay, midStream: false });
			} catch {
				// observation only
			}
			await wait(delay, options.signal);
			if (aborted()) throw err;
		}
	}
}

/**
 * ONE attempt. Collects the adapter's text deltas into the summary;
 * usage/stop pass through untouched. Throws when the model produced no
 * text — the caller reports it and nothing is persisted.
 */
async function summaryAttempt(options: SummarizeConversationOptions): Promise<SummarizeConversationResult> {
	const { adapter, model, messages } = options;
	let text = "";
	let usage: RawUsage | null = null;
	// CX-1 F3 (audit F3): the turn's SHAPE is validated, not just its text.
	// A max_tokens cut after the last required heading, a turn with no
	// stop, a turn that called a tool — all passed the section check and
	// were persisted as a checkpoint that was not one. Exactly one stop,
	// reason end_turn, zero tool-call events, no model output after the
	// stop; `usage` after the stop is the one permitted trailer.
	let stops = 0;
	let stopReason: string | undefined;
	let toolCalls = 0;
	let afterStop: string | undefined;
	// 0.40.0: the progress this attempt reports — it starts at zero, so a
	// retry visibly starts the bar again
	let streamedChars = 0;
	let sawReasoning = false;
	const report = (progress: SummaryProgress): void => {
		try {
			options.onProgress?.(progress);
		} catch {
			// observation only
		}
	};
	const budget = options.maxOutputTokens ?? null;
	report({ produced: 0, budget, reasoningUnseen: false, reported: false });
	const inBand = options.inBand;
	for await (const ev of adapter.stream({
		model,
		...(inBand === undefined
			? { messages, systemPrompt: SUMMARY_PROMPT }
			: {
					messages: [...messages, { role: "user" as const, content: inBand.focus === undefined ? SUMMARY_IN_BAND : `${SUMMARY_IN_BAND}\n\nFocus the summary on: ${inBand.focus}` }],
					...(inBand.systemPrompt !== undefined ? { systemPrompt: inBand.systemPrompt } : {}),
					tools: inBand.tools,
				}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
		...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
	})) {
		if (stops > 0 && ev.type !== "usage" && ev.type !== "stop" && afterStop === undefined) afterStop = ev.type;
		if (ev.type === "text_delta" || ev.type === "thinking") {
			if (ev.type === "text_delta") text += ev.text;
			else sawReasoning = true;
			streamedChars += ev.text.length;
			report({ produced: Math.ceil(streamedChars / 4), budget, reasoningUnseen: false, reported: false });
		} else if (ev.type === "tool_call_start" || ev.type === "tool_call_end" || ev.type === "tool_call_input_delta") toolCalls += 1;
		else if (ev.type === "stop") {
			stops += 1;
			stopReason = ev.reason;
		}
		// The LAST usage event is the call's (a turn reports usage once).
		if (ev.type === "usage" && ev.known) {
			// RSN-1, and the summary path was missed on the first wiring:
			// the quartet was copied field by field, so a fifth field added
			// later is silently dropped. The summary IS a billed call whose
			// cost the ledger records; leaving its split behind made that
			// one call's thinking unknown while every other call's was
			// measured. The output total was never wrong — the split was.
			usage = {
				inputTokens: ev.inputTokens,
				outputTokens: ev.outputTokens,
				cacheRead: ev.cacheRead,
				cacheWrite: ev.cacheWrite,
				...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
			};
			if (ev.outputTokens !== null) {
				report({ produced: ev.outputTokens, budget, reasoningUnseen: !sawReasoning && (ev.reasoningTokens ?? 0) > 0, reported: true });
			}
		}
	}
	if (stops === 0) throw new Error("the summary turn never stopped — not a complete turn");
	if (stops > 1) throw new Error(`the summary turn stopped ${stops} times — not a complete turn`);
	if (toolCalls > 0) throw new Error("the summary turn called a tool — a summary is text, never a tool call");
	// The one stop a larger budget can cure, told apart from the rest.
	if (stopReason === "max_tokens") throw new SummaryBudgetExhausted(options.maxOutputTokens);
	if (stopReason !== "end_turn") throw new Error(`the summary turn ended with ${String(stopReason)} — not a complete turn`);
	if (afterStop !== undefined) throw new Error(`the summary turn produced ${afterStop} after its stop — not a complete turn`);
	const trimmed = text.trim();
	if (trimmed === "") {
		throw new Error("the summary call produced no text");
	}
	// E6 (b): a non-checkpoint summary is an honest failure — throw, the
	// caller reports it, nothing is persisted (the auto-T5-1 regression).
	const invalid = validateSummary(trimmed);
	if (invalid !== null) {
		throw new Error(`the summary call produced an invalid summary: ${invalid}`);
	}
	return { text: trimmed, usage };
}

/** E6 — the crux-experiment drop arm: the covered turns are replaced by
 *  this fixed placeholder with NO model call. Experiment-only (the
 *  contextPolicy drop mode); the adopted shape — if the crux evidence
 *  earns it — is a distinct `dropped` event family, not this text. */
export const DROP_PLACEHOLDER = "[e6-crux: the covered turns were dropped without a summary; continue from the kept turns and this placeholder]";

/**
 * The last summary point: the previous `summarized` event's coversToSeq,
 * or -1 (the trajectory's start) when none exists. The covered range of
 * the next summary runs from here.
 */
export function lastSummaryPoint(events: readonly Event[]): number {
	let prev = -1;
	for (const ev of events) {
		if (ev.type === "summarized" && ev.coversToSeq > prev) prev = ev.coversToSeq;
	}
	return prev;
}

/** The chars/4 token proxy for a single EVENT (the same convention as
 *  estimateTokens, event-shaped — the (f) keep-floor walk needs the kept
 *  suffix's tokens without projecting it). */
export function estimateEventTokens(ev: Event): number {
	switch (ev.type) {
		case "user_input":
			return Math.ceil(ev.content.length / 4);
		case "text_delta":
			return Math.ceil(ev.text.length / 4);
		case "tool_call_end":
			return Math.ceil(JSON.stringify(ev.input ?? null).length / 4) + 20;
		case "tool_result":
			return Math.ceil(String(ev.content ?? "").length / 4);
		default:
			return 0;
	}
}

/**
 * The covered range's end: the seq of the event just before the
 * keepRounds-th most recent user_input AFTER the last summary point —
 * a turn boundary by construction, so the projection's skip never splits
 * a message. Returns undefined when fewer than keepRounds+1 uncovered
 * rounds exist (nothing worth covering yet).
 *
 * ⑥ (task round): a tool result tagged do-not-compact is DURABLE work
 * memory (a tool declares it so; the retired task extension's list was
 * the first) — the summary must never cover its round, or the model
 * loses it. When the base boundary would
 * cover such a result, the boundary pulls back to just before the round
 * containing the LATEST one (still a turn boundary). A protected round
 * as the FIRST uncovered round leaves nothing before it to cover →
 * undefined (an honest "nothing to compact").
 *
 * P1 (0.1.42): the SAME pullback family now enforces the pairing
 * invariant — a boundary NEVER splits a tool_call/tool_result pair. A
 * mid-execution input leaves a covered call with a kept result, and the
 * projection renders an orphaned tool message (a real provider 400 — the
 * fresh2 family). The straddle pullback ITERATES to stability — every
 * straddled pair in the shrinking range pulls the boundary before its
 * round — while the protected pullback applies ONCE on the base range
 * (the operative list is the LATEST echo — the old ⑥ semantics:
 * superseded echoes stay coverable).
 */
export function summaryBoundarySeq(events: readonly Event[], keepRounds = KEEP_RECENT_ROUNDS, keepTokens?: number): number | undefined {
	const prevPoint = lastSummaryPoint(events);
	const uncoveredInputs: number[] = [];
	for (const ev of events) {
		if (ev.type === "user_input" && ev.seq > prevPoint) uncoveredInputs.push(ev.seq);
	}
	if (uncoveredInputs.length <= keepRounds) return undefined;
	const firstUncovered = uncoveredInputs[0]!;
	let boundary = uncoveredInputs[uncoveredInputs.length - keepRounds]! - 1;
	// E6 (f): the keep budget is rounds AND tokens. A kept suffix smaller
	// than keepTokens is a break the session cannot amortize (the E5-F1
	// accounting) — walk the boundary back (keep more) until the kept
	// events clear the floor. The walk picks the smallest kept suffix
	// meeting it: per-event cumulative tokens, one pass. A floor the whole
	// uncovered range cannot meet → nothing to compact (the policy is
	// inert on small sessions — the token-shaped restraint).
	if (keepTokens !== undefined && keepTokens > 0) {
		const prefixTokens: number[] = [0];
		let total = 0;
		for (const ev of events) {
			total += estimateEventTokens(ev);
			prefixTokens.push(total);
		}
		const keptTokens = (b: number): number => total - prefixTokens[b + 1]!;
		let floorBoundary: number | undefined;
		for (let i = uncoveredInputs.length - 1; i >= 0; i--) {
			const b = uncoveredInputs[i]! - 1;
			if (keptTokens(b) >= keepTokens) {
				floorBoundary = b;
				break;
			}
		}
		// b < firstUncovered covers no whole round (or the empty residue) —
		// the honest nothing-to-compact.
		if (floorBoundary === undefined || floorBoundary < firstUncovered) return undefined;
		if (floorBoundary < boundary) boundary = floorBoundary;
	}
	// The protected pullback applies ONCE on the base range (⑥); the
	// straddle pullback recomputes against the SHRINKING range below it.
	const protectedBoundary = latestProtectedBoundary(events, prevPoint, boundary);
	for (;;) {
		const straddleBoundary = latestStraddleBoundary(events, prevPoint, boundary);
		let pull: number | undefined = straddleBoundary;
		if (protectedBoundary !== undefined) {
			pull = pull === undefined ? protectedBoundary : Math.min(pull, protectedBoundary);
		}
		if (pull === undefined) return boundary;
		// Nothing before the first uncovered round (or before the previous
		// summary point) is coverable — the honest "nothing to compact".
		if (pull < firstUncovered || pull <= prevPoint) return undefined;
		if (pull >= boundary) return boundary; // stable — the pull never advances
		boundary = pull;
	}
}

/**
 * ⑥: the boundary just before the round holding the LATEST do-not-compact
 * tool result inside (prevPoint, base] — that round's opening user_input
 * minus one, or undefined when the range holds no such result. The
 * projection replaces by RANGE, so only the newest echo matters: older
 * tagged echoes are superseded and may be covered.
 */
function latestProtectedBoundary(events: readonly Event[], prevPoint: number, base: number): number | undefined {
	let protectSeq = -1;
	for (const ev of events) {
		if (
			ev.type === "tool_result" &&
			ev.seq > prevPoint &&
			ev.seq <= base &&
			(ev.tags ?? []).includes(DO_NOT_COMPACT)
		) {
			protectSeq = ev.seq;
		}
	}
	if (protectSeq < 0) return undefined;
	// The round's opening input: the last user_input before the result.
	// The result's whole round is uncovered by construction (the previous
	// compact ended at a turn boundary before its input), so the input is
	// > prevPoint — the guard is the belt.
	let inputSeq = -1;
	for (const ev of events) {
		if (ev.type === "user_input" && ev.seq > prevPoint && ev.seq < protectSeq) inputSeq = ev.seq;
	}
	if (inputSeq < 0) return undefined;
	return inputSeq - 1;
}

/**
 * P1 (0.1.42): the boundary just before the round holding the LATEST
 * tool_call_end in (prevPoint, cut] whose tool_result landed on the KEPT
 * side of the cut — covering the call alone would project an orphaned
 * tool message (the pairing invariant; the fresh2 400 family). Returns
 * the pair's round-opening input minus one — still a turn boundary —
 * or prevPoint when the round opened at or before the previous summary
 * point (the caller's `pull <= prevPoint` guard turns that into the
 * honest nothing-to-compact: the range holds no whole pair to keep, so
 * the compact is refused) — or undefined when the range holds no
 * straddled pair.
 */
function latestStraddleBoundary(events: readonly Event[], prevPoint: number, cut: number): number | undefined {
	let straddledCall = -1;
	for (const ev of events) {
		if (ev.type !== "tool_call_end" || ev.seq <= prevPoint || ev.seq > cut) continue;
		const keptResult = events.some((e) => e.type === "tool_result" && e.callId === ev.callId && e.seq > cut);
		if (keptResult) straddledCall = ev.seq;
	}
	if (straddledCall < 0) return undefined;
	// The pair's round opening: the last user_input before the call.
	let inputSeq = -1;
	for (const ev of events) {
		if (ev.type === "user_input" && ev.seq > prevPoint && ev.seq < straddledCall) inputSeq = ev.seq;
	}
	return inputSeq < 0 ? prevPoint : inputSeq - 1;
}

/**
 * The NoticeCell's number: estimated tokens of the covered content minus
 * the summary's own — the same chars/4 proxy as estimateTokens (a stable
 * MONOTONE savings figure, not a bill).
 */
export function estimateSummarySavings(covered: readonly Message[], summary: string): number {
	return Math.max(0, estimateTokens(covered) - Math.ceil(summary.length / 4));
}
