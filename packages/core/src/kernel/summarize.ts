/**
 * L2 — the /compact summary layer (ADR-0044): the MODEL-GENERATED half of
 * context economy. The mechanical half (microcompact, compaction.ts)
 * clears TOOL RESULTS only; this layer compresses the CONVERSATION itself
 * into one durable `summarized` event per call, replacing the covered
 * range with a single assistant summary message in the projection.
 *
 * The summary call is OFF-LOOP: it goes through the session's OWN adapter
 * (no new dependency), writes no events, and never touches the log — a
 * failure throws, the caller reports it honestly, and the session is
 * unchanged ("nothing happened"). Only the generated `summarized` event
 * lands on disk; the original events stay there forever.
 */

import type { AbortSignalLike, Adapter } from "../protocol/adapter.js";
import type { Event } from "../protocol/events.js";
import type { Message } from "../protocol/messages.js";
import { estimateTokens } from "./compaction.js";

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

/**
 * The one-shot summary call. Collects the adapter's text deltas into the
 * summary; usage/stop pass through untouched. Throws when the model
 * produced no text — the caller reports it and nothing is persisted.
 */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<string> {
	const { adapter, model, messages } = options;
	let text = "";
	for await (const ev of adapter.stream({
		model,
		messages,
		systemPrompt: SUMMARY_PROMPT,
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	})) {
		if (ev.type === "text_delta") text += ev.text;
	}
	const trimmed = text.trim();
	if (trimmed === "") {
		throw new Error("the summary call produced no text");
	}
	return trimmed;
}

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
 */
export function summaryBoundarySeq(events: readonly Event[], keepRounds = KEEP_RECENT_ROUNDS): number | undefined {
	const prevPoint = lastSummaryPoint(events);
	const uncoveredInputs: number[] = [];
	for (const ev of events) {
		if (ev.type === "user_input" && ev.seq > prevPoint) uncoveredInputs.push(ev.seq);
	}
	if (uncoveredInputs.length <= keepRounds) return undefined;
	// The input at m - keepRounds opens the FIRST KEPT round; everything
	// before it (m - keepRounds ≥ 1 covered rounds) is summarizable.
	return uncoveredInputs[uncoveredInputs.length - keepRounds]! - 1;
}

/**
 * The NoticeCell's number: estimated tokens of the covered content minus
 * the summary's own — the same chars/4 proxy as estimateTokens (a stable
 * MONOTONE savings figure, not a bill).
 */
export function estimateSummarySavings(covered: readonly Message[], summary: string): number {
	return Math.max(0, estimateTokens(covered) - Math.ceil(summary.length / 4));
}
