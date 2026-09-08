/**
 * OR-1 gate 4 — a tool call and the turn that carries its result.
 *
 * The round trip is the claim: the id the adapter EMITS as `callId` is the
 * id the kernel echoes back, and the id the adapter then puts on the wire
 * is that same `call_id` — not the item id (`fc_…`), which is a different
 * identity and pairs against stored state this adapter never has.
 *
 * The second request is built from the projection the kernel would build
 * from the first turn's events, so a divergence between "what the adapter
 * said the call was" and "what the adapter sends back" fails here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEvent, Message } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { type Rig, sseReply, startRig } from "./helpers/rig.js";

const TURN_ONE = [
	{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
	{ type: "response.output_text.delta", output_index: 0, delta: "searching" },
	{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] } },
	{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_abc", call_id: "call_9", name: "web_search", arguments: "" } },
	{ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"q":"kiso"}' },
	{ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_abc", call_id: "call_9", name: "web_search", arguments: '{"q":"kiso"}' } },
	{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 4 } } },
];

const TURN_TWO = [{ type: "response.completed", response: { id: "resp_2", status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 2 } } }];

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply(TURN_ONE));
});
afterEach(async () => {
	await rig.close();
});

describe("OR-1 tool turn — the id survives the round trip", () => {
	it("the emitted callId is the call_id, and the next request replays it as function_call_output", async () => {
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		const first: AdapterEvent[] = [];
		for await (const ev of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "find it" }] })) first.push(ev);

		const start = first.find((e) => e.type === "tool_call_start") as { callId: string; name: string };
		const end = first.find((e) => e.type === "tool_call_end") as { callId: string; name: string; input: unknown };
		expect(start.callId).toBe("call_9");
		expect(end.callId).toBe("call_9"); // start and end share ONE identity
		expect(end.input).toEqual({ q: "kiso" });
		// the item id is a different identity and never leaks into the union
		expect(JSON.stringify(first)).not.toContain("fc_abc");

		// The projection the kernel would hand back on the next turn.
		const next: Message[] = [
			{ role: "user", content: "find it" },
			{ role: "assistant", blocks: [{ type: "text", text: "searching" }, { type: "tool_use", callId: end.callId, name: end.name, input: end.input as Record<string, unknown> }] },
			{ role: "tool", callId: end.callId, content: "one result", isError: false },
		];
		rig.reply = sseReply(TURN_TWO);
		for await (const _ of adapter.stream({ model: "gpt-5.5", messages: next })) void _;

		expect(rig.requests).toHaveLength(2);
		const input = JSON.parse(rig.requests[1]!.body).input as Record<string, unknown>[];
		expect(input[2]).toEqual({ type: "function_call", call_id: "call_9", name: "web_search", arguments: '{"q":"kiso"}' });
		expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_9", output: "one result" });
		// no fabricated item id rides along — `id` would pair the call
		// against stored state that `store: false` never created
		expect(rig.requests[1]!.body).not.toContain('"id"');
	});

	it("an image in a tool result becomes an EXPLICIT note, never a silent drop", async () => {
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		rig.reply = sseReply(TURN_TWO);
		const messages: Message[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "shot", input: {} }] },
			{ role: "tool", callId: "c1", content: [{ type: "image", sourceType: "base64", mediaType: "image/png", data: "AAAA" }], isError: false },
		];
		for await (const _ of adapter.stream({ model: "gpt-5.5", messages })) void _;
		const input = JSON.parse(rig.requests[0]!.body).input as { output?: string }[];
		expect(input[2]!.output).toContain("image omitted");
		expect(input[2]!.output).toContain("image/png");
	});
});
