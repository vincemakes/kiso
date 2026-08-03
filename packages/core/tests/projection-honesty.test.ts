/**
 * D 组 — projection honesty.
 *
 * D1: tool results carry the FULL ContentBlock[] and tags losslessly.
 * D2: explicit assistant-message boundaries — adjacent assistants, EMPTY
 *     assistants, source, images, and tags all round-trip.
 * D6: compacted events apply their PERSISTED replacements verbatim — a
 *     future version of the algorithm must never change the replay.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../src/protocol/messages.js";
import { EventLog, messagesToEvents, projectMessages } from "../src/index.js";

describe("D1: tool results carry full content blocks and tags", () => {
	it("a tool message with image blocks round-trips", () => {
		const seed: readonly Message[] = [
			{ role: "user", content: "look" },
			{
				role: "assistant",
				blocks: [{ type: "tool_use", callId: "c1", name: "render", input: {} }],
			},
			{
				role: "tool",
				callId: "c1",
				content: [
					{ type: "text", text: "here is the chart:" },
					{ type: "image", sourceType: "base64", data: "cG5n", mediaType: "image/png" },
				],
				isError: false,
				tags: ["do-not-compact", "artifact"],
			},
		];
		expect(projectMessages(messagesToEvents(seed))).toEqual(seed);
	});
});

describe("D2: explicit assistant-message boundaries", () => {
	it("two ADJACENT assistant messages keep their boundary", () => {
		const seed: readonly Message[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "first reply" }], source: "model" },
			{ role: "assistant", blocks: [{ type: "text", text: "second reply" }], source: "model" },
			{ role: "user", content: "more" },
		];
		const projected = projectMessages(messagesToEvents(seed));
		expect(projected).toEqual(seed);
	});

	it("an EMPTY assistant message round-trips", () => {
		const seed: readonly Message[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [] },
			{ role: "user", content: "next" },
		];
		expect(projectMessages(messagesToEvents(seed))).toEqual(seed);
	});

	it("tool calls and text interleave across adjacent assistants", () => {
		const seed: readonly Message[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				blocks: [
					{ type: "text", text: "calling" },
					{ type: "tool_use", callId: "c1", name: "web_search", input: { query: "k" } },
				],
			},
			{ role: "tool", callId: "c1", content: "results", isError: false },
			{ role: "assistant", blocks: [{ type: "text", text: "done" }] },
		];
		expect(projectMessages(messagesToEvents(seed))).toEqual(seed);
	});
});

describe("D6: compacted replay applies the PERSISTED replacements verbatim", () => {
	it("a custom replacement (never produced by the algorithm) is applied as-is", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_result", callId: "c1", content: "original content", isError: false });
		// A FUTURE compaction version might write a completely different
		// marker — the replay must apply exactly what was persisted.
		log.append({ type: "compacted", cleared: [{ callId: "c1", content: "[future-marker v9]" }] });
		const projected = projectMessages(log.all);
		const tool = projected.find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
		expect(tool?.content).toBe("[future-marker v9]");
	});
});
