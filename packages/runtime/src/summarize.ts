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

import { estimateTokens, DO_NOT_COMPACT } from "@vincemakes/kiso-core";
import type { AbortSignalLike, Adapter } from "@vincemakes/kiso-core";
import type { Event } from "@vincemakes/kiso-core";
import type { Message } from "@vincemakes/kiso-core";
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
export const POLICY_RESERVE = SUMMARY_MAX_OUTPUT + KEEP_TOKENS_DEFAULT + IN_FLIGHT_HEADROOM;

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
	// E6 (d) (the order's R4): the old summary texts are RETAINED CONTEXT —
	// the durable record of the earlier ranges. They render first, labeled
	// do-not-re-summarize: the summarizer must know what the earlier
	// summaries covered, but never fold them into the new checkpoint.
	const retained = events.filter(
		(e): e is Event & { type: "summarized" } => e.type === "summarized" && e.coversToSeq <= prevPoint,
	);
	if (retained.length > 0) {
		lines.push("[retained context — do not re-summarize]");
		for (const r of retained) lines.push(`[summary covers to seq ${r.coversToSeq}] ${r.summary}`);
		lines.push("[end retained context]");
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
that will REPLACE it in the model's context. The next turn must be able
to continue the work without reading the originals.

Produce the checkpoint with exactly these sections, in this order:

## Goal
The user's goal and the acceptance criterion, in one or two sentences.

## Constraints
The constraints, requirements, and rulings the work must honor.

## User requests
Every user message in the covered range, enumerated one by one, each
with what it asked for and what was done about it.

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
	/** The covered conversation — the ONLY material the summary is about. */
	readonly messages: readonly Message[];
	readonly signal?: AbortSignalLike;
	/** E6 (g): the summary call's explicit output budget (adapter maxTokens). */
	readonly maxOutputTokens?: number;
}

/** The summary call's result — the text PLUS the provider-reported usage
 *  (E6: the honest accounting — the summary call's cost rides the trace
 *  ledger; the E5-era extraction could not see it). Null when the
 *  provider reported no usage (known:false). */
export interface SummarizeConversationResult {
	readonly text: string;
	readonly usage: RawUsage | null;
}

/**
 * The one-shot summary call. Collects the adapter's text deltas into the
 * summary; usage/stop pass through untouched. Throws when the model
 * produced no text — the caller reports it and nothing is persisted.
 */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeConversationResult> {
	const { adapter, model, messages } = options;
	let text = "";
	let usage: RawUsage | null = null;
	for await (const ev of adapter.stream({
		model,
		messages,
		systemPrompt: SUMMARY_PROMPT,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}),
	})) {
		if (ev.type === "text_delta") text += ev.text;
		// The LAST usage event is the call's (a turn reports usage once).
		if (ev.type === "usage" && ev.known) {
			usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite };
		}
	}
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
function estimateEventTokens(ev: Event): number {
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
 * memory (the task_set echo) — the summary must never cover its round,
 * or the model loses the current list. When the base boundary would
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
		const keptTokens = (b: number): number => total - prefixTokens[b + 1];
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
