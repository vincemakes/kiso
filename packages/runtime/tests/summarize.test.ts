/**
 * The /compact summary ORCHESTRATION (the home-relocation extraction, 0.1.26 gate ruling) — the
 * off-loop model call + the boundary math, moved from the kernel to the
 * runtime with the summarizer. Assertions unchanged from the core-era
 * file (zero-behavior relocation).
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Adapter, AdapterEvent, Event, EventInput, Message, StreamOptions, ToolCallEnd } from "@vincemakes/kiso-core";
import {
	DEFAULT_CONTEXT_WINDOW,
	estimateSummarySavings,
	IN_FLIGHT_HEADROOM,
	KEEP_RECENT_ROUNDS,
	KEEP_TOKENS_DEFAULT,
	lastSummaryPoint,
	POLICY_RESERVE,
	policyTriggerFromWindow,
	serializeCovered,
	SUMMARY_GUARD,
	SUMMARY_MAX_OUTPUT,
	SUMMARY_PROMPT,
	summarizeConversation,
	summaryBoundarySeq,
	validateSummary,
} from "../src/summarize.js";

/** A valid checkpoint body — every fixture that goes through the summary
 *  call must emit one (the (b) validation rejects anything less). */
const VALID_SUMMARY = [
	"## Goal",
	"wire the flags",
	"## Constraints",
	"the fallback must not be used",
	"## User requests",
	"turn 1: make the report work",
	"## Files and changes",
	"src/cli.js: wired --count",
	"## Errors and fixes",
	"none",
	"## Current work",
	"flags wired",
	"## Next steps",
	"wire --sum",
].join("\n");

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
			{ events: [{ type: "text_delta", text: `  ${VALID_SUMMARY}  ` }, { type: "stop", reason: "end_turn" }] },
		];
		const summary = await summarizeConversation({
			adapter: createFauxProvider(script),
			model: "faux",
			messages: [{ role: "user", content: "long history" }],
		});
		// E6 (the honest accounting fix): the call now also surfaces the
		// stream's usage event (null when the adapter reports none) so the
		// summary call's cost can ride the trace ledger.
		expect(summary.text).toBe(VALID_SUMMARY);
		expect(summary.usage).toBeNull();
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

describe("E6 (a) — the serialized summary input (the DSML-killer)", () => {
	/** The T6S-style covered range: user inputs, an assistant answer, and a
	 *  tool pair with a big result (the shape that produced the auto-T5-1
	 *  DSML garbage — raw messages passed to the summarizer). */
	function coveredRange(): Event[] {
		return [
			ev(1, { type: "user_input", content: "make the report work" }),
			ev(2, { type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "src/cli.js" } }),
			ev(3, { type: "tool_result", callId: "c1", content: "line\n".repeat(400), isError: false }), // 2000 chars
			ev(4, { type: "text_delta", text: "I found the flag wiring." }),
			ev(5, { type: "stop", reason: "end_turn" }),
			ev(6, { type: "user_input", content: "wire the flags" }),
			ev(7, { type: "terminal", outcome: { kind: "completed" } }),
		];
	}

	it("serializes the covered range into ONE <conversation> block, per-role lines, never raw messages", () => {
		const events = coveredRange();
		const text = serializeCovered({ events, prevPoint: -1, boundary: 7 });
		// ONE block, role-labeled lines, the inputs and the tool pair visible.
		expect(text).toContain("<conversation>");
		expect(text).toContain("</conversation>");
		expect(text).toContain("[user] make the report work");
		expect(text).toContain("[user] wire the flags");
		expect(text).toContain("[assistant] I found the flag wiring.");
		expect(text).toContain("[tool call read_file]");
		expect(text).toContain("src/cli.js");
		expect(text).toContain("[tool result]");
		// No raw provider message shape leaks into the summary input.
		expect(text).not.toContain('"role":');
	});

	it("truncates a tool result past 2000 chars with a truncation marker", () => {
		const events = coveredRange();
		// 400 lines × 5 chars = 2000 chars exactly — never truncated. Bump it.
		events[2] = ev(3, { type: "tool_result", callId: "c1", content: "x".repeat(5_000), isError: false }) as Event;
		const text = serializeCovered({ events, prevPoint: -1, boundary: 7 });
		expect(text).toContain("[tool result]");
		expect(text).toContain("… (3,000 more chars truncated)");
		// The first 2000 chars survive; the marker is present; the junk tail is gone.
		expect(text).toContain("x".repeat(2000));
		expect(text).not.toContain("x".repeat(2001));
	});

	it("the guard sentence sits BEFORE the conversation (the system-prompt prefix) and AFTER the block", () => {
		const text = serializeCovered({ events: coveredRange(), prevPoint: -1, boundary: 7 });
		// The AFTER copy: the serialized input's own tail, past </conversation>.
		expect(text).toContain("</conversation>");
		expect(text.slice(text.indexOf("</conversation>"))).toContain(SUMMARY_GUARD);
		// The BEFORE copy: SUMMARY_GUARD is the summary prompt's FIRST line.
		expect(SUMMARY_GUARD.length).toBeGreaterThan(0);
	});

	it("summarize() hands the model ONE user message — never the raw covered array", async () => {
		// The session path: the covered range lands as a single serialized
		// user message (the DSML bug's raw-message array is structurally dead).
		let seen: StreamOptions | null = null;
		class CapturingAdapter implements Adapter {
			async *stream(opts: StreamOptions): AsyncIterable<AdapterEvent> {
				seen = opts;
				yield { type: "text_delta", text: VALID_SUMMARY, seq: 0 };
				yield { type: "stop", reason: "end_turn", seq: 1 };
			}
		}
		const summary = await summarizeConversation({
			adapter: new CapturingAdapter(),
			model: "faux",
			messages: [
				{
					role: "user",
					content: serializeCovered({ events: coveredRange(), prevPoint: -1, boundary: 7 }),
				},
			],
		});
		expect(summary.text).toBe(VALID_SUMMARY);
		expect(seen).not.toBeNull();
		expect(seen!.messages).toHaveLength(1);
		expect(seen!.messages[0]!.role).toBe("user");
		const firstText = seen!.messages[0]!.role === "user" ? seen!.messages[0]!.content : undefined;
		expect(String(firstText)).toContain("<conversation>");
		// The system prompt carries the guard as its prefix (the sandwich's
		// BEFORE copy) and no word cap survives.
		expect(seen!.systemPrompt).toContain(SUMMARY_GUARD);
		expect(seen!.systemPrompt).not.toContain("under 200 words");
	});
});

