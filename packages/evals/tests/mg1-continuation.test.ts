/**
 * MG-1 (ADR-0051 Amendment 5) — the continuation envelope at the adapters.
 *
 * RED A1: the Anthropic request rebuild must insert the STORED opaque
 * blocks verbatim, in order, before text and tool_use — multiple and
 * redacted blocks included (an aggregated reasoning string plus a bare
 * signature cannot reconstruct them; the provider requires the complete
 * blocks back unmodified). Red today: `toAnthropicBlock` handles text and
 * tool_use only.
 *
 * RED A2: the Anthropic stream must CAPTURE thinking/redacted blocks as
 * one `anthropic.content_block` entry per block, emission-ordered,
 * `required` on tool-use turns. Red today: no `signature_delta` case
 * exists anywhere in the adapter.
 *
 * RED B: the compat reasoning replay is SCOPE-GATED — a turn whose
 * envelope belongs to a foreign scope replays `reasoning_content` as ""
 * (the monotone presence discipline holds; the CONTENT is withheld). Red
 * today: the replay is unscoped.
 *
 * C (the scope gate's model term): a model-only switch on the SAME
 * provider withholds the stored blocks — vacuously green until A1 lands,
 * then it pins that replay honors `modelId` (thinking blocks bind to the
 * model that produced them).
 *
 * GRANDFATHER: a pre-A5 turn (reasoning, no envelope) replays under the
 * pre-existing monotone rule byte-for-byte — green today and forever.
 */

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { Continuation, Message } from "@vincemakes/kiso-core";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";

const THINKING_BLOCK = { type: "thinking", thinking: "let me reason", signature: "sig-abc123" };
const REDACTED_BLOCK = { type: "redacted_thinking", data: "opaque-redacted-bytes" };

function anthropicEnvelope(modelId: string): Continuation {
	return {
		scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId },
		entries: [
			{ kind: "anthropic.content_block", required: true, data: JSON.stringify(THINKING_BLOCK) },
			{ kind: "anthropic.content_block", required: true, data: JSON.stringify(REDACTED_BLOCK) },
		],
	};
}

function fakeAnthropic(params: { onCreate?: (p: unknown) => void; events?: readonly unknown[] }) {
	return {
		messages: {
			stream: (p: unknown) => {
				params.onCreate?.(p);
				return {
					async *[Symbol.asyncIterator]() {
						for (const ev of params.events ?? []) yield ev;
					},
				};
			},
		},
	} as unknown as Anthropic;
}

function fakeOpenAI(params: { onCreate?: (p: unknown) => void }) {
	return {
		chat: {
			completions: {
				create: async (p: unknown) => {
					params.onCreate?.(p);
					return {
						async *[Symbol.asyncIterator]() {},
					};
				},
			},
		},
	} as unknown as OpenAI;
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

describe("MG-1 A1 — Anthropic replay inserts the stored blocks verbatim", () => {
	it("both blocks, in order, BEFORE text and tool_use, on a scope-matched request", async () => {
		let captured: { messages?: Array<{ role: string; content: unknown }> } = {};
		const adapter = createAnthropicAdapter(fakeAnthropic({ onCreate: (p) => (captured = p as typeof captured) }));
		const messages: Message[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				blocks: [
					{ type: "text", text: "I will use the tool." },
					{ type: "tool_use", callId: "c1", name: "web_search", input: { q: "k" } },
				],
				reasoning: "let me reason",
				continuation: anthropicEnvelope("claude-x"),
			},
			{ role: "tool", callId: "c1", content: "results", isError: false },
		];
		await drain(adapter.stream({ model: "claude-x", messages }));
		const assistant = captured.messages?.find((m) => m.role === "assistant");
		const content = assistant?.content as Array<Record<string, unknown>>;
		expect(Array.isArray(content)).toBe(true);
		expect(content[0], "first stored block, verbatim").toEqual(THINKING_BLOCK);
		expect(content[1], "second stored block, verbatim — redacted included").toEqual(REDACTED_BLOCK);
		expect(content[2]?.type).toBe("text");
		expect(content[3]?.type).toBe("tool_use");
	});

	it("C — a model-only switch on the same provider withholds the blocks", async () => {
		let captured: { messages?: Array<{ role: string; content: unknown }> } = {};
		const adapter = createAnthropicAdapter(fakeAnthropic({ onCreate: (p) => (captured = p as typeof captured) }));
		const messages: Message[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				blocks: [{ type: "text", text: "answer" }],
				reasoning: "let me reason",
				continuation: anthropicEnvelope("claude-OLD"),
			},
			{ role: "user", content: "next" },
		];
		await drain(adapter.stream({ model: "claude-NEW", messages }));
		const assistant = captured.messages?.find((m) => m.role === "assistant");
		const json = JSON.stringify(assistant?.content ?? "");
		expect(json).not.toContain("sig-abc123");
		expect(json).not.toContain("redacted");
		// Preserved-but-not-sent, exactly: switching BACK re-arms replay.
		await drain(adapter.stream({ model: "claude-OLD", messages }));
		const rearmed = JSON.stringify(captured.messages?.find((m) => m.role === "assistant")?.content ?? "");
		expect(rearmed).toContain("sig-abc123");
	});
});

