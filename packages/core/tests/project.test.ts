/**
 * Phase B — the reducer: messages must be a PURE PROJECTION of the event log.
 *
 * ADR-0002 says the log is the single truth. The loop previously maintained a
 * second, parallel `messages` array that could not be rebuilt from events
 * (user input had no event representation; compaction mutated in place).
 * These tests pin the replacement: `messagesToEvents` encodes seeds,
 * `projectMessages` decodes them back, and a real trajectory round-trips.
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "../src/protocol/messages.js";
import {
	EventLog,
	loop,
	messagesToEvents,
	projectMessages,
} from "../src/index.js";
import type { EventInput } from "../src/index.js";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";

const seed: readonly Message[] = [
	{ role: "user", content: "hello" },
	{
		role: "assistant",
		blocks: [
			{ type: "text", text: "let me look" },
			{ type: "tool_use", callId: "c1", name: "web_search", input: { query: "kiso" } },
		],
	},
	{ role: "tool", callId: "c1", content: "results", isError: false },
];

describe("messagesToEvents / projectMessages round-trip", () => {
	it("decodes exactly what it encoded (user / assistant / tool)", () => {
		expect(projectMessages(messagesToEvents(seed))).toEqual(seed);
	});

	it("is LOSSLESS: source, tags, image blocks, and text-block boundaries survive (Area 6)", () => {
		const rich: readonly Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{ type: "image", sourceType: "base64", data: "aGVsbG8=", mediaType: "image/png" },
				],
				source: "suggestion",
			},
			{
				role: "assistant",
				blocks: [
					{ type: "text", text: "first block" },
					{ type: "text", text: "second block" },
					{ type: "tool_use", callId: "c1", name: "web_search", input: { query: "k" } },
				],
				source: "model",
			},
			{ role: "tool", callId: "c1", content: "results", isError: false, source: "tool_result", tags: ["do-not-compact"] },
		];
		expect(projectMessages(messagesToEvents(rich))).toEqual(rich);
	});

	it("user input has an explicit event — reconstructable without the seed array", () => {
		const events = messagesToEvents([{ role: "user", content: "hi" }]);
		expect(events.some((e) => e.type === "user_input")).toBe(true);
		expect(projectMessages(events)).toEqual([{ role: "user", content: "hi" }]);
	});

	it("tool calls whose args failed to parse are dropped, not forged", () => {
		const events = messagesToEvents([
			{
				role: "assistant",
				blocks: [{ type: "tool_use", callId: "c1", name: "x", input: {} }],
			},
		]);
		const projected = projectMessages(events);
		// The assistant message survives; a tool message with no result must not appear.
		expect(projected).toEqual([
			{
				role: "assistant",
				blocks: [{ type: "tool_use", callId: "c1", name: "x", input: {} }],
			},
		]);
	});
});

describe("a real run's trajectory is its own truth", () => {
	it("every adapter call receives exactly projectMessages(log.all)", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "Search",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				execute: async () => ({ content: "some results", isError: false }),
			}),
		);

		const seen: Message[][] = [];
		const wrapping = createFauxProvider([
			{
				events: [
					{ type: "text_delta", text: "searching" },
					{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },

				{ type: "stop", reason: "tool_use" }],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		]);
		const adapter = {
			stream: (opts: Parameters<typeof wrapping.stream>[0]) => {
				seen.push([...opts.messages]);
				return wrapping.stream(opts);
			},
		};

		const log = new EventLog();
		for await (const _ev of loop({
			adapter,
			model: "faux",
			registry,
			log,
			messages: [{ role: "user", content: "search" }],
		})) {
			// no-op
		}

		// Invariant: whatever the adapter received at its LAST call is exactly
		// the projection of the complete log. The projection is the truth;
		// the messages array is a view, never a second store.
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(seen.at(-1)).toEqual(projectMessages(log.all));
		// And the first call was seeded from the encoded user input only.
		expect(seen[0]).toEqual(projectMessages(log.all.slice(0, 1)));
	});

	it("compaction is recorded in the log, not silently applied to a second copy", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "read_file",
				description: "Read",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				execute: async () => ({ content: "x".repeat(200), isError: false }),
			}),
		);

		// A long seeded history (15 user turns) — enough for microcompact's
		// recent-window boundary to kick in on the next model call.
		const seedTurns: Message[] = [];
		for (let i = 0; i < 15; i++) {
			seedTurns.push({ role: "user", content: `u${i}` });
			seedTurns.push({
				role: "assistant",
				blocks: [{ type: "tool_use", callId: `c${i}`, name: "read_file", input: { path: `p${i}.ts` } }],
			});
			seedTurns.push({ role: "tool", callId: `c${i}`, content: "x".repeat(200), isError: false });
		}
		const log = new EventLog();
		for (const ev of messagesToEvents(seedTurns)) log.append(ev);

		for await (const _ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c99", name: "read_file", input: { path: "go.ts" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			microcompact: { thresholdTokens: 200 },
		})) {
			// no-op
		}

		// The boundary is the durable fact (C area); the projection derives
		// the cleared view from it — never a silent second copy.
		expect(log.all.some((e) => e.type === "microcompacted")).toBe(true);
		expect(log.all.some((e) => e.type === "compacted")).toBe(false); // ADR-0044: never produced
		const projected = projectMessages(log.all);
		// The old tool results carry the placeholder in the projection.
		expect(projected.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("cleared"))).toBe(true);
	});
});


/**
 * P1 (0.1.42) — THE PAIRING INVARIANT: the projection never splits an
 * assistant's tool_calls from its results. The fresh2 repro: the model
 * streams THREE calls of one turn while the parallel execution completes
 * the FIRST call between the SECOND and THIRD call_end (the drain runs on
 * every stream event — loop.ts); the third call_end then arrives with a
 * SAME-TURN result buffered, and the old flush guard read that as a turn
 * boundary — the projection split into [A(c1,c2), T(c1), A(c3), T(c2), T(c3)],
 * an assistant whose results come after another assistant: the real
 * DeepSeek 400 that killed the bench T5 fresh2 third process.
 */
