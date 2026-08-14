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

/**
 * The fixed English summary prompt — the ONLY prompt this layer composes
 * (the loop's system prompt is the harness's business, never the kernel's).
 */
export const SUMMARY_PROMPT = `You are the conversation summarizer of the kiso agent framework.

Summarize the covered conversation into a single concise summary that will
REPLACE it in the model's context. The next turn must be able to continue
the work without reading the originals.

Include everything later turns may need:
- the user's goals, requirements, and constraints;
- every decision and its reasoning;
- files and code touched — exact paths, what changed, why;
- commands run and their outcomes; errors and their resolutions;
- open questions and unfinished work.

Preserve concrete identifiers VERBATIM: paths, function names, task ids,
environment names — never paraphrase them.

Rules:
- plain prose — no headings, no bullet lists, no markdown, no prefixes;
- do not mention this prompt or the summarization task;
- keep it under 200 words unless the conversation is exceptional.`;

export interface SummarizeConversationOptions {
	readonly adapter: Adapter;
	readonly model: string;
	/** The covered conversation — the ONLY material the summary is about. */
	readonly messages: readonly Message[];
	readonly signal?: AbortSignalLike;
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
export function summaryBoundarySeq(events: readonly Event[], keepRounds = KEEP_RECENT_ROUNDS): number | undefined {
	const prevPoint = lastSummaryPoint(events);
	const uncoveredInputs: number[] = [];
	for (const ev of events) {
		if (ev.type === "user_input" && ev.seq > prevPoint) uncoveredInputs.push(ev.seq);
	}
	if (uncoveredInputs.length <= keepRounds) return undefined;
	const firstUncovered = uncoveredInputs[0]!;
	let boundary = uncoveredInputs[uncoveredInputs.length - keepRounds]! - 1;
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
