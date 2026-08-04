/**
 * 自举 P1 — DeepSeek thinking-mode reasoning_content round-trip.
 *
 * DeepSeek's thinking mode REQUIRES the assistant messages of a follow-up
 * request to carry the reasoning_content they were generated with —
 * otherwise the API rejects the request with 400 ("The reasoning_content
 * in the thinking mode must be passed back to the API"). Every
 * 思考→工具→继续 trajectory breaks at the request after the tool result.
 *
 * The adapter must therefore attach reasoning_content to assistant
 * messages, DERIVED deterministically from the event stream: the thinking
 * deltas are already persisted facts, the projection attaches them to the
 * assistant message they belong to (same events → same request body,
 * D 区), and the OpenAI-compat adapter passes them through. Real OpenAI
 * never emits thinking events, so it is never affected.
 */

import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { projectMessages } from "@vincemakes/kiso-core";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";

function fakeOpenAI(params: { onCreate?: (p: unknown) => void }) {
	return {
		chat: {
			completions: {
				create: async (p: unknown) => {
					params.onCreate?.(p);
					return {
						async *[Symbol.asyncIterator]() {
							// no chunks — the request capture is what matters
						},
					};
				},
			},
		},
	} as unknown as OpenAI;
}

describe("自举 P1: reasoning_content round-trip (DeepSeek thinking mode)", () => {
	it("the follow-up request's assistant message carries the reasoning_content of its turn", async () => {
		// The DeepSeek shape: thinking deltas → tool call → stop, then the
		// tool result, then the next user turn. The follow-up request must
		// send the assistant message WITH reasoning_content.
		const messages = projectMessages([
			{ type: "user_input", content: "read the file" },
			{ type: "thinking", text: "I should look at" },
			{ type: "thinking", text: " the file first." },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
			{ type: "user_input", content: "summarize" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		const opts: StreamOptions = { model: "deepseek-v4-flash", messages };
		for await (const _ev of adapter.stream(opts)) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		const assistant = request.messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.tool_calls).toBeDefined();
		// The full reasoning of the turn, verbatim from the thinking deltas.
		expect(assistant?.reasoning_content).toBe("I should look at the file first.");
	});

	it("a text-only answer turn with reasoning also round-trips it", async () => {
		// The answer turn of a 读文件→回答 task: thinking + text, no tool
		// call. A THIRD turn's request must still carry the reasoning.
		const messages = projectMessages([
			{ type: "user_input", content: "read the file" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
			{ type: "thinking", text: "The file says" },
			{ type: "thinking", text: " hello." },
			{ type: "text_delta", text: "It says hello." },
			{ type: "stop", reason: "end_turn" },
			{ type: "user_input", content: "and then?" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages })) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		// The LAST assistant message is the answer turn — the earlier one is
		// the tool-call turn, which reasoned nothing.
		const assistant = [...request.messages].reverse().find((m) => m.role === "assistant");
		expect(assistant?.reasoning_content).toBe("The file says hello.");
	});

	it("a text-only assistant message serializes WITHOUT a tool_calls key", async () => {
		// A turn with no tool calls must not send an empty tool_calls array —
		// OpenAI-compat APIs reject that with 400 ("expected an array with
		// minimum length 1"). The field is omitted entirely.
		const messages = projectMessages([
			{ type: "user_input", content: "hi" },
			{ type: "text_delta", text: "Hello!" },
			{ type: "stop", reason: "end_turn" },
			{ type: "user_input", content: "and then?" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages })) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		const assistant = request.messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant).not.toHaveProperty("tool_calls");
		expect(assistant?.content).toBe("Hello!");
	});
});
