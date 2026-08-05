/**
 * ADR-0044 — the /compact summary layer: the `summarized` event replaces
 * its covered range with ONE assistant summary message (byte-stable),
 * old `compacted` logs stay readable forever, and the off-loop summary
 * call goes through the same adapter contract.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event, EventInput } from "../src/index.js";
import {
	estimateSummarySavings,
	KEEP_RECENT_ROUNDS,
	lastSummaryPoint,
	summarizeConversation,
	summaryBoundarySeq,
} from "../src/kernel/summarize.js";
import { messagesToEvents, projectMessages } from "../src/kernel/project.js";
import type { Message } from "../src/protocol/messages.js";

const ev = (seq: number, e: EventInput): Event => ({ seq, ...e } as Event);

/** The round pattern of a live session: user input + a short answer. */
function roundEvents(input: string, answer: string, seq: number): Event[] {
	return [
		ev(seq, { type: "user_input", content: input }),
		ev(seq + 1, { type: "text_delta", text: answer }),
		ev(seq + 2, { type: "text_end" }),
	];
}

describe("projection: a summarized event replaces its covered range", () => {
	it("renders ONE assistant summary message in place of the covered rounds, recent rounds intact", () => {
		// 6 rounds (inputs at 0,3,6,9,12,15); the summary covers rounds 1-2
		// (events 0..5 — the cut lands before round 3's input at 6).
		const events: Event[] = [
			...roundEvents("r1", "a1", 0),
			...roundEvents("r2", "a2", 3),
			...roundEvents("r3", "a3", 6),
			...roundEvents("r4", "a4", 9),
			...roundEvents("r5", "a5", 12),
			...roundEvents("r6", "a6", 15),
			ev(18, { type: "summarized", coversToSeq: 5, summary: "S: rounds 1-2" }),
		];
		const msgs = projectMessages(events);
		// The covered text is GONE from the projection (not "cleared" — absent).
		expect(msgs.some((m) => m.role === "user" && (m.content === "r1" || m.content === "r2"))).toBe(false);
		expect(msgs.some((m) => m.role === "assistant" && JSON.stringify(m).includes("a1"))).toBe(false);
		// The summary message: ONE assistant message, at the covered range's
		// position — BEFORE the kept rounds.
		const summaryMessages = msgs.filter((m) => m.role === "assistant" && m.blocks.some((b) => b.type === "text" && b.text === "S: rounds 1-2"));
		expect(summaryMessages).toHaveLength(1);
		expect(msgs[0]).toBe(summaryMessages[0]);
		// The kept rounds (3-6) read normally AFTER the summary.
		const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
		expect(users).toEqual(["r3", "r4", "r5", "r6"]);
	});

	it("byte-stable: the same log derives the same projection every time, and the round trip is lossless", () => {
		// 4 rounds; the summary covers rounds 1-2 (0..5); rounds 3-4 kept.
		const events: Event[] = [
			...roundEvents("r1", "a1", 0),
			...roundEvents("r2", "a2", 3),
			...roundEvents("r3", "a3", 6),
			...roundEvents("r4", "a4", 9),
			ev(12, { type: "summarized", coversToSeq: 5, summary: "S: rounds 1-2" }),
		];
		const first = projectMessages(events);
		expect(projectMessages(events)).toEqual(first); // replay, byte for byte
		// The summary message round-trips through the seed encoder: it is an
		// ordinary assistant text message to every consumer (messagesToEvents
		// re-encodes it, the projection re-derives it identically).
		expect(projectMessages(messagesToEvents(first))).toEqual(first);
	});

	it("two summaries each render their own message, in order, before the kept rounds", () => {
		// 7 rounds (inputs 0,3,6,9,12,15,18); s1 covers rounds 1-2 (0..5),
		// s2 covers rounds 3-4 (6..11), rounds 5-7 kept. The summarized
		// EVENTS sit at the log's end — after the kept rounds — yet their
		// messages render at their boundaries, in reading order.
		const events: Event[] = [
			...roundEvents("r1", "a1", 0),
			...roundEvents("r2", "a2", 3),
			...roundEvents("r3", "a3", 6),
			...roundEvents("r4", "a4", 9),
			...roundEvents("r5", "a5", 12),
			...roundEvents("r6", "a6", 15),
			...roundEvents("r7", "a7", 18),
			ev(21, { type: "summarized", coversToSeq: 5, summary: "S1" }),
			ev(22, { type: "summarized", coversToSeq: 11, summary: "S2" }),
		];
		const msgs = projectMessages(events);
		// [S1][S2][rounds 5-7] — each summary at its covered range's position.
		const texts = msgs.map((m) => {
			if (m.role === "assistant") {
				const text = m.blocks.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : ""));
				return text.join("");
			}
			return m.role === "user" ? `u:${m.content}` : "t";
		});
		expect(texts).toEqual(["S1", "S2", "u:r5", "a5", "u:r6", "a6", "u:r7", "a7"]);
		// The covered content is absent entirely.
		expect(texts.some((t) => t.includes("r1") || t.includes("r3"))).toBe(false);
	});

	it("a summary whose log ends right after it still renders (the crash-then-resume shape)", () => {
		// The /compact ran, the process died before any further turn: the
		// log ends at the summarized event itself — the resume must still
		// project the compressed view.
		const events: Event[] = [
			...roundEvents("r1", "a1", 0),
			...roundEvents("r2", "a2", 3),
			...roundEvents("r3", "a3", 6),
			ev(9, { type: "summarized", coversToSeq: 5, summary: "S" }),
		];
		const msgs = projectMessages(events);
		expect(msgs).toHaveLength(3); // the summary + round 3's user + assistant
		expect((msgs[0]! as { role: string }).role).toBe("assistant");
		expect((msgs[0]! as { blocks: readonly { type: string; text?: string }[] }).blocks.some((b) => b.type === "text" && b.text === "S")).toBe(true);
	});
});

describe("old compacted logs stay readable (ADR-0044 promise)", () => {
	it("v1 ({callId, content}) and v2 ({eventSeq, callId, content}) entries replay verbatim", () => {
		// A round-three (v1) session and a current (v2) one, in ONE log.
		const events: Event[] = [
			ev(0, { type: "user_input", content: "go" }),
			ev(1, { type: "tool_call_end", callId: "c1", name: "shell", input: { command: "ls" } }),
			ev(2, { type: "tool_result", callId: "c1", content: "v1-result", isError: false }),
			ev(3, { type: "tool_call_end", callId: "c2", name: "shell", input: { command: "ls" } }),
			ev(4, { type: "tool_result", callId: "c2", content: "v2-result", isError: false }),
			// v1: no eventSeq — replaces EVERY tool result with callId c1.
			ev(5, { type: "compacted", cleared: [{ callId: "c1", content: "[cleared c1]" }] }),
			// v2: eventSeq — replaces exactly the result at event 4.
			ev(6, { type: "compacted", cleared: [{ eventSeq: 4, callId: "c2", content: "[cleared c2]" }] }),
			ev(7, { type: "terminal", outcome: { kind: "completed" } }),
		];
		const msgs = projectMessages(events);
		const tools = msgs.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
		expect(tools.map((t) => t.content)).toEqual(["[cleared c1]", "[cleared c2]"]);
		// The EXACT persisted text — never re-run, never re-derived.
		expect(tools[0]!.content).toBe("[cleared c1]");
		expect(tools[1]!.content).toBe("[cleared c2]");
	});
});

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
