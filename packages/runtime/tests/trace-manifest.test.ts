/**
 * E1 (1.2.0) — slice 3, the context manifest (proposal §1.3).
 *
 * buildContextManifest turns the request projection (system prompt +
 * tool specs + messages) and the session log into the segment list:
 * system/tools (seqRange null — not events) then one segment per user
 * turn, each a thin seqRange pointer into the log plus an estTokens
 * estimate. The LAST turn is current_turn/fresh; earlier turns are
 * cache_read. A vetoed input (user_input_replaced with null content) is
 * not a boundary; a rewrite keeps the ORIGINAL boundary position. When
 * the messages' user count and the log's visible boundaries diverge
 * (e.g. a summary removed turns), ranges degrade to null — honest thin
 * pointers rather than wrong ones.
 */

import { describe, expect, it } from "vitest";
import type { Event, Message, ToolSpec } from "@vincemakes/kiso-core";
import { buildContextManifest } from "../src/trace/manifest.js";

const SYSTEM = "SYSTEM PROMPT!!"; // 14 chars → ceil(14/4) = 4
const TOOLS: ToolSpec[] = [{ name: "add", description: "x", inputSchema: { type: "object" } }];
const TOOLS_EST = Math.ceil(JSON.stringify(TOOLS).length / 4) + 10;

const user = (seq: number, content: string): Event => ({ seq, type: "user_input", content });
const stop = (seq: number): Event => ({ seq, type: "stop", reason: "end_turn" });
const veto = (seq: number, replaces: number): Event => ({ seq, type: "user_input_replaced", replaces, content: null });
const rewrite = (seq: number, replaces: number, content: string): Event => ({
	seq,
	type: "user_input_replaced",
	replaces,
	content,
});

const userMsg = (content: string): Message => ({ role: "user", content });
const assistantMsg = (text: string): Message => ({ role: "assistant", blocks: [{ type: "text", text }] });

const build = (log: readonly Event[], messages: readonly Message[]) =>
	buildContextManifest({ log, systemPrompt: SYSTEM, tools: TOOLS, messages });

/** The system + tools head is constant across every shape. */
const expectHead = (segments: ReturnType<typeof build>) => {
	expect(segments[0]?.role).toBe("system");
	expect(segments[0]?.seqRange).toBeNull();
	expect(segments[0]?.estTokens).toBe(4);
	expect(segments[0]?.freshness).toBe("cache_read");
	expect(segments[1]?.role).toBe("tools");
	expect(segments[1]?.seqRange).toBeNull();
	expect(segments[1]?.estTokens).toBe(TOOLS_EST);
	expect(segments[1]?.freshness).toBe("cache_read");
};

describe("E1 slice 3 — the context manifest", () => {
	it("a single turn is one current_turn segment covering the whole log", () => {
		const segments = build([user(1, "hello world!")], [userMsg("hello world!")]);
		expectHead(segments);
		expect(segments).toHaveLength(3);
		expect(segments[2]).toEqual({
			role: "current_turn",
			seqRange: [1, 1],
			estTokens: 3, // 12 chars / 4
			freshness: "fresh",
		});
	});

	it("multi-turn: earlier turns are cache_read, ranges are half-open pointers", () => {
		const log = [user(1, "first"), stop(2), user(5, "second!!!"), stop(6)];
		const segments = build(log, [userMsg("first"), assistantMsg("ok."), userMsg("second!!!")]);
		expect(segments).toHaveLength(4);
		// turn 0 = [1, next boundary − 1] = [1, 4]; estTokens: "first"
		// (ceil(5/4)=2) + "ok." (ceil(3/4)=1)
		expect(segments[2]).toEqual({
			role: "turn",
			seqRange: [1, 4],
			estTokens: 3,
			freshness: "cache_read",
		});
		expect(segments[3]).toEqual({
			role: "current_turn",
			seqRange: [5, 6],
			estTokens: Math.ceil("second!!!".length / 4),
			freshness: "fresh",
		});
	});

	it("a vetoed input is not a boundary — the model never saw it", () => {
		const log = [user(1, "first"), veto(2, 1), user(3, "third")];
		const segments = build(log, [userMsg("third")]);
		expect(segments).toHaveLength(3);
		expect(segments[2]).toEqual({
			role: "current_turn",
			seqRange: [3, 3],
			estTokens: Math.ceil("third".length / 4),
			freshness: "fresh",
		});
	});

	it("a rewrite keeps the ORIGINAL boundary position and spans its events", () => {
		const log = [user(1, "first"), rewrite(2, 1, "rewritten")];
		const segments = build(log, [userMsg("rewritten")]);
		expect(segments[2]?.seqRange).toEqual([1, 2]);
	});

	it("when user boundaries and user messages diverge, ranges degrade to null (honest fallback)", () => {
		// a summary removed one turn's user message — the projection has
		// fewer users than the log has boundaries
		const log = [user(1, "first"), stop(2), user(3, "second")];
		const segments = build(log, [userMsg("second")]);
		// one user message → one turn segment, but its range degrades to null
		expect(segments).toHaveLength(3);
		expect(segments[2]?.seqRange).toBeNull();
		expect(segments[2]?.role).toBe("current_turn");
		expect(segments[2]?.freshness).toBe("fresh");
	});

	it("no user messages → only the system and tools segments", () => {
		const segments = build([], []);
		expectHead(segments);
		expect(segments).toHaveLength(2);
	});

	it("an empty tool set and undefined system prompt still produce valid segments", () => {
		const segments = buildContextManifest({ log: [user(1, "hi")], systemPrompt: undefined, tools: undefined, messages: [userMsg("hi")] });
		expect(segments[0]?.estTokens).toBe(0);
		expect(segments[1]?.estTokens).toBe(11); // "[]" (2 chars / 4 = 1) + 10 structural
		expect(segments[2]?.seqRange).toEqual([1, 1]);
	});
});
