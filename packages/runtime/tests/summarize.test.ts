/**
 * The /compact summary ORCHESTRATION (the home-relocation extraction, 0.1.26 gate ruling) — the
 * off-loop model call + the boundary math, moved from the kernel to the
 * runtime with the summarizer. Assertions unchanged from the core-era
 * file (zero-behavior relocation).
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event, EventInput, Message, ToolCallEnd } from "@vincemakes/kiso-core";
import {
	estimateSummarySavings,
	KEEP_RECENT_ROUNDS,
	lastSummaryPoint,
	summarizeConversation,
	summaryBoundarySeq,
} from "../src/summarize.js";

function ev(seq: number, event: EventInput): Event {
	return { ...event, seq } as Event;
}

function roundEvents(input: string, answer: string, seq: number): Event[] {
	return [
		ev(seq, { type: "user_input", content: input }),
		ev(seq + 1, { type: "text_delta", text: answer }),
		ev(seq + 2, { type: "stop", reason: "end_turn" }),
	];
}

describe("summaryBoundarySeq / lastSummaryPoint", () => {
	it("keeps K rounds: the boundary is the event before the first KEPT round", () => {
		// 6 user inputs at seqs 0,3,6,9,12,15 (round pattern).
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			...roundEvents("r2", "a", 3),
			...roundEvents("r3", "a", 6),
			...roundEvents("r4", "a", 9),
			...roundEvents("r5", "a", 12),
			...roundEvents("r6", "a", 15),
		];
		// m=6: K=4 → the first KEPT round opens at input 6 → boundary 5
		// (covers rounds 1-2); K=2 → first kept opens at input 12 → 11;
		// K=5 → first kept opens at input 3 → 2.
		expect(summaryBoundarySeq(events)).toBe(5);
		expect(summaryBoundarySeq(events, 2)).toBe(11);
		expect(summaryBoundarySeq(events, 5)).toBe(2);
	});

	it("returns undefined when fewer than K+1 rounds exist (nothing to cover)", () => {
		const events: Event[] = [...roundEvents("r1", "a", 0), ...roundEvents("r2", "a", 3), ...roundEvents("r3", "a", 6), ...roundEvents("r4", "a", 9)];
		expect(summaryBoundarySeq(events, KEEP_RECENT_ROUNDS)).toBeUndefined(); // m=4 ≤ K=4
		expect(summaryBoundarySeq(events, 2)).toBe(5); // K=2: 4 rounds → covers rounds 1-2
		expect(summaryBoundarySeq(events, 3)).toBe(2); // K=3 → covers round 1 only
	});

	it("counts only rounds AFTER the last summary point", () => {
		// 6 rounds, s1 covered rounds 1-3 (0..8). Only rounds 4-6 are
		// uncovered: m=3 ≤ K=4 → nothing more to summarize.
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			...roundEvents("r2", "a", 3),
			...roundEvents("r3", "a", 6),
			...roundEvents("r4", "a", 9),
			...roundEvents("r5", "a", 12),
			...roundEvents("r6", "a", 15),
			ev(18, { type: "summarized", coversToSeq: 8, summary: "S1" }),
		];
		expect(lastSummaryPoint(events)).toBe(8);
		expect(summaryBoundarySeq(events)).toBeUndefined();
		// With K=2: uncovered m=3 → covers round 4 (input 9..before input 12).
		expect(summaryBoundarySeq(events, 2)).toBe(11);
	});

	it("⑥ do-not-compact: a tagged result in the covered range pulls the boundary to before its round", () => {
		// 6 rounds; the task_set (the tagged echo) lives in round 2 (seqs
		// 3..8). Base boundary 5 covers rounds 1-2 → the tagged result's
		// round is round 2 → boundary pulls back to input2 - 1 = 2, so only
		// round 1 is covered and the current list survives the summary.
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			ev(3, { type: "user_input", content: "plan" }),
			ev(4, { type: "tool_call_end", callId: "t1", name: "task_set", input: {} }),
			ev(5, { type: "tool_result", callId: "t1", content: "[task] 2 items", isError: false, tags: ["do-not-compact"] }),
			ev(6, { type: "stop", reason: "end_turn" }),
			...roundEvents("r3", "a", 7),
			...roundEvents("r4", "a", 10),
			...roundEvents("r5", "a", 13),
			...roundEvents("r6", "a", 16),
		];
		// m=6, K=4 → base boundary 5 (would cover rounds 1-2).
		expect(summaryBoundarySeq(events)).toBe(2);
	});

	it("⑥ do-not-compact: only the LATEST tagged result protects its round — older echoes may be covered", () => {
		// Tagged results in rounds 1 AND 3; 7 rounds make base cover all
		// three (base = input4 - 1 = 10). The latest wins → the boundary
		// sits before round 3 (input 7 → 6); round 1's old echo may be
		// covered.
		const events: Event[] = [
			ev(0, { type: "user_input", content: "a" }),
			ev(1, { type: "tool_call_end", callId: "t1", name: "task_set", input: {} }),
			ev(2, { type: "tool_result", callId: "t1", content: "old list", isError: false, tags: ["do-not-compact"] }),
			ev(3, { type: "stop", reason: "end_turn" }),
			...roundEvents("r2", "a", 4),
			ev(7, { type: "user_input", content: "b" }),
			ev(8, { type: "tool_call_end", callId: "t2", name: "task_set", input: {} }),
			ev(9, { type: "tool_result", callId: "t2", content: "new list", isError: false, tags: ["do-not-compact"] }),
			ev(10, { type: "stop", reason: "end_turn" }),
			...roundEvents("r4", "a", 11),
			...roundEvents("r5", "a", 14),
			...roundEvents("r6", "a", 17),
			...roundEvents("r7", "a", 20),
		];
		// m=7, K=4 → base = input4 - 1 = 10; the latest tagged result (seq
		// 9) opens round 3 → 7 - 1 = 6.
		expect(summaryBoundarySeq(events)).toBe(6);
	});

	it("⑥ do-not-compact: no tagged result → the boundary is unchanged", () => {
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			...roundEvents("r2", "a", 3),
			...roundEvents("r3", "a", 6),
			...roundEvents("r4", "a", 9),
			...roundEvents("r5", "a", 12),
			...roundEvents("r6", "a", 15),
		];
		expect(summaryBoundarySeq(events)).toBe(5);
	});

	it("⑥ do-not-compact: a tagged result in a KEPT round changes nothing (it was never covered)", () => {
		// The tagged echo lives in round 6 (the last round — kept by K=4
		// regardless); the base boundary covers only rounds 1-2 and the
		// result at 17 is far outside the range → the base stands.
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			...roundEvents("r2", "a", 3),
			...roundEvents("r3", "a", 6),
			...roundEvents("r4", "a", 9),
			...roundEvents("r5", "a", 12),
			ev(15, { type: "user_input", content: "c" }),
			ev(16, { type: "tool_call_end", callId: "t1", name: "task_set", input: {} }),
			ev(17, { type: "tool_result", callId: "t1", content: "list", isError: false, tags: ["do-not-compact"] }),
			ev(18, { type: "stop", reason: "end_turn" }),
		];
		// m=6, K=4 → base = input3 - 1 = 5; the tagged result at 17 > base.
		expect(summaryBoundarySeq(events)).toBe(5);
	});

	it("⑥ do-not-compact: the protected round as the FIRST uncovered round → nothing to compact", () => {
		// Round 1 holds the tagged result: pulling the boundary before it
		// leaves nothing summarizable — an honest undefined.
		const events: Event[] = [
			ev(0, { type: "user_input", content: "a" }),
			ev(1, { type: "tool_call_end", callId: "t1", name: "task_set", input: {} }),
			ev(2, { type: "tool_result", callId: "t1", content: "list", isError: false, tags: ["do-not-compact"] }),
			ev(3, { type: "stop", reason: "end_turn" }),
			...roundEvents("r2", "a", 4),
			...roundEvents("r3", "a", 7),
			...roundEvents("r4", "a", 10),
			...roundEvents("r5", "a", 13),
			...roundEvents("r6", "a", 16),
		];
		// m=6, K=4 → base 12; the tagged result opens round 1 → boundary
		// would be 0 ≤ prevPoint(-1)? No — 0 > -1: round 1 IS uncovered,
		// and nothing precedes it → undefined.
		expect(summaryBoundarySeq(events)).toBeUndefined();
	});
});

describe("summarizeConversation — the off-loop one-shot call", () => {
	it("collects the adapter's text into the summary, trimmed", async () => {
		const script: FauxScript = [
			{ events: [{ type: "text_delta", text: "  the summary  " }, { type: "stop", reason: "end_turn" }] },
		];
		const summary = await summarizeConversation({
			adapter: createFauxProvider(script),
			model: "faux",
			messages: [{ role: "user", content: "long history" }],
		});
		expect(summary).toBe("the summary");
	});

	it("a model that produced no text is an honest failure — throw, nothing persisted", async () => {
		const script: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
		await expect(
			summarizeConversation({
				adapter: createFauxProvider(script),
				model: "faux",
				messages: [{ role: "user", content: "x" }],
			}),
		).rejects.toThrow("produced no text");
	});

	it("estimateSummarySavings: the covered content outweighs the summary", () => {
		const covered: Message[] = [{ role: "user", content: "x".repeat(800) }];
		expect(estimateSummarySavings(covered, "a short summary")).toBeGreaterThan(100);
		expect(estimateSummarySavings(covered, "x".repeat(10_000))).toBe(0); // never negative
	});
});

	it("P1 pairing invariant: a boundary NEVER splits a tool_call/tool_result pair — a result kept across the K-round cut pulls back to before the pair's round", () => {
		// The straddle: round 4's call lands, then the 5th input arrives
		// MID-EXECUTION (the input row is live at a pause), then the result
		// lands after it. The K-round boundary (before the 5th input) would
		// cover the call and keep the result — a projection with an orphaned
		// tool message (a real provider 400). The boundary must pull back to
		// just before the round that opened the pair (the do-not-compact
		// pullback family): the pair is then KEPT WHOLE.
		const events: Event[] = [
			ev(1, { type: "user_input", content: "t1" }),
			ev(2, { type: "user_input", content: "t2" }),
			ev(3, { type: "user_input", content: "t3" }),
			ev(4, { type: "user_input", content: "t4" }),
			ev(5, { type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } }),
			ev(6, { type: "stop", reason: "tool_use" }),
			ev(7, { type: "user_input", content: "t5" }), // the mid-execution input
			ev(8, { type: "tool_result", callId: "c1", content: "r", isError: false }),
			ev(9, { type: "user_input", content: "t6" }),
			ev(10, { type: "user_input", content: "t7" }),
			ev(11, { type: "user_input", content: "t8" }),
		];
		// The would-be boundary (before input 5, seq 7) lands BETWEEN the
		// call (5) and its result (8). The chosen boundary must be 3 — just
		// before round 4's opening input — the pair wholly KEPT.
		const boundary = summaryBoundarySeq(events);
		expect(boundary).toBe(3);
		// Pair-safe: the call and its result sit on the SAME side of the cut.
		expect(boundary!).toBeLessThan(5);
		expect(boundary!).toBeLessThan(8);
		// The covered range (prev, boundary] contains no covered call whose
		// result is kept — the exact straddle the projection would orphan.
		const coveredCalls = events.filter(
			(e): e is ToolCallEnd => e.type === "tool_call_end" && e.seq <= boundary!,
		);
		for (const call of coveredCalls) {
			const kept = events.some((e) => e.type === "tool_result" && e.callId === call.callId && e.seq > boundary!);
			expect(kept).toBe(false);
		}
	});

	it("P1: the pair straddling the FIRST uncovered round leaves nothing before it to cover — nothing to compact", () => {
		const events: Event[] = [
			ev(1, { type: "user_input", content: "t1" }),
			ev(2, { type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } }),
			ev(3, { type: "stop", reason: "tool_use" }),
			ev(4, { type: "user_input", content: "t2" }), // mid-execution
			ev(5, { type: "tool_result", callId: "c1", content: "r", isError: false }),
			ev(6, { type: "user_input", content: "t3" }),
			ev(7, { type: "user_input", content: "t4" }),
			ev(8, { type: "user_input", content: "t5" }),
		];
		// The straddle is in the FIRST uncovered round — the pullback has
		// nothing before it to cover: the honest "nothing to compact".
		expect(summaryBoundarySeq(events)).toBeUndefined();
	});
