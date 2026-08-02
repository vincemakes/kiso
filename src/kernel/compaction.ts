/**
 * L2 — compaction primitives.
 *
 * The kernel's compaction policy is identity preservation, not summary
 * (mauri ADR-0007): keep the message SHELL (id, role, position), replace the
 * content with a marker, zero LLM calls. A summary is a NEW message; it never
 * rewrites an old one. Messages are immutable (ADR-0002) — "clearing" is
 * append, not mutation.
 *
 * The idempotence predicate is the first thing here because it is the FIRST
 * kernel function demanded by a fixture: the compaction-regrowth incident
 * (uooki 2026, video pipeline) was an O(N²) growth where repeated compaction
 * re-archived messages already marked cleared, overwriting their original
 * content. One line fixed it: a marked message is never archived again.
 */

import type { AssistantBlock, Message, ToolResultMessage } from "../protocol/messages";

/** Marker prefix for cleared tool results. Must be unambiguous and stable. */
export const CLEARED_MARKER_PREFIX = "[content cleared — reference by revision]";

export function isClearedMarker(content: string): boolean {
	return content.startsWith(CLEARED_MARKER_PREFIX);
}

/** Idempotence gate: a message whose content is already the clear marker is
 *  never compacted again, never re-archived, never overwritten. */
export function shouldClearContent(content: string): boolean {
	return !isClearedMarker(content);
}

/**
 * Rough token estimate (chars/4 + structural overhead). Calibration-free on
 * purpose: compaction only needs a stable MONOTONE proxy, not an exact
 * count — the threshold absorbs the error (mauri ADR-0007).
 */
export function estimateTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.role === "user") {
			total += Math.ceil(msg.content.length / 4);
		} else if (msg.role === "assistant") {
			for (const block of msg.blocks) {
				total +=
					block.type === "text"
						? Math.ceil(block.text.length / 4)
						: Math.ceil(JSON.stringify(block.input).length / 4) + 20;
			}
		} else {
			total += Math.ceil(msg.content.length / 4) + 10;
		}
	}
	return total;
}

/**
 * Microcompact — zero-LLM context relief (ported shape from oohki runner,
 * adapted to kiso's Message union; identity preservation, ADR-0007):
 *
 * 1. Find the boundary: the KEEP_RECENT_TURNS-th user message from the end.
 *    Recent turns stay fully intact — the model must reason about them.
 * 2. Tool results BEFORE the boundary have their content replaced by a stub
 *    that keeps the name + char count (an information anchor, not a hole).
 * 3. Idempotent: already-cleared content is never touched again (the
 *    compaction-regrowth incident's one-line fix, as a first-class rule).
 * 4. Returns a NEW array; messages are immutable (ADR-0002).
 */
export const KEEP_RECENT_TURNS = 5;

export interface MicrocompactResult {
	readonly messages: readonly Message[];
	/** How much content (chars) was cleared this pass. */
	readonly clearedChars: number;
	/** Which tool results were cleared (callIds), for tracking/archive. */
	readonly clearedCallIds: readonly string[];
}

export function microcompact(messages: readonly Message[]): MicrocompactResult {
	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.role === "user") userIndices.push(i);
	}
	if (userIndices.length <= KEEP_RECENT_TURNS) {
		return { messages, clearedChars: 0, clearedCallIds: [] };
	}

	const recentBoundary = userIndices[userIndices.length - KEEP_RECENT_TURNS]!;
	const nameByCallId = buildToolNameMap(messages);

	let clearedChars = 0;
	const clearedCallIds: string[] = [];
	let changed = false;

	const result = messages.map((msg, i) => {
		if (i >= recentBoundary || msg.role !== "tool") return msg;
		if (typeof msg.content !== "string") return msg; // binary content is untouched
		if (!shouldClearContent(msg.content)) return msg; // idempotence gate

		const toolName = nameByCallId.get(msg.callId) ?? "unknown";
		clearedChars += msg.content.length;
		clearedCallIds.push(msg.callId);
		changed = true;
		return {
			...msg,
			content: `${CLEARED_MARKER_PREFIX} ${toolName} returned ${msg.content.length.toLocaleString()} chars — compacted`,
		} satisfies ToolResultMessage;
	});

	return {
		messages: changed ? result : messages,
		clearedChars,
		clearedCallIds,
	};
}

/** callId → tool name, from assistant tool_use blocks (for the stub). */
function buildToolNameMap(messages: readonly Message[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.blocks) {
			if (block.type === "tool_use") map.set(block.callId, block.name);
		}
	}
	return map;
}

export type { AssistantBlock };
