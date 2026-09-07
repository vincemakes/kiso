/**
 * A1a (C) — the checkpoint boundary at a SETTLED model turn.
 *
 * `summaryBoundarySeq` can only cut just before a `user_input` round; one
 * instruction followed by hundreds of model/tool turns therefore never
 * yields a boundary (roadmap R3.1, the audit's A1). This is the DEFINITION
 * of a cut that lives inside such a run — a pure projection over the log,
 * with the invariants stated, and nothing in production calls it until
 * A1b chooses when (the policy is not decided here).
 *
 * A candidate is a model turn whose `stop` is committed and whose every
 * `tool_call_end` has its answer — a `tool_result` paired by
 * `invocationSeq` (the CX-1 F1 lesson: a callId is correlation, never
 * identity; callId pairs only legacy results that carry no invocationSeq,
 * and only after the call) — or lies in a void range (a voided draft's
 * calls never ran and are not unanswered). The cut is the settled turn's
 * LAST event: its last result, or its stop when it made no calls. EC-1
 * persists the stop BEFORE the results land, so a cut at `stop.seq` would
 * cover the call and keep the result — the straddle the whole-round
 * pullback exists to prevent; here it cannot happen by construction.
 *
 * Invariants: the cut lies after the last summary point; at least one
 * settled turn stays after it (the model keeps its most recent turn);
 * the turn holding the LATEST do-not-compact result is never covered
 * (the cut stays before that turn — per model turn, not per user round);
 * the kept suffix meets `keepTokens` (the same event-token estimate the
 * whole-round walk uses). No candidate → undefined, the honest "nothing
 * to checkpoint".
 */

import type { Event } from "@vincemakes/kiso-core";
import { DO_NOT_COMPACT } from "@vincemakes/kiso-core";
import { estimateEventTokens, lastSummaryPoint } from "./summarize.js";

export interface CheckpointOptions {
	/** the minimum estimated tokens that must remain AFTER the cut (default 0). */
	readonly keepTokens?: number;
}

const MODEL_EVENT = new Set(["text_start", "text_delta", "text_end", "thinking", "tool_call_start", "tool_call_input_delta", "tool_call_end"]);

interface Turn {
	readonly start: number;
	readonly cut: number;
	readonly settled: boolean;
	readonly protectedTurn: boolean;
}

export function checkpointBoundarySeq(events: readonly Event[], opts: CheckpointOptions = {}): number | undefined {
	const keepTokens = opts.keepTokens ?? 0;
	const prevPoint = lastSummaryPoint(events);
	const voids: { from: number; to: number }[] = [];
	for (const e of events) if (e.type === "model_output_abandoned") voids.push({ from: e.voidFromSeq, to: e.seq });
	const voided = (seq: number): boolean => voids.some((r) => seq > r.from && seq <= r.to);
	const live = events.filter((e) => e.seq > prevPoint && !voided(e.seq));

	// the answers: by invocationSeq (round 5+), by callId only for legacy results
	const byInvocation = new Map<number, Event & { type: "tool_result" }>();
	const legacyByCallId = new Map<string, (Event & { type: "tool_result" })[]>();
	for (const e of live) {
		if (e.type !== "tool_result") continue;
		if (e.invocationSeq !== undefined) byInvocation.set(e.invocationSeq, e);
		else (legacyByCallId.get(e.callId) ?? legacyByCallId.set(e.callId, []).get(e.callId)!).push(e);
	}
	const answerOf = (call: Event & { type: "tool_call_end" }): (Event & { type: "tool_result" }) | undefined =>
		byInvocation.get(call.seq) ?? legacyByCallId.get(call.callId)?.find((r) => r.seq > call.seq);

	// the model turns: from the first model event after a user_input / stop to the committed stop
	const turns: Turn[] = [];
	let start: number | null = null;
	let calls: (Event & { type: "tool_call_end" })[] = [];
	for (const e of live) {
		if (e.type === "user_input") {
			start = null;
			calls = [];
			continue;
		}
		if (start === null && MODEL_EVENT.has(e.type)) start = e.seq;
		if (e.type === "tool_call_end") calls.push(e);
		if (e.type !== "stop") continue;
		const answers = calls.map(answerOf);
		const settled = answers.every((a) => a !== undefined);
		const cut = Math.max(e.seq, ...answers.map((a) => a?.seq ?? -1));
		const protectedTurn = answers.some((a) => a !== undefined && (a.tags ?? []).includes(DO_NOT_COMPACT));
		turns.push({ start: start ?? e.seq, cut, settled, protectedTurn });
		start = null;
		calls = [];
	}

	// the latest do-not-compact turn is never covered: every cut stays before it
	const lastProtected = [...turns].reverse().find((t) => t.protectedTurn);
	const ceiling = lastProtected === undefined ? Number.POSITIVE_INFINITY : lastProtected.start;

	let total = 0;
	const tokensAfter = new Map<number, number>(); // cut -> tokens of live events after it
	for (let i = live.length - 1; i >= 0; i -= 1) {
		tokensAfter.set(live[i]!.seq, total);
		total += estimateEventTokens(live[i]!);
	}

	const settledIdx = turns.map((t, i) => (t.settled ? i : -1)).filter((i) => i >= 0);
	// a candidate must leave at least one settled turn after it
	for (let k = settledIdx.length - 2; k >= 0; k -= 1) {
		const t = turns[settledIdx[k]!]!;
		if (t.cut >= ceiling) continue;
		if ((tokensAfter.get(t.cut) ?? 0) < keepTokens) continue;
		return t.cut;
	}
	return undefined;
}