describe("MG-1 A2 — the Anthropic stream captures whole blocks", () => {
	it("one entry per block, emission-ordered, required on a tool-use turn", async () => {
		const sdkEvents = [
			{ type: "message_start", message: { usage: { input_tokens: 10 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc123" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-redacted-bytes" } },
			{ type: "content_block_stop", index: 1 },
			{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "c1", name: "web_search" } },
			{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
			{ type: "content_block_stop", index: 2 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
		const adapter = createAnthropicAdapter(fakeAnthropic({ events: sdkEvents }));
		const events = await drain(adapter.stream({ model: "claude-x", messages: [{ role: "user", content: "go" }] }));
		const stop = events.find((e) => (e as { type: string }).type === "stop") as { continuation?: Continuation };
		expect(stop, "a stop was yielded").toBeDefined();
		const entries = stop.continuation?.entries ?? [];
		expect(entries.length, "one entry per thinking-family block").toBe(2);
		expect(entries[0]!.kind).toBe("anthropic.content_block");
		expect(JSON.parse(entries[0]!.data)).toEqual({ type: "thinking", thinking: "let me reason", signature: "sig-abc123" });
		expect(JSON.parse(entries[1]!.data)).toEqual({ type: "redacted_thinking", data: "opaque-redacted-bytes" });
		expect(entries.every((e) => e.required), "required on a tool-use turn").toBe(true);
	});
});

describe("MG-1 B — the compat reasoning replay is scope-gated", () => {
	it("a foreign-scope envelope replays reasoning_content as empty; the matching turn keeps its own", async () => {
		let captured: { messages?: Array<Record<string, unknown>> } = {};
		const adapter = createOpenAICompatAdapter(fakeOpenAI({ onCreate: (p) => (captured = p as typeof captured) }), {
			scope: { providerId: "deepseek" },
		});
		const foreign: Continuation = {
			scope: { providerId: "custom", apiId: "openai-chat", modelId: "other-model", endpoint: "https://other.example" },
			entries: [],
		};
		const matching: Continuation = {
			scope: { providerId: "deepseek", apiId: "openai-chat", modelId: "deepseek-v4-flash" },
			entries: [],
		};
		const messages: Message[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "old" }], reasoning: "FOREIGN-REASONING", continuation: foreign },
			{ role: "user", content: "again" },
			{ role: "assistant", blocks: [{ type: "text", text: "new" }], reasoning: "OWN-REASONING", continuation: matching },
			{ role: "user", content: "next" },
		];
		await drain(adapter.stream({ model: "deepseek-v4-flash", messages }));
		const assistants = (captured.messages ?? []).filter((m) => m.role === "assistant");
		expect(assistants[0]?.reasoning_content, "foreign content withheld, presence kept").toBe("");
		expect(assistants[1]?.reasoning_content, "matching scope replays its own").toBe("OWN-REASONING");
	});

	it("GRANDFATHER — a pre-A5 turn (no envelope) replays under the monotone rule unchanged", async () => {
		let captured: { messages?: Array<Record<string, unknown>> } = {};
		const adapter = createOpenAICompatAdapter(fakeOpenAI({ onCreate: (p) => (captured = p as typeof captured) }), {
			scope: { providerId: "deepseek" },
		});
		const messages: Message[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "old" }], reasoning: "LEGACY-REASONING" },
			{ role: "user", content: "next" },
		];
		await drain(adapter.stream({ model: "deepseek-v4-flash", messages }));
		const assistants = (captured.messages ?? []).filter((m) => m.role === "assistant");
		expect(assistants[0]?.reasoning_content, "the grandfather: today's rule, byte-for-byte").toBe("LEGACY-REASONING");
	});
});