describe("E6 (c) — the structured checkpoint prompt", () => {
	it("the summary prompt is a structured checkpoint: all seven sections, in order, no word cap", () => {
		// The order's (c): the "under 200 words" rule dies; a token budget
		// (~2-4k, riding the (g) maxTokens) replaces word-count framing.
		// RED form: against the pre-(a) prompt (visible in a0b1c29's diff —
		// the "under 200 words" text) every section header below was absent.
		const sections = [
			"## Goal",
			"## Constraints",
			"## User requests",
			"## Files and changes",
			"## Errors and fixes",
			"## Current work",
			"## Next steps",
		];
		for (const s of sections) expect(SUMMARY_PROMPT).toContain(s);
		// The verbatim-identifiers rule survives the rewrite.
		expect(SUMMARY_PROMPT).toContain("Preserve concrete identifiers VERBATIM");
		// The word cap is dead; the budget framing is the contract.
		expect(SUMMARY_PROMPT).not.toContain("under 200 words");
		expect(SUMMARY_PROMPT).not.toMatch(/under \d+ words/);
		expect(SUMMARY_PROMPT).toContain("output budget");
	});

	it("the section order is fixed: the goal and constraints lead, the criterion quote and next steps close", () => {
		const idx = (s: string): number => SUMMARY_PROMPT.indexOf(s);
		expect(idx("## Goal")).toBeGreaterThan(-1);
		expect(idx("## Constraints")).toBeGreaterThan(idx("## Goal"));
		expect(idx("## User requests")).toBeGreaterThan(idx("## Constraints"));
		expect(idx("## Current work")).toBeGreaterThan(idx("## Errors and fixes"));
		expect(idx("## Next steps")).toBeGreaterThan(idx("## Current work"));
		// The verbatim criterion quote requirement lives in Current work.
		expect(SUMMARY_PROMPT).toContain("VERBATIM");
	});
});

describe("E6 (b) — the output validation (the rejection path)", () => {
	it("rejects a summary carrying tool-call DSML markers — the auto-T5-1 signature", () => {
		// The E6-F4/F5 signature family: the model echoed tool-call markup
		// as text. Each marker shape is rejected, wherever it sits.
		expect(validateSummary('<conversation><tool_call name="read_file">…')).not.toBeNull();
		expect(validateSummary('{"type":"tool_call_end","callId":"c1","input":{}}')).not.toBeNull();
		expect(validateSummary('use the <invoke> element for that')).not.toBeNull();
		expect(validateSummary('the tool_calls were {"a":1}')).not.toBeNull();
		expect(validateSummary('{"type":"tool_call_start"}')).not.toBeNull();
	});

	it("rejects a truncated summary — the Current work or Next steps section missing", () => {
		// The wire-truncation signature: the tail cut. The required-section
		// gate is the check that makes a truncated summary FAIL, not pass.
		expect(validateSummary(VALID_SUMMARY)).toBeNull();
		const cutBeforeNext = VALID_SUMMARY.replace("\n## Next steps\nwire --sum", "");
		expect(validateSummary(cutBeforeNext)).toMatch(/next steps/i);
		const cutCurrent = VALID_SUMMARY.replace("\n## Current work\nflags wired", "");
		expect(validateSummary(cutCurrent)).toMatch(/current work/i);
	});

	it("rejects empty/whitespace text — the existing no-text rule stays a hard fail", () => {
		expect(validateSummary("   ")).not.toBeNull();
		expect(validateSummary("")).not.toBeNull();
	});

	it("accepts a complete checkpoint", () => {
		expect(validateSummary(VALID_SUMMARY)).toBeNull();
	});
});

