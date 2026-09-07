/**
 * A1a (C) — the checkpoint boundary at a SETTLED model turn.
 *
 * A candidate is a model turn whose `stop` is committed and whose every
 * `tool_call_end` has its answer — a `tool_result` paired by
 * `invocationSeq` (callId only for legacy logs) — or lies in a void
 * range. The cut is the settled turn's LAST event (its last result, or
 * its stop when it made no calls), so the summary never splits a call
 * from its result (EC-1 persists the stop BEFORE the results land — a
 * cut at stop.seq would). At least one settled turn stays after the cut;
 * the do-not-compact turn is never covered; the keep floor holds; only
 * after the last summary point. Definition + tests — nothing calls it
 * in production until A1b picks the policy.
 */

import { describe, expect, it } from "vitest";
import type { Event, EventInput } from "@vincemakes/kiso-core";
import { DO_NOT_COMPACT } from "@vincemakes/kiso-core";
import { checkpointBoundarySeq } from "../src/checkpoint.js";

const ev = (seq: number, e: EventInput): Event => ({ ...e, seq }) as Event;
const call = (seq: number, id: string, input: Record<string, unknown> = { path: "a" }): Event => ev(seq, { type: "tool_call_end", callId: id, name: "write_file", input });
const stop = (seq: number, reason: "tool_use" | "end_turn" = "tool_use"): Event => ev(seq, { type: "stop", reason });
const result = (seq: number, id: string, inv: number | undefined, content = "ok", tags?: string[]): Event =>
	ev(seq, { type: "tool_result", callId: id, ...(inv !== undefined ? { invocationSeq: inv } : {}), content, isError: false, ...(tags ? { tags } : {}) } as EventInput);
const text = (seq: number, t = "…"): Event => ev(seq, { type: "text_delta", text: t });
const user = (seq: number): Event => ev(seq, { type: "user_input", content: "go" });

describe("A1a — checkpointBoundarySeq", () => {
	it("the cut is the settled turn's LAST event — after its results, never at its stop", () => {
		const events = [user(0), call(1, "c1"), stop(2), ev(3, { type: "tool_execution_started", callId: "c1", invocationSeq: 1, name: "write_file", input: { path: "a" }, executionId: "ex-3" } as EventInput), result(4, "c1", 1), text(5), stop(6, "end_turn")];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(4);
	});

	it("an unanswered call leaves its turn unsettled — no candidate there", () => {
		const events = [user(0), call(1, "c1"), stop(2), text(3), stop(4, "end_turn")];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBeUndefined();
	});

	it("two calls answered in either order: the cut is the later result", () => {
		const events = [user(0), call(1, "a"), call(2, "b"), stop(3), result(4, "b", 2), result(5, "a", 1), text(6), stop(7, "end_turn")];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(5);
	});

	it("a voided draft is never cut into; the retry's settled turn is the candidate", () => {
		const events = [
			user(0),
			call(1, "c1"),
			text(2, "draft"),
			ev(3, { type: "model_output_abandoned", voidFromSeq: 0, reason: "cut" }),
			call(4, "c1"),
			stop(5),
			result(6, "c1", 4),
			text(7),
			stop(8, "end_turn"),
		];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(6);
	});

	it("a duplicate callId across turns pairs by invocationSeq: the earlier result never answers the later call", () => {
		const settled = [user(0), call(1, "x"), stop(2), result(3, "x", 1), call(4, "x"), stop(5), result(6, "x", 4), text(7), stop(8, "end_turn")];
		expect(checkpointBoundarySeq(settled, { keepTokens: 0 })).toBe(6);
		const secondUnanswered = [user(0), call(1, "x"), stop(2), result(3, "x", 1), call(4, "x"), stop(5), text(6), stop(7, "end_turn")];
		expect(checkpointBoundarySeq(secondUnanswered, { keepTokens: 0 })).toBe(3); // callId-only pairing would have accepted result@3 for call@4
	});

	it("a legacy result without invocationSeq pairs by callId, only after its call", () => {
		const events = [user(0), call(1, "c1"), stop(2), result(3, "c1", undefined), text(4), stop(5, "end_turn")];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(3);
	});

	it("the turn holding the latest do-not-compact result is never covered — the cut stays before it", () => {
		const events = [
			user(0),
			call(1, "c1"), stop(2), result(3, "c1", 1),
			call(4, "t"), stop(5), result(6, "t", 4, "task list", [DO_NOT_COMPACT]),
			call(7, "c3"), stop(8), result(9, "c3", 7),
			text(10), stop(11, "end_turn"),
		];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(3);
	});

	it("no committed stop → no candidate; a lone final turn → nothing to cover", () => {
		expect(checkpointBoundarySeq([user(0), call(1, "c1"), result(2, "c1", 1)], { keepTokens: 0 })).toBeUndefined();
		expect(checkpointBoundarySeq([user(0), text(1), stop(2, "end_turn")], { keepTokens: 0 })).toBeUndefined();
	});

	it("the keep floor walks the cut back until enough is kept after it", () => {
		const big = "x".repeat(4000); // ~1000 tokens per result
		const events = [
			user(0),
			call(1, "a"), stop(2), result(3, "a", 1, big),
			call(4, "b"), stop(5), result(6, "b", 4, big),
			call(7, "c"), stop(8), result(9, "c", 7, big),
			text(10), stop(11, "end_turn"),
		];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(9);
		expect(checkpointBoundarySeq(events, { keepTokens: 1500 })).toBe(3); // after 6 only c (~1023) + the final text remain — below the floor; after 3, b + c (~2046) clear it
		expect(checkpointBoundarySeq(events, { keepTokens: 2500 })).toBeUndefined(); // even the earliest cut keeps ~2046 — the whole range cannot meet the floor
		expect(checkpointBoundarySeq(events, { keepTokens: 10_000 })).toBeUndefined();
	});

	it("only after the last summary point", () => {
		const events = [
			user(0),
			call(1, "a"), stop(2), result(3, "a", 1),
			ev(4, { type: "summarized", coversToSeq: 3, summary: "## Current work\nx\n## Next steps\ny" }),
			call(5, "b"), stop(6), result(7, "b", 5),
			call(8, "c"), stop(9), result(10, "c", 8),
			text(11), stop(12, "end_turn"),
		];
		expect(checkpointBoundarySeq(events, { keepTokens: 0 })).toBe(10);
		const nothingAfter = [user(0), call(1, "a"), stop(2), result(3, "a", 1), ev(4, { type: "summarized", coversToSeq: 3, summary: "s" }), text(5), stop(6, "end_turn")];
		expect(checkpointBoundarySeq(nothingAfter, { keepTokens: 0 })).toBeUndefined();
	});
});
