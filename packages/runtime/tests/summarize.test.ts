/**
 * The /compact summary ORCHESTRATION (归位式抽取, 0.1.26 gate 裁决) — the
 * off-loop model call + the boundary math, moved from the kernel to the
 * runtime with the summarizer. Assertions unchanged from the core-era
 * file (zero-behavior relocation).
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event, EventInput } from "@vincemakes/kiso-core";
import type { Message } from "@vincemakes/kiso-core";
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
		// 6 rounds; the todo_set (the tagged echo) lives in round 2 (seqs
		// 3..8). Base boundary 5 covers rounds 1-2 → the tagged result's
		// round is round 2 → boundary pulls back to input2 - 1 = 2, so only
		// round 1 is covered and the current list survives the summary.
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			ev(3, { type: "user_input", content: "plan" }),
			ev(4, { type: "tool_call_end", callId: "t1", name: "todo_set", input: {} }),
			ev(5, { type: "tool_result", callId: "t1", content: "[todo] 2 items", isError: false, tags: ["do-not-compact"] }),
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
			ev(1, { type: "tool_call_end", callId: "t1", name: "todo_set", input: {} }),
			ev(2, { type: "tool_result", callId: "t1", content: "old list", isError: false, tags: ["do-not-compact"] }),
			ev(3, { type: "stop", reason: "end_turn" }),
			...roundEvents("r2", "a", 4),
			ev(7, { type: "user_input", content: "b" }),
			ev(8, { type: "tool_call_end", callId: "t2", name: "todo_set", input: {} }),
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
			ev(16, { type: "tool_call_end", callId: "t1", name: "todo_set", input: {} }),
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
			ev(1, { type: "tool_call_end", callId: "t1", name: "todo_set", input: {} }),
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
