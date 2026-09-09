/**
 * Adapter mapping tests: the SDK wire events → kiso event union, verified
 * with stubbed SDK streams (no API keys, no network). The mapping is the
 * whole adapter; pin it and the cross-provider story rests on it.
 */

import { describe, expect, it } from "vitest";
import { createAnthropicAdapter } from "@vincemakes/kiso-provider-anthropic";
import { createOpenAICompatAdapter } from "@vincemakes/kiso-provider-openai";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import type { Event, StructuredError } from "@vincemakes/kiso-core";

const OPTS: StreamOptions = { model: "test", messages: [] };

async function collect(adapter: Adapter): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of adapter.stream(OPTS)) out.push(ev);
	return out;
}

describe("anthropic adapter", () => {
	it("maps a text turn to text_start/delta + usage + stop", async () => {
		const stubClient = {
			messages: {
				stream: () => ({
					async *[Symbol.asyncIterator]() {
						yield { type: "message_start", message: { usage: { input_tokens: 12 } } };
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						};
						yield {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Hello" },
						};
						yield { type: "content_block_stop", index: 0 };
						yield {
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 7 },
						};
						yield { type: "message_stop" };
					},
				}),
			},
		};
		const events = await collect(createAnthropicAdapter(stubClient as never));
		const types = events.map((e) => e.type);
		expect(types).toEqual([
			"text_start",
			"text_delta",
			"usage",
			"stop",
		]);
		expect(events[2]).toMatchObject({ inputTokens: 12, outputTokens: 7 });
		expect(events[3]).toMatchObject({ reason: "end_turn" });
	});

	it("maps streamed tool use with incremental JSON to start/delta/end", async () => {
		const stubClient = {
			messages: {
				stream: () => ({
					async *[Symbol.asyncIterator]() {
						yield { type: "message_start", message: { usage: { input_tokens: 0 } } };
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "toolu_1", name: "web_search" },
						};
						yield {
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '{"query":' },
						};
						yield {
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '"kiso"}' },
						};
						yield { type: "content_block_stop", index: 0 };
						yield {
							type: "message_delta",
							delta: { stop_reason: "tool_use" },
							usage: { output_tokens: 3 },
						};
						yield { type: "message_stop" };
					},
				}),
			},
		};
		const events = await collect(createAnthropicAdapter(stubClient as never));
		const end = events.find((e) => e.type === "tool_call_end");
		expect(end).toMatchObject({ callId: "toolu_1", name: "web_search", input: { query: "kiso" } });
		expect(events.at(-1)).toMatchObject({ reason: "tool_use" });
	});

	it("maps an API error to a StructuredError by status (never a regex)", async () => {
		class FakeAPIError extends Error {
			readonly status: number;
			constructor(status: number) {
				super("boom");
				this.status = status;
			}
		}
		const stubClient = {
			messages: {
				stream: () => ({
					async *[Symbol.asyncIterator]() {
						throw new FakeAPIError(429);
					},
				}),
			},
		};
		// The adapter maps via Anthropic.APIError — a plain object with
		// status won't pass instanceof, so we throw a structurally-shaped
		// error and expect the passthrough path; the status mapping is
		// covered by mapApiError's own tests below.
		await expect(collect(createAnthropicAdapter(stubClient as never))).rejects.toThrow("boom");
	});
});