describe("E6 (d) — the retained context re-enters the summary input", () => {
	it("an old summary text is labeled 'retained context, do not re-summarize' — never silently dropped", () => {
		// Round 4 ended at seq 8 and was covered by an earlier summary; the
		// NEW covered range is (8, 17] (rounds 5-6). The old summary text is
		// the durable record of rounds 1-3 — the summarizer must SEE it
		// (the order's R4: session.ts's filter once dropped it entirely).
		const events: Event[] = [
			...roundEvents("r1", "a", 0),
			...roundEvents("r2", "a", 3),
			...roundEvents("r3", "a", 6),
			...roundEvents("r4", "a", 9),
			...roundEvents("r5", "a", 12),
			...roundEvents("r6", "a", 15),
			ev(18, { type: "summarized", coversToSeq: 8, summary: "S1: rounds 1-3 covered" }),
		];
		const text = serializeCovered({ events, prevPoint: 8, boundary: 17 });
		// The retained block label + the do-not-re-summarize instruction.
		expect(text).toContain("[retained context");
		expect(text).toContain("do not re-summarize");
		// The old summary's text rides verbatim — exactly once (the retained
		// copy; the covered range holds rounds 5-6 only, no duplicate).
		expect(text).toContain("S1: rounds 1-3 covered");
		expect(text.split("S1: rounds 1-3 covered")).toHaveLength(2);
		// The covered turns still read normally after the retained block.
		expect(text.indexOf("[retained context")).toBeLessThan(text.indexOf("[user] r5"));
	});
});

describe("E6 (f) — the keep budget (rounds AND tokens)", () => {
	/** 6 rounds with 400-char results — a round ≈ 125 tokens by the
	 *  chars/4 proxy (input 1 + call 24 + result 100); the session ≈ 750. */
	function chunkyRounds(): Event[] {
		const events: Event[] = [];
		let seq = 0;
		for (let i = 1; i <= 6; i++) {
			events.push(ev(seq++, { type: "user_input", content: `r${i}` }));
			events.push(ev(seq++, { type: "tool_call_end", callId: `t${i}`, name: "read_file", input: { path: `f${i}.ts` } }));
			events.push(ev(seq++, { type: "tool_result", callId: `t${i}`, content: "x".repeat(400), isError: false }));
		}
		return events;
	}

	it("the token floor shrinks the boundary when the kept rounds are too small", () => {
		const events = chunkyRounds();
		// The pure round rule keeps rounds 3-6 (4 rounds ≈ 500 tokens) and
		// covers 1-2 (boundary 5); a 600-token floor needs MORE kept — the
		// walk keeps rounds 2-6 (625) → boundary 2 (covers round 1 only).
		expect(summaryBoundarySeq(events)).toBe(5);
		expect(summaryBoundarySeq(events, KEEP_RECENT_ROUNDS, 600)).toBe(2);
	});

	it("a floor the session cannot meet → nothing to compact", () => {
		// The whole session ≈ 750 tokens; the 1000-token floor exceeds it —
		// the honest undefined (the policy is inert on small sessions — the
		// E5-F1 restraint, now enforced by tokens too).
		const events = chunkyRounds();
		expect(summaryBoundarySeq(events, KEEP_RECENT_ROUNDS, 1000)).toBeUndefined();
	});

	it("a floor the kept rounds already clear changes nothing (the round rule stands)", () => {
		const events = chunkyRounds();
		// The kept rounds 3-6 ≈ 500 tokens — a 500-token floor is met at the
		// round rule's own boundary.
		expect(summaryBoundarySeq(events, KEEP_RECENT_ROUNDS, 500)).toBe(5);
	});
});

describe("E6 (g) — the trigger is window minus the reserve (the pre-registered numbers)", () => {
	it("the reserve decomposes into the summary output budget, the keep-token floor, and the in-flight headroom", () => {
		expect(SUMMARY_MAX_OUTPUT).toBe(4000);
		expect(KEEP_TOKENS_DEFAULT).toBe(20000);
		expect(IN_FLIGHT_HEADROOM).toBe(8000);
		expect(POLICY_RESERVE).toBe(32000);
		expect(POLICY_RESERVE).toBe(SUMMARY_MAX_OUTPUT + KEEP_TOKENS_DEFAULT + IN_FLIGHT_HEADROOM);
	});

	it("policyTriggerFromWindow computes window minus the reserve; the default window scale is 120k (the 88k arming point)", () => {
		expect(DEFAULT_CONTEXT_WINDOW).toBe(120000);
		expect(policyTriggerFromWindow(DEFAULT_CONTEXT_WINDOW)).toBe(88000);
		expect(policyTriggerFromWindow(34000)).toBe(2000);
	});

	it("a window below the reserve arms a negative trigger — the session never fires (the honest inert refusal, not a clamp)", () => {
		// The post-fire projection (≥24k) cannot fit in such a window — the
		// policy stays inert rather than pretending otherwise.
		expect(policyTriggerFromWindow(10000)).toBe(-22000);
	});
});
