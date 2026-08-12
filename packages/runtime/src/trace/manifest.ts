/**
 * E1 (1.2.0) — slice 3, the context manifest (proposal §1.3).
 *
 * buildContextManifest derives the per-request segment list from the
 * session log and the request projection. Segments are the system
 * prompt, the tool schema, then one per user turn. Each turn carries a
 * THIN seqRange pointer into the event log ([firstSeq, lastSeq] of the
 * events that produced it) plus an estTokens estimate — the record
 * never copies payloads (proposal §1.1).
 *
 * Turn boundaries are the log's visible user_input events: a VETOED
 * input (user_input_replaced with null content) is not a boundary — the
 * model never saw it; a REWRITE keeps the original boundary position
 * (the projection renders the replacement in place, events.ts:339).
 * The last turn is current_turn/fresh, earlier turns cache_read; the
 * system/tools head is cache_read (a stable prefix, R4b).
 *
 * When the projection's user-message count and the log's visible
 * boundary count diverge (a summary replaced whole turns, an alignment
 * surprise), every turn range degrades to null — honest thin pointers
 * rather than wrong ones.
 */

import type { Event, Message, ToolSpec } from "@vincemakes/kiso-core";
import { estimateTokens } from "@vincemakes/kiso-core";
import { canonicalJson, hashSystemPrompt, hashToolSpecs, sha256Hex } from "./hash.js";
import type { TraceSegment } from "./record.js";

export interface ManifestInput {
	log: readonly Event[];
	systemPrompt: string | undefined;
	tools: readonly ToolSpec[] | undefined;
	messages: readonly Message[];
}

/** The log's visible user boundaries, in log order: every user_input
 *  whose replacement (if any) is not a veto. */
function visibleBoundaries(log: readonly Event[]): number[] {
	const vetoed = new Set<number>();
	for (const ev of log) {
		if (ev.type === "user_input_replaced" && ev.content === null) vetoed.add(ev.replaces);
	}
	const result: number[] = [];
	for (const ev of log) {
		if (ev.type === "user_input" && !vetoed.has(ev.seq)) result.push(ev.seq);
	}
	return result;
}

const systemSegment = (systemPrompt: string | undefined): TraceSegment => ({
	role: "system",
	seqRange: null,
	estTokens: estimateTokens([{ role: "user", content: systemPrompt ?? "" }]),
	freshness: "cache_read",
});

const toolsSegment = (tools: readonly ToolSpec[] | undefined): TraceSegment => ({
	role: "tools",
	seqRange: null,
	estTokens: estimateTokens([{ role: "tool", callId: "", content: JSON.stringify(tools ?? []), isError: false }]),
	freshness: "cache_read",
});

export function buildContextManifest(input: ManifestInput): TraceSegment[] {
	const { log, systemPrompt, tools, messages } = input;
	const boundaries = visibleBoundaries(log);
	const userCount = messages.filter((m) => m.role === "user").length;
	const aligned = userCount === boundaries.length;
	const lastSeq = log.length > 0 ? log[log.length - 1]!.seq : -1;

	const segments: TraceSegment[] = [systemSegment(systemPrompt), toolsSegment(tools)];

	// Partition the projection at user boundaries: partition k runs from
	// user_k (inclusive) to user_{k+1} (exclusive); messages before the
	// first user (not produced by the projection today) join partition 0.
	const userPositions: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === "user") userPositions.push(i);
	});
	for (let k = 0; k < userPositions.length; k++) {
		const start = k === 0 ? 0 : userPositions[k]!;
		const end = k + 1 < userPositions.length ? userPositions[k + 1]! : messages.length;
		const isCurrent = k === userPositions.length - 1;
		const range: [number, number] | null =
			aligned && boundaries[k] !== undefined
				? [boundaries[k]!, k + 1 < boundaries.length ? boundaries[k + 1]! - 1 : lastSeq]
				: null;
		segments.push({
			role: isCurrent ? "current_turn" : "turn",
			seqRange: range,
			estTokens: estimateTokens(messages.slice(start, end)),
			freshness: isCurrent ? "fresh" : "cache_read",
		});
	}
	return segments;
}

/** Per-segment content hashes for the fingerprint (R4b): the system
 *  prompt, the tool schema, and each turn's messages, in manifest
 *  order. The CURRENT turn's hash is the last element — the cacheable
 *  prefix is everything before it. */
export function segmentHashes(
	systemPrompt: string | undefined,
	tools: readonly ToolSpec[] | undefined,
	messages: readonly Message[],
): string[] {
	const hashes = [hashSystemPrompt(systemPrompt), hashToolSpecs(tools)];
	const userPositions: number[] = [];
	messages.forEach((m, i) => {
		if (m.role === "user") userPositions.push(i);
	});
	for (let k = 0; k < userPositions.length; k++) {
		const start = k === 0 ? 0 : userPositions[k]!;
		const end = k + 1 < userPositions.length ? userPositions[k + 1]! : messages.length;
		hashes.push(sha256Hex(canonicalJson(messages.slice(start, end))));
	}
	return hashes;
}