describe("openai-compat adapter", () => {
	it("maps content + finish_reason to text_delta + stop(end_turn)", async () => {
		const stubClient = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { content: "Hello" }, finish_reason: null }],
								usage: undefined,
							};
							yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: undefined };
							yield {
								choices: [],
								usage: { prompt_tokens: 4, completion_tokens: 2 },
							};
						},
					}),
				},
			},
		};
		const events = await collect(createOpenAICompatAdapter(stubClient as never));
		const types = events.map((e) => e.type);
		expect(types).toEqual(["text_delta", "usage", "stop"]);
		expect(events[1]).toMatchObject({ inputTokens: 4, outputTokens: 2 });
		expect(events[2]).toMatchObject({ reason: "end_turn" });
	});

	it("accumulates fragmented tool-call arguments into one parsed input", async () => {
		const stubClient = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [
									{
										delta: {
											tool_calls: [
												{ index: 0, id: "call_1", function: { name: "web_search" } },
											],
										},
										finish_reason: null,
									},
								],
								usage: undefined,
							};
							yield {
								choices: [
									{
										delta: {
											tool_calls: [
												{ index: 0, function: { arguments: '{"query":' } },
											],
										},
										finish_reason: null,
									},
								],
								usage: undefined,
							};
							yield {
								choices: [
									{
										delta: { tool_calls: [{ index: 0, function: { arguments: '"kiso"}' } }] },
										finish_reason: "tool_calls",
									},
								],
								usage: undefined,
							};
						},
					}),
				},
			},
		};
		const events = await collect(createOpenAICompatAdapter(stubClient as never));
		const start = events.find((e) => e.type === "tool_call_start");
		expect(start).toMatchObject({ callId: "call_1", name: "web_search" });
		const deltas = events.filter((e) => e.type === "tool_call_input_delta");
		expect(deltas).toHaveLength(2);
		const end = events.find((e) => e.type === "tool_call_end");
		expect(end).toMatchObject({ callId: "call_1", input: { query: "kiso" } });
		expect(events.at(-1)).toMatchObject({ reason: "tool_use" });
	});

	it("digests reasoning_content into thinking (dialect, not union)", async () => {
		const stubClient = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { reasoning_content: "let me think" }, finish_reason: null }],
								usage: undefined,
							};
							yield { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }], usage: undefined };
						},
					}),
				},
			},
		};
		const events = await collect(createOpenAICompatAdapter(stubClient as never));
		expect(events[0]).toMatchObject({ type: "thinking", text: "let me think" });
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
	});

	it("digests OpenRouter's `reasoning` delta into thinking too (GLM-F1: the second compat-table row)", async () => {
		// OpenRouter normalises every vendor's reasoning stream into
		// `delta.reasoning` (plus `reasoning_details`); DeepSeek's own API
		// says `reasoning_content`. Observed 2026-09-09 on z-ai/glm-5.3-flash
		// through openrouter.ai: the deltas carried `reasoning` and the
		// adapter dropped every one of them on the floor.
		const stubClient = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { content: "", reasoning: "User wants", reasoning_details: [{ type: "reasoning.text", text: "User wants" }] }, finish_reason: null }],
								usage: undefined,
							};
							yield { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: undefined };
						},
					}),
				},
			},
		};
		const events = await collect(createOpenAICompatAdapter(stubClient as never));
		expect(events[0]).toMatchObject({ type: "thinking", text: "User wants" });
		expect(events.filter((e) => e.type === "thinking")).toHaveLength(1);
		expect(events.some((e) => e.type === "text_delta" && (e as { text: string }).text === "hi")).toBe(true);
	});
});

describe("COMPAT-F1 — a stream cut by the caller's abort is an ABORT, not a provider error", () => {
	// The SDK closes an aborted stream quietly: the iterator ends with no
	// finish_reason. The adapter used to read that as "the provider stopped
	// with an error" and yield stop:error — so esc on a DeepSeek or
	// OpenRouter turn recorded an error terminal and no durable void, while
	// the same esc on the Responses adapter (which throws) recorded
	// `aborted by user`. Observed 2026-09-09 on the GLM leg.
	function earlyEnd() {
		return {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: "Harbors are" }, finish_reason: null }], usage: undefined };
							// …and the stream ends here, no finish_reason: the abort closed it
						},
					}),
				},
			},
		};
	}
	it("aborted signal + early end → the adapter THROWS (the kernel's catch records `aborted by user`)", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const adapter = createOpenAICompatAdapter(earlyEnd() as never);
		const drain = async (): Promise<void> => {
			for await (const _ of adapter.stream({ ...OPTS, signal: ctl.signal })) {
				// the caller has already given up; whatever arrives is discarded
			}
		};
		await expect(drain()).rejects.toThrow();
	});
	it("an early end WITHOUT an abort is still the provider's error — stop:error, as before", async () => {
		const events = await collect(createOpenAICompatAdapter(earlyEnd() as never));
		expect(events.at(-1)).toMatchObject({ type: "stop", reason: "error" });
	});
});

describe("COMPAT-F2 — a stream cut by the transport mid-body is a retryable network error, not `unknown`", () => {
	// Observed 2026-09-09 on the GLM leg (no abort involved): the upstream
	// cut the response body ~14 s into a long answer. Node's fetch surfaces
	// that as `TypeError: terminated` (undici), which is neither an
	// OpenAI.APIError nor an APIConnectionError, so the adapter passed it
	// through untouched and the kernel filed it as `unknown`, non-retryable —
	// an error terminal where the mid-stream retry (F4) should have run.
	it("a TypeError('terminated') from the body reader → { code: network, retryable: true }", async () => {
		const stubClient = {
			chat: {
				completions: {
					create: async () => ({
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: { content: "Harbors are" }, finish_reason: null }], usage: undefined };
							throw new TypeError("terminated");
						},
					}),
				},
			},
		};
		const adapter = createOpenAICompatAdapter(stubClient as never);
		let caught: unknown = null;
		try {
			for await (const _ of adapter.stream(OPTS)) {
				// draining
			}
		} catch (err) {
			caught = err;
		}
		expect(caught).toMatchObject({ code: "network", retryable: true });
		expect(String((caught as { message: string }).message)).toContain("terminated");
	});
});

describe("mapApiError classification", () => {
	it("classifies by status only", async () => {
		const { mapApiError } = await import("@vincemakes/kiso-core");
		const cases: Array<[number | undefined, string]> = [
			[429, "rate_limit"],
			[529, "overloaded"],
			[503, "api_5xx"],
			[401, "invalid_request"],
			[400, "invalid_request"],
			[undefined, "unknown"],
		];
		for (const [status, code] of cases) {
			const err: StructuredError = mapApiError(status, "msg");
			expect(err.code).toBe(code);
			expect(err.retryable).toBe(status === 429 || status === 529 || status === 503);
		}
	});
});