describe("the pairing invariant (P1 — the mid-stream interleaving)", () => {
	/** The check real providers enforce: every assistant tool_calls message
	 *  must be answered by its tool results before the next assistant/user. */
	function pairViolation(msgs: readonly Message[]): string | undefined {
		for (let i = 0; i < msgs.length; i++) {
			const m = msgs[i]!;
			if (m.role !== "assistant") continue;
			const calls = m.blocks.filter((b) => b.type === "tool_use");
			if (calls.length === 0) continue;
			const answered = new Set<string>();
			for (let j = i + 1; j < msgs.length; j++) {
				const n = msgs[j]!;
				if (n.role === "assistant" || n.role === "user") break;
				if (n.role === "tool") answered.add(n.callId);
			}
			for (const c of calls) {
				if (!answered.has(c.callId)) {
					return `missing ${c.callId} for the assistant tool_calls at ${i}`;
				}
			}
		}
		return undefined;
	}

	it("a same-turn result landing between the turn's call_ends never splits the assistant (the fresh2 shape)", () => {
		// The bench T5 fresh2 last turn, distilled: one model call streams
		// three read_file calls; the first execution completes (result lands)
		// BETWEEN the second and third call_end; the third call_end arrives
		// with the same-turn result already buffered.
		const events = [
			{ type: "user_input", content: "go" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
			{ type: "tool_call_end", callId: "c2", name: "read_file", input: { path: "b" } },
			{ type: "tool_result", callId: "c1", content: "r1", isError: false },
			{ type: "tool_call_end", callId: "c3", name: "read_file", input: { path: "c" } },
			{ type: "tool_result", callId: "c2", content: "r2", isError: false },
			{ type: "tool_result", callId: "c3", content: "r3", isError: false },
			{ type: "stop", reason: "tool_use" },
		] satisfies readonly EventInput[];
		const msgs = projectMessages(events);
		// The turn's THREE calls live in ONE assistant message…
		const assistants = msgs.filter(
			(m): m is AssistantMessage => m.role === "assistant" && m.blocks.some((b) => b.type === "tool_use"),
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]!.blocks.filter((b) => b.type === "tool_use")).toHaveLength(3);
		// …and every assistant tool_calls is answered by the immediately
		// following tool results (the pairing check — the 400 shape).
		expect(pairViolation(msgs)).toBeUndefined();
	});

	it("P1: a mid-execution input never separates the call from its result (the straddle's projection)", () => {
		// The boundary straddle's durable shape: the pair's call opens, the
		// stop closes the assistant, a user input arrives MID-EXECUTION,
		// and the call's result lands AFTER it. The request
		// [assistant, user, tool] is a real 400 — the mid-execution inputs
		// must be held and released AFTER the results flush: the input
		// takes effect when the turn's execution completes.
		const events = [
			{ type: "user_input", content: "t4" },
			{ type: "tool_call_end", callId: "p1", name: "read_file", input: { path: "a" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "user_input", content: "t5" }, // mid-execution
			{ type: "user_input", content: "t6" }, // mid-execution
			{ type: "tool_result", callId: "p1", content: "r", isError: false },
			{ type: "user_input", content: "t7" },
		] satisfies readonly EventInput[];
		const msgs = projectMessages(events);
		expect(pairViolation(msgs)).toBeUndefined();
		// Reading order: the assistant, its result, THEN the held inputs —
		// the pair is never separated by a user message.
		const roles = msgs.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user", "user", "user"]);
	});

	it("the turn-boundary flush: results arriving after the stop follow the turn's assistant (the guard's legit case)", () => {
		// Turn N closes at its stop; its results land after; turn N+1 opens
		// with a text delta — the closed turn's results flush BEFORE the new
		// assistant opens (the old guard's case, unchanged).
		const events = [
			{ type: "user_input", content: "go" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "tool_result", callId: "c1", content: "r1", isError: false },
			{ type: "text_delta", text: "ok" },
			{ type: "stop", reason: "end_turn" },
		] satisfies readonly EventInput[];
		const msgs = projectMessages(events);
		expect(pairViolation(msgs)).toBeUndefined();
		// Reading order: the assistant, its result, THEN the new turn's text.
		const roles = msgs.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
	});
});
