/**
 * OR-1 gate 2 — the stream mapping.
 *
 * One recorded script drives the adapter and all NINE whitelisted event
 * types come out, in order. Three separate invariants ride along, each
 * of which an adapter can violate while still "working":
 *  - `usage` precedes `stop`, always, and both come from the SAME
 *    terminal event (a usage read from a later frame would be a
 *    different response's);
 *  - a stream that dies before a terminal event ends in
 *    `usage { known:false }` + `stop { reason:"error" }` and NOTHING
 *    after — a truncated turn is never reported as a clean one;
 *  - `function_call_arguments.done` emits only the part the deltas did
 *    not already carry, so the accumulated input is the arguments
 *    exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEvent } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { cutReply, type Rig, sseReply, startRig, truncatedReply } from "./helpers/rig.js";

const REASONING_ITEM = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" };

/** The full script: reasoning, then text, then a tool call, then done. */
const SCRIPT = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
	{ type: "response.reasoning_text.delta", output_index: 0, delta: "hmm" },
	{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: " so" },
	{ type: "response.output_item.done", output_index: 0, item: REASONING_ITEM },
	{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
	{ type: "response.output_text.delta", output_index: 1, delta: "Hel" },
	{ type: "response.output_text.delta", output_index: 1, delta: "lo" },
	{
		type: "response.output_item.done",
		output_index: 1,
		item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
	},
	{ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "web_search", arguments: "" } },
	{ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"q":' },
	{ type: "response.function_call_arguments.delta", output_index: 2, delta: '"k"}' },
	{ type: "response.function_call_arguments.done", output_index: 2, arguments: '{"q":"k"}' },
	{ type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "web_search", arguments: '{"q":"k"}' } },
	{
		type: "response.completed",
		response: { id: "resp_1", status: "completed", output: [REASONING_ITEM], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } },
	},
];

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply(SCRIPT));
});
afterEach(async () => {
	await rig.close();
});

async function collect(): Promise<AdapterEvent[]> {
	const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
	const out: AdapterEvent[] = [];
	for await (const ev of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }] })) out.push(ev);
	return out;
}

