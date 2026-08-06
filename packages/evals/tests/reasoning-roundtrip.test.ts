/**
 * bootstrap P1/P2 + the merge round (0.1.23) C7 revision — DeepSeek thinking-mode
 * reasoning_content round-trip.
 *
 * DeepSeek's thinking mode REQUIRES the CURRENT turn's assistant messages
 * to carry reasoning_content (their own, or "" when the step produced no
 * thinking) — otherwise the API rejects the request with 400 ("The
 * reasoning_content in the thinking mode must be passed back to the API").
 *
 * 0.1.23 revision (the fresh-mystery fix): the field's PRESENCE follows a
 * MONOTONE rule — if ANY message in the projection carries reasoning,
 * EVERY assistant message carries the field (its own reasoning, or "");
 * otherwise none does. The old rule gated the field on the CURRENT turn
 * (hand-feel round C7), so at every turn boundary the just-finished turn's
 * assistant messages LOST the field — rewriting old history and breaking
 * the request byte prefix (D area request-level) at each boundary, which
 * killed the provider's prefix cache there. The monotone rule flips at
 * most ONCE per session (when the first thinking appears, usually in
 * turn 1), and never again: old reasoning is echoed (DeepSeek's own
 * caching guidance — byte-stable history; the echoed CoT is cache-hit, so
 * "token waste" is obsolete under cache pricing), old "" fields are
 * accepted (real-API verified: 200 + 2560 cached tokens), and real OpenAI
 * never produces reasoning → its requests never see the field (byte-
 * identical to the pre-0.1.23 behavior).
 *
 * The adapter derives everything deterministically from the projected
 * messages (D area): the projection attaches each turn's reasoning to its
 * assistant message.
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

describe("bootstrap P1/P2: reasoning_content round-trip (DeepSeek thinking mode)", () => {
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

	it("OLD turns' reasoning is ECHOED — the turn boundary never drops the field (0.1.23)", async () => {
		// The third request of a read→answer session: the answer turn reasoned,
		// and it lies BEFORE the new user message. The field presence must
		// not flip at the boundary (that flip rewrote old history and broke
		// the byte prefix — the fresh-mystery root cause): the old
		// assistant keeps its reasoning, the boundary keeps the shape.
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
		// The no-reasoning tool-call turn carries the empty string…
		expect(assistants[0]!.reasoning_content).toBe("");
		// …and the old answer turn's reasoning is echoed verbatim.
		expect(assistants[1]!.reasoning_content).toBe("The file says hello.");
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

	it("0.1.23: anthropic-thinking HISTORY + an openai continuation — the monotone rule carries every field", async () => {
		// The cross-provider shape: an OLD turn (before the last user
		// message) reasoned — it belongs to the anthropic family, the
		// session's previous adapter. The CURRENT turn (the openai
		// continuation) produced NO thinking. Under the monotone rule the
		// old reasoning makes EVERY assistant carry the field: the old
		// anthropic message echoes its reasoning (byte-stable history —
		// DeepSeek accepts it, cache-hit at 0.1×), the current turn's
		// no-thinking message carries "". The old C7 concern (don't tag a
		// foreign turn as thinking) is obsolete: the field is now a
		// per-history constant, not a mode declaration.
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
		expect(assistants[0]!.reasoning_content).toBe("Let me read it.");
		expect(assistants[1]!.reasoning_content).toBe("");
	});

	it("0.1.23: consecutive request bodies share the byte prefix through the older request's LAST message (D area request-level)", async () => {
		// The permanent regression for the fresh-mystery fix: two
		// consecutive request bodies spanning a turn boundary. The older
		// body must be a byte prefix of the newer one UP TO the close of
		// the older request's messages array — the only sanctioned
		// divergence is the array continuation (new messages insert inside
		// `messages`; the tail fields shift and re-align byte-identically).
		// The old C7 rule dropped reasoning_content at the boundary, so the
		// newer body diverged INSIDE an old message — this test pins that
		// regression closed.
		const turn1Events = [
			{ type: "user_input", content: "read the file" },
			{ type: "thinking", text: "I should look" },
			{ type: "thinking", text: " at the file." },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } },
			{ type: "stop", reason: "tool_use" },
			{ type: "tool_result", callId: "c1", content: "file contents", isError: false },
		] as const;
		const turn2Events = [
			{ type: "user_input", content: "and then?" },
			{ type: "text_delta", text: "It says hello." },
			{ type: "stop", reason: "end_turn" },
		] as const;

		const bodies: unknown[] = [];
		const adapter: Adapter = createOpenAICompatAdapter(
			fakeOpenAI({ onCreate: (p) => bodies.push(p) }),
		);
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages: projectMessages(turn1Events) })) {
			// drain
		}
		for await (const _ev of adapter.stream({ model: "deepseek-v4-flash", messages: projectMessages([...turn1Events, ...turn2Events]) })) {
			// drain
		}

		const s1 = JSON.stringify(bodies[0]);
		const s2 = JSON.stringify(bodies[1]);
		const msgs1 = JSON.stringify((bodies[0] as { messages: unknown[] }).messages);
		const msgs2 = JSON.stringify((bodies[1] as { messages: unknown[] }).messages);
		// The messages projection grows at the tail: turn 1's serialized
		// messages — minus the array's closing "]" — are a strict prefix of
		// the full projection's (the close bracket is where the new
		// messages insert, so it is the one sanctioned divergence).
		expect(msgs2.startsWith(msgs1.slice(0, -1))).toBe(true);
		// The request-level invariant: s2 starts with s1 through the close
		// of s1's LAST message (the close of the messages array is the only
		// divergence; the tail fields shift and re-align byte-identically).
		const endOfMsgs1 = s1.indexOf(msgs1) + msgs1.length;
		expect(s2.startsWith(s1.slice(0, endOfMsgs1 - 1))).toBe(true);
		// And the tail fields after the messages array are byte-identical.
		const endOfMsgs2 = s2.indexOf(msgs2) + msgs2.length;
		expect(s2.slice(endOfMsgs2)).toBe(s1.slice(endOfMsgs1));
	});
});
