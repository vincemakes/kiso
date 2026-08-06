/**
 * 自举 P1/P2 — DeepSeek thinking-mode reasoning_content round-trip.
 *
 * DeepSeek's thinking mode REQUIRES the CURRENT turn's assistant messages
 * to carry reasoning_content (their own, or "" when the step produced no
 * thinking) — otherwise the API rejects the request with 400 ("The
 * reasoning_content in the thinking mode must be passed back to the API").
 * OLD turns' CoT (before the last user message) must NOT be echoed —
 * DeepSeek explicitly does not need it, and echoing is pure token waste.
 *
 * The adapter derives everything deterministically from the projected
 * messages (D 区): the projection attaches each turn's reasoning to its
 * assistant message. The adapter detects thinking mode by the presence of
 * ANY reasoning in the projection (real OpenAI never emits thinking
 * events, so it never sees the field), and attaches reasoning_content only
 * to assistant messages AFTER the last user message.
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

describe("自举 P1/P2: reasoning_content round-trip (DeepSeek thinking mode)", () => {
	it("the continuation request after a tool result carries the CURRENT turn's reasoning", async () => {
		// The DeepSeek shape: thinking deltas → tool call → stop, then the
		// tool result. The continuation request (no new user turn yet) must
		// send the current turn's assistant message WITH its reasoning —
		// this is the request that used to 400.
		const messages = projectMessages([
			{ type: "user_input", content: "read the file" },
			{ type: "thinking", text: "I should look at" },
			{ type: "thinking", text: " the file first." },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
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

	it("OLD turns' reasoning is omitted — a new user turn's request does not echo it", async () => {
		// The third request of a 读→答 session: the answer turn reasoned,
		// but it lies BEFORE the new user message — DeepSeek does not need
		// old CoT, so neither assistant carries reasoning_content.
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
		const assistants = request.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		for (const assistant of assistants) {
			expect(assistant).not.toHaveProperty("reasoning_content");
		}
	});

	it("a current-turn step that produced NO thinking attaches an EMPTY string", async () => {
		// Real shape: after the tool result the model answers WITHOUT
		// reasoning (thinking mode can skip it). The turn is still in
		// thinking mode (an earlier assistant reasoned), so this assistant
		// must carry reasoning_content — its own, which is "".
		const messages = projectMessages([
			{ type: "user_input", content: "read the file" },
			{ type: "thinking", text: "I should look" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
			{ type: "text_delta", text: "It says hello." },
			{ type: "stop", reason: "end_turn" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages })) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		const assistants = request.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		// The tool-call turn carries its reasoning…
		expect(assistants[0]!.reasoning_content).toBe("I should look");
		// …and the no-thinking answer turn carries the empty string —
		// the field must be PRESENT, or DeepSeek 400s.
		expect(assistants[1]!.reasoning_content).toBe("");
	});

	it("NON-thinking mode never carries the field — real OpenAI is untouched", async () => {
		// No reasoning anywhere in the projection: the provider is not in
		// thinking mode, so no assistant message gets reasoning_content —
		// even the current-turn one. Real OpenAI never emits thinking
		// events, so its requests never see the field.
		const messages = projectMessages([
			{ type: "user_input", content: "hi" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
			{ type: "text_delta", text: "Done." },
			{ type: "stop", reason: "end_turn" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		for await (const _ev of adapter.stream({ model: "gpt-4o", messages })) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		for (const m of request.messages) {
			expect(m).not.toHaveProperty("reasoning_content");
		}
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

	it("C7 (P4): anthropic-thinking HISTORY + an openai continuation never flips the mode — no reasoning is passed back", async () => {
		// The cross-provider shape: an OLD turn (before the last user
		// message) reasoned — it belongs to the anthropic family, the
		// session's previous adapter. The CURRENT turn (the openai
		// continuation) produced NO thinking. The old reasoning must NOT
		// flip thinking mode: the request would otherwise carry
		// `reasoning_content: ""` on a turn this adapter has no business
		// tagging as thinking (the simple judgment: current-turn messages
		// carry no source marker — the current adapter is their source).
		const messages = projectMessages([
			{ type: "user_input", content: "what does this file do?" },
			{ type: "thinking", text: "Let me read it." }, // anthropic thinking — the OLD turn
			{ type: "text_delta", text: "Let me read it." },
			{ type: "stop", reason: "end_turn" },
			{ type: "user_input", content: "and the tests?" },
			{ type: "text_delta", text: "Tests live in tests/." }, // the openai continuation — no thinking
			{ type: "stop", reason: "end_turn" },
		]);

		let captured: unknown;
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => (captured = p) }),
		);
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages })) {
			// drain
		}

		const request = captured as { messages: Array<Record<string, unknown>> };
		const assistants = request.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		for (const assistant of assistants) {
			expect(assistant).not.toHaveProperty("reasoning_content");
		}
	});
});
