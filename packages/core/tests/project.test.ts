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
import type { Message } from "../src/protocol/messages.js";
import {
	EventLog,
	loop,
	messagesToEvents,
	projectMessages,
} from "../src/index.js";
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

		// The boundary is the durable fact (C 区); the projection derives
		// the cleared view from it — never a silent second copy.
		expect(log.all.some((e) => e.type === "microcompacted")).toBe(true);
		expect(log.all.some((e) => e.type === "compacted")).toBe(false); // ADR-0044: never produced
		const projected = projectMessages(log.all);
		// The old tool results carry the placeholder in the projection.
		expect(projected.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("cleared"))).toBe(true);
	});
});