describe("OR-1 stream — the nine events, in order", () => {
	it("the whole script maps to the nine types in emission order", async () => {
		const events = await collect();
		expect(events.map((e) => e.type)).toEqual([
			"thinking",
			"thinking",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"tool_call_start",
			"tool_call_input_delta",
			"tool_call_input_delta",
			"tool_call_end",
			"usage",
			"stop",
		]);
		expect(events[0]).toEqual({ seq: 0, type: "thinking", text: "hmm" });
		expect(events[1]).toEqual({ seq: 0, type: "thinking", text: " so" });
		expect(events[3]).toEqual({ seq: 0, type: "text_delta", text: "Hel" });
		expect(events[6]).toEqual({ seq: 0, type: "tool_call_start", callId: "call_9", name: "web_search" });
		expect(events[7]).toEqual({ seq: 0, type: "tool_call_input_delta", callId: "call_9", inputJsonDelta: '{"q":' });
		expect(events[9]).toMatchObject({ type: "tool_call_end", callId: "call_9", name: "web_search", input: { q: "k" } });
	});

	it("usage precedes stop, carries the RAW input count and the cached read, and never invents a cache write", async () => {
		const events = await collect();
		const usageAt = events.findIndex((e) => e.type === "usage");
		const stopAt = events.findIndex((e) => e.type === "stop");
		expect(usageAt).toBeGreaterThanOrEqual(0);
		expect(stopAt).toBe(usageAt + 1);
		expect(events[usageAt]).toEqual({
			seq: 0,
			type: "usage",
			// RAW: the runtime canonicalizes this route as "total" and
			// subtracts the cached prefix itself — subtracting here too
			// would bill the cached tokens away twice.
			inputTokens: 100,
			outputTokens: 20,
			cacheRead: 60,
			cacheWrite: null,
			known: true,
		});
	});

	it("a completed response that made a tool call stops with tool_use", async () => {
		const events = await collect();
		expect(events[events.length - 1]).toMatchObject({ type: "stop", reason: "tool_use" });
	});

	it("a completed response with no tool call stops with end_turn", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
			{ type: "response.output_text.delta", output_index: 0, delta: "hi" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [] } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const events = await collect();
		expect(events[events.length - 1]).toMatchObject({ type: "stop", reason: "end_turn" });
	});

	it("an incomplete response truncated at the output cap stops with max_tokens", async () => {
		rig.reply = sseReply([
			{ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 1, output_tokens: 9 } } },
		]);
		const events = await collect();
		expect(events.map((e) => e.type)).toEqual(["usage", "stop"]);
		expect(events[1]).toMatchObject({ type: "stop", reason: "max_tokens" });
	});

	it("an incomplete response for any OTHER reason is an error stop, never a clean end", async () => {
		rig.reply = sseReply([
			{ type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [], usage: null } },
		]);
		const events = await collect();
		expect(events[events.length - 1]).toMatchObject({ type: "stop", reason: "error" });
	});

	it("a terminal event with no usage reports UNKNOWN — nulls, never a free turn", async () => {
		rig.reply = sseReply([{ type: "response.completed", response: { id: "r", status: "completed", output: [] } }]);
		const events = await collect();
		expect(events[0]).toEqual({ seq: 0, type: "usage", inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null, known: false });
	});

	it("a refusal delta is text on the same block, not a dropped frame", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
			{ type: "response.refusal.delta", output_index: 0, delta: "I cannot" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [] } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const events = await collect();
		expect(events.map((e) => e.type)).toEqual(["text_start", "text_delta", "text_end", "usage", "stop"]);
		expect(events[1]).toEqual({ seq: 0, type: "text_delta", text: "I cannot" });
	});

	it("a connection that DIES mid-stream throws a retryable network error — the kernel's stream-cut recovery, never a fake stop", async () => {
		rig.reply = cutReply(SCRIPT, 8); // the socket is destroyed after the second text delta
		await expect(collect()).rejects.toMatchObject({ code: "network", retryable: true });
	});

	it("a stream the provider ENDS without a terminal frame is a truncated turn: usage{known:false} then stop{error} and NOTHING after", async () => {
		rig.reply = truncatedReply(SCRIPT, 8); // ends cleanly after the second text delta
		const events = await collect();
		const stopAt = events.findIndex((e) => e.type === "stop");
		expect(stopAt).toBe(events.length - 1);
		expect(events[stopAt - 1]).toEqual({ seq: 0, type: "usage", inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null, known: false });
		expect(events[stopAt]).toMatchObject({ seq: 0, type: "stop", reason: "error" });
		// The reasoning item that DID close before the cut still rides the
		// stop: it is complete and signed, and a resumed turn needs it.
		// Truncation costs the turn, not the state that was already valid.
		expect((events[stopAt] as { continuation?: { entries: unknown[] } }).continuation?.entries).toHaveLength(1);
		// the text that DID arrive is still reported — a truncated turn is
		// not an erased one
		expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2);
	});

	it("function_call_arguments.done emits only the suffix the deltas did not carry", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c", name: "t", arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":' },
			{ type: "response.function_call_arguments.done", output_index: 0, arguments: '{"a":1}' },
			{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c", name: "t", arguments: '{"a":1}' } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const events = await collect();
		const deltas = events.filter((e) => e.type === "tool_call_input_delta") as { inputJsonDelta: string }[];
		expect(deltas.map((d) => d.inputJsonDelta)).toEqual(['{"a":', '1}']);
		expect(deltas.map((d) => d.inputJsonDelta).join("")).toBe('{"a":1}');
	});

	it("arguments that are not JSON are an ERROR, never a silently repaired input", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c", name: "t", arguments: "" } },
			{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c", name: "t", arguments: "{not json" } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } },
		]);
		await expect(collect()).rejects.toMatchObject({ code: "invalid_request", retryable: false });
	});

	it("a tool call whose call_id changes under the same output index throws", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c1", name: "t", arguments: "" } },
			{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c2", name: "t", arguments: "{}" } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } },
		]);
		await expect(collect()).rejects.toMatchObject({ code: "invalid_request", retryable: false });
	});

	it("a delta whose output_item.added never arrived still opens its block — text is never dropped", async () => {
		rig.reply = sseReply([
			{ type: "response.output_text.delta", output_index: 0, delta: "orphan" },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } },
		]);
		const events = await collect();
		expect(events.map((e) => e.type)).toEqual(["text_start", "text_delta", "usage", "stop"]);
	});

	it("a function_call done frame with no added frame still gets its start — an end never precedes one", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc", call_id: "c7", name: "t", arguments: '{"a":1}' } },
			{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } },
		]);
		const events = await collect();
		expect(events.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_end", "usage", "stop"]);
		expect(events[0]).toEqual({ seq: 0, type: "tool_call_start", callId: "c7", name: "t" });
		expect(events[1]).toMatchObject({ type: "tool_call_end", callId: "c7", input: { a: 1 } });
	});

	it("a stream error frame is a mapped throw, not a stop event", async () => {
		rig.reply = sseReply([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
			{ type: "error", code: "server_error", message: "the model exploded" },
		]);
		await expect(collect()).rejects.toMatchObject({ message: expect.stringContaining("the model exploded") });
	});

	it("response.failed is a mapped throw carrying the provider's reason", async () => {
		rig.reply = sseReply([
			{ type: "response.failed", response: { id: "r", status: "failed", error: { code: "rate_limit_exceeded", message: "slow down" } } },
		]);
		await expect(collect()).rejects.toMatchObject({ message: expect.stringContaining("slow down") });
	});
});
