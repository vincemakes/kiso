/**
 * D 组 — provider honesty round 2.
 *
 * D3: null/absent stops and unknown finish reasons map to `error`, never
 *     completed. D4: 500-599 are retryable; connection/timeout errors are
 *     recognized. D5: OpenAI requests real streaming usage; Anthropic cache
 *     counters are read, not faked as zero.
 */

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { mapApiError } from "@vincemakes/kiso-core";
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

describe("D3: absent/unknown stops are errors", () => {
	it("Anthropic message_stop WITHOUT a message_delta stops with 'error', not end_turn", async () => {
		const events = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{ type: "message_start", message: { usage: { input_tokens: 1 } } },
					{ type: "message_stop" }, // no delta — no stop_reason was ever seen
				]),
			),
		);
		const stop = events.find((e) => (e as { type?: string }).type === "stop");
		expect((stop as { reason?: string }).reason).toBe("error");
	});

	it("an unknown OpenAI finish reason stops with 'error', never completed", async () => {
		// The SDK union is closed; a future/compat provider can still emit
		// an unknown value at runtime — it must NOT degrade to end_turn.
		const events = await drain(
			createOpenAICompatAdapter(fakeOpenAI({ chunks: [CHUNK("totally_new_reason" as string)] })),
		);
		const stop = events.find((e) => (e as { type?: string }).type === "stop");
		expect((stop as { reason?: string }).reason).toBe("error");
	});
});

describe("D4: error classification", () => {
	it("every 500-599 status is retryable api_5xx", () => {
		for (const status of [500, 501, 505, 507, 529, 599]) {
			const err = mapApiError(status, "upstream");
			expect(err.code, String(status)).toBe(status === 529 ? "overloaded" : "api_5xx");
			expect(err.retryable, String(status)).toBe(true);
		}
	});

	it("Anthropic connection errors map to retryable network/timeout", async () => {
		const connection = new Anthropic.APIConnectionError({ message: "socket hang up" } as never);
		const timeout = new Anthropic.APIConnectionTimeoutError();
		const adapter = createAnthropicAdapter(
			{
				messages: {
					stream: () => {
						throw connection;
					},
				},
			} as unknown as Anthropic,
		);
		await expect(async () => {
			for await (const _ev of adapter.stream(OPTS)) {
				// drain
			}
		}).rejects.toMatchObject({ code: "network", retryable: true });

		const adapter2 = createAnthropicAdapter(
			{
				messages: {
					stream: () => {
						throw timeout;
					},
				},
			} as unknown as Anthropic,
		);
		await expect(async () => {
			for await (const _ev of adapter2.stream(OPTS)) {
				// drain
			}
		}).rejects.toMatchObject({ code: "timeout", retryable: true });
	});
});

describe("D5: real usage", () => {
	it("OpenAI requests streaming usage explicitly (stream_options.include_usage)", async () => {
		let seenParams: Record<string, unknown> | undefined;
		const client = fakeOpenAI({
			chunks: [CHUNK("stop")],
			onCreate: (p) => {
				seenParams = p as Record<string, unknown>;
			},
		});
		await drain(createOpenAICompatAdapter(client));
		expect(seenParams?.stream_options).toEqual({ include_usage: true });
	});

	it("Anthropic cache read/write counters are read from the SDK, never faked as 0", async () => {
		const events = await drain(
			createAnthropicAdapter(
				fakeAnthropic([
					{
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								cache_creation_input_tokens: 40,
								cache_read_input_tokens: 60,
							},
						},
					},
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
					{ type: "message_stop" },
				]),
			),
		);
		const usage = events.find((e) => (e as { type?: string }).type === "usage") as {
			cacheRead?: number;
			cacheWrite?: number;
			inputTokens?: number;
		};
		expect(usage?.cacheRead).toBe(60);
		expect(usage?.cacheWrite).toBe(40);
		expect(usage?.inputTokens).toBe(10);
	});
});
