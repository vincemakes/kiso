/**
 * Phase B — adapter contract tests:
 * 1. the cancellation signal is passed into the SDK call (both providers);
 * 2. the OpenAI-compat adapter forwards the system prompt as a system message.
 */

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";

const OPTS: StreamOptions = {
	model: "m",
	messages: [{ role: "user", content: "hi" }],
	systemPrompt: "you are kiso",
};

async function drain(adapter: Adapter, opts: StreamOptions): Promise<void> {
	for await (const _ev of adapter.stream(opts)) {
		// drain
	}
}

describe("anthropic adapter", () => {
	it("passes the AbortSignal into the SDK stream call", async () => {
		const ac = new AbortController();
		let seenOptions: Record<string, unknown> | undefined;
		const fakeClient = {
			messages: {
				stream: (_params: unknown, options?: Record<string, unknown>) => {
					seenOptions = options;
					return {
						async *[Symbol.asyncIterator]() {
							yield { type: "message_start", message: { usage: { input_tokens: 1 } } };
							yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
							yield { type: "message_stop" };
						},
					};
				},
			},
		} as unknown as Anthropic;

		await drain(createAnthropicAdapter(fakeClient), { ...OPTS, signal: ac.signal });
		expect(seenOptions?.signal).toBe(ac.signal);
	});
});

describe("openai-compat adapter", () => {
	it("passes the AbortSignal as a request option", async () => {
		const ac = new AbortController();
		let seenOptions: Record<string, unknown> | undefined;
		const fakeClient = {
			chat: {
				completions: {
					create: async (_params: unknown, options: Record<string, unknown>) => {
						seenOptions = options;
						return {
							async *[Symbol.asyncIterator]() {
								yield {
									id: "x",
									object: "chat.completion.chunk",
									created: 0,
									model: "m",
									choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								};
							},
						};
					},
				},
			},
		} as unknown as OpenAI;

		await drain(createOpenAICompatAdapter(fakeClient), { ...OPTS, signal: ac.signal });
		expect(seenOptions?.signal).toBe(ac.signal);
	});

	it("forwards the system prompt as a system-role message", async () => {
		let seenMessages: unknown[] | undefined;
		const fakeClient = {
			chat: {
				completions: {
					create: async (params: Record<string, unknown>) => {
						seenMessages = params.messages as unknown[];
						return {
							async *[Symbol.asyncIterator]() {
								yield {
									id: "x",
									object: "chat.completion.chunk",
									created: 0,
									model: "m",
									choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								};
							},
						};
					},
				},
			},
		} as unknown as OpenAI;

		await drain(createOpenAICompatAdapter(fakeClient), OPTS);
		expect(seenMessages?.[0]).toEqual({ role: "system", content: "you are kiso" });
		expect(seenMessages?.length).toBe(2); // system + user
	});

	it("keeps the system prompt off the adapter when none is configured", async () => {
		let seenMessages: unknown[] | undefined;
		const fakeClient = {
			chat: {
				completions: {
					create: async (params: Record<string, unknown>) => {
						seenMessages = params.messages as unknown[];
						return {
							async *[Symbol.asyncIterator]() {
								yield {
									id: "x",
									object: "chat.completion.chunk",
									created: 0,
									model: "m",
									choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								};
							},
						};
					},
				},
			},
		} as unknown as OpenAI;

		await drain(createOpenAICompatAdapter(fakeClient), { model: "m", messages: [{ role: "user", content: "hi" }] });
		expect(seenMessages?.length).toBe(1);
		expect(seenMessages?.[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
	});
});
