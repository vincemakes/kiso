/**
 * Area 6 — provider honesty: stop reasons never degrade into end_turn,
 * usage is never faked, and stream-creation errors are normalized so the
 * loop's pre-stream retry works.
 */

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";

const OPTS: StreamOptions = { model: "m", messages: [{ role: "user", content: "hi" }] };

async function drain(adapter: Adapter, opts: StreamOptions = OPTS): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const ev of adapter.stream(opts)) events.push(ev);
	return events;
}

function fakeAnthropic(events: unknown[]) {
	return {
		messages: {
			stream: () => ({
				async *[Symbol.asyncIterator]() {
					for (const ev of events) yield ev;
				},
			}),
		},
	} as unknown as Anthropic;
}

function fakeOpenAI(params: { chunks?: unknown[]; createError?: unknown; onCreate?: (p: unknown) => void }) {
	return {
		chat: {
			completions: {
				create: async (p: unknown) => {
					params.onCreate?.(p);
					if (params.createError !== undefined) throw params.createError;
					return {
						async *[Symbol.asyncIterator]() {
							for (const c of params.chunks ?? []) yield c;
						},
					};
				},
			},
		},
	} as unknown as OpenAI;
}

const CHUNK = (finish: string | null, delta: Record<string, unknown> = {}) => ({
	id: "x",
	object: "chat.completion.chunk",
	created: 0,
	model: "m",
	choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("anthropic stop-reason honesty", () => {
	it("refusal and pause_turn map to explicit stop reasons, never end_turn", async () => {
		const events = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{ type: "message_start", message: { usage: { input_tokens: 1 } } },
					{ type: "message_delta", delta: { stop_reason: "refusal" } },
					{ type: "message_stop" },
				]),
			),
		);
		const stop = events.find((e) => (e as { type?: string }).type === "stop");
		expect((stop as { reason?: string }).reason).toBe("refusal");

		const events2 = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{ type: "message_start", message: { usage: { input_tokens: 1 } } },
					{ type: "message_delta", delta: { stop_reason: "pause_turn" } },
					{ type: "message_stop" },
				]),
			),
		);
		const stop2 = events2.find((e) => (e as { type?: string }).type === "stop");
		expect((stop2 as { reason?: string }).reason).toBe("pause_turn");
	});

	it("model_context_window_exceeded maps to context_window", async () => {
		const events = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{ type: "message_start", message: { usage: { input_tokens: 1 } } },
					{ type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } },
					{ type: "message_stop" },
				]),
			),
		);
		const stop = events.find((e) => (e as { type?: string }).type === "stop");
		expect((stop as { reason?: string }).reason).toBe("context_window");
	});

	it("usage is known:false with null tokens when the provider reports nothing", async () => {
		const events = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{ type: "message_start", message: { usage: {} } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" } },
					{ type: "message_stop" },
				]),
			),
		);
		const usage = events.find((e) => (e as { type?: string }).type === "usage") as {
			known?: boolean;
			inputTokens?: number | null;
		};
		expect(usage?.known).toBe(false);
		expect(usage?.inputTokens).toBeNull();
	});
});

describe("openai-compat stream creation errors are normalized", () => {
	// Real SDK failures are APIError instances — the adapter maps them by
	// status; a pre-stream failure is a retryable StructuredError so the
	// loop's pre-stream retry works.
	const apiError = (status: number, message: string) =>
		new OpenAI.APIError(status, { message }, message, new Headers());

	it("a 429 on create() throws a retryable StructuredError — pre-stream retry works", async () => {
		const client = fakeOpenAI({ createError: apiError(429, "rate limited") });
		await expect(async () => {
			for await (const _ev of createOpenAICompatAdapter(client).stream(OPTS)) {
				// drain
			}
		}).rejects.toMatchObject({ code: "rate_limit", retryable: true });
	});

	it("a 5xx on create() throws a retryable StructuredError", async () => {
		const client = fakeOpenAI({ createError: apiError(503, "upstream down") });
		await expect(async () => {
			for await (const _ev of createOpenAICompatAdapter(client).stream(OPTS)) {
				// drain
			}
		}).rejects.toMatchObject({ code: "api_5xx", retryable: true });
	});

	it("content_filter and function_call finish reasons are explicit, never end_turn", async () => {
		const filtered = await drain(
			createOpenAICompatAdapter(fakeOpenAI({ chunks: [CHUNK("content_filter")] })),
		);
		const stop1 = filtered.find((e) => (e as { type?: string }).type === "stop");
		expect((stop1 as { reason?: string }).reason).toBe("content_filter");

		const legacy = await drain(
			createOpenAICompatAdapter(fakeOpenAI({ chunks: [CHUNK("function_call")] })),
		);
		const stop2 = legacy.find((e) => (e as { type?: string }).type === "stop");
		expect((stop2 as { reason?: string }).reason).toBe("function_call");
	});

	it("usage with no provider report is known:false with nulls, not zeros", async () => {
		const events = await drain(
			createOpenAICompatAdapter(fakeOpenAI({ chunks: [CHUNK("stop")] })),
		);
		const usage = events.find((e) => (e as { type?: string }).type === "usage") as {
			known?: boolean;
			inputTokens?: number | null;
		};
		expect(usage?.known).toBe(false);
		expect(usage?.inputTokens).toBeNull();
	});

	it("a TRUNCATED stream (no finish_reason) stops with an error — never completed (review finding 4)", async () => {
		const events = await drain(
			createOpenAICompatAdapter(
				fakeOpenAI({
					// Chunks stream content but the connection dies before any
					// finish_reason — the SDK does not throw on premature end.
					chunks: [CHUNK(null, { content: "half a sentence" })],
				}),
			),
		);
		const stop = events.find((e) => (e as { type?: string }).type === "stop");
		expect((stop as { reason?: string }).reason).toBe("error");
	});

	it("a tool name arriving in a LATER delta is captured, not lost (review finding 10)", async () => {
		const events = await drain(
			createOpenAICompatAdapter(
				fakeOpenAI({
					chunks: [
						CHUNK(null, { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "" } }] }),
						CHUNK(null, { tool_calls: [{ index: 0, function: { name: "web_search", arguments: '{"q":"k"}' } }] }),
						CHUNK("tool_calls"),
					],
				}),
			),
		);
		const end = events.find((e) => (e as { type?: string }).type === "tool_call_end");
		expect((end as { name?: string }).name).toBe("web_search");
		expect((end as { input?: unknown }).input).toEqual({ q: "k" });
	});
});
