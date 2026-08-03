/**
 * 六 — adapter wire-shape honesty: what actually leaves the adapter.
 *
 * 1. OpenAI base64 image blocks become REAL data URLs — never an empty
 *    string URL.
 * 2. OpenAI tool-result images are converted to an EXPLICIT text note —
 *    never silently dropped.
 * 3. A tool call whose id arrives late keeps ONE identity from start
 *    through delta to end; a call whose id never arrives gets the index
 *    fallback exactly once, at its end.
 * 4. OpenAI cached tokens are read from prompt_tokens_details — an absent
 *    value is null, never faked as 0.
 * 5. Anthropic emits an honest usage (known:false, nulls) before EVERY
 *    stop — including a degenerate message_stop with no delta.
 */

import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Adapter, StreamOptions } from "@kiso/core";
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import { createOpenAICompatAdapter } from "@kiso/provider-openai";

async function drain(adapter: Adapter, opts: StreamOptions = OPTS): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const ev of adapter.stream(opts)) events.push(ev);
	return events;
}

function fakeOpenAI(params: { chunks?: unknown[]; onCreate?: (p: unknown) => void }) {
	return {
		chat: {
			completions: {
				create: async (p: unknown) => {
					params.onCreate?.(p);
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

const OPTS: StreamOptions = { model: "m", messages: [{ role: "user", content: "hi" }] };

describe("六: OpenAI images", () => {
	it("a base64 image becomes a REAL data URL — never an empty string URL", async () => {
		let seen: unknown;
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [CHUNK("stop")],
				onCreate: (p) => {
					seen = p;
				},
			}),
		);
		await drain(adapter, {
			model: "m",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this" },
						{ type: "image", sourceType: "base64", data: "cG5nZGF0YQ==", mediaType: "image/png" },
					],
				},
			],
		});
		const messages = (seen as { messages: { content: { image_url?: { url?: string } }[] }[] }).messages;
		const urls = messages[0]!.content.filter((c) => c.image_url !== undefined).map((c) => c.image_url!.url);
		expect(urls).toEqual(["data:image/png;base64,cG5nZGF0YQ=="]);
		expect(urls.some((u) => u === "")).toBe(false);
	});

	it("a URL image passes the provider URL through", async () => {
		let seen: unknown;
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [CHUNK("stop")],
				onCreate: (p) => {
					seen = p;
				},
			}),
		);
		await drain(adapter, {
			model: "m",
			messages: [
				{
					role: "user",
					content: [{ type: "image", sourceType: "url", url: "https://x/y.png" }],
				},
			],
		});
		const messages = (seen as { messages: { content: { image_url?: { url?: string } }[] }[] }).messages;
		const urls = messages[0]!.content.filter((c) => c.image_url !== undefined).map((c) => c.image_url!.url);
		expect(urls).toEqual(["https://x/y.png"]);
	});

	it("a tool-result image becomes an EXPLICIT text note — never silently dropped", async () => {
		let seen: unknown;
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [CHUNK("stop")],
				onCreate: (p) => {
					seen = p;
				},
			}),
		);
		await drain(adapter, {
			model: "m",
			messages: [
				{ role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "render", input: {} }] },
				{
					role: "tool",
					callId: "c1",
					isError: false,
					content: [
						{ type: "text", text: "chart:" },
						{ type: "image", sourceType: "base64", data: "cG5n", mediaType: "image/png" },
					],
				},
			],
		});
		const messages = (seen as { messages: { role: string; content: string }[] }).messages;
		const tool = messages.find((m) => m.role === "tool");
		expect(tool?.content).toContain("chart:");
		expect(tool?.content).toContain("[image omitted — OpenAI tool results accept text only");
		expect(tool?.content).toContain("image/png");
	});
});

describe("六: late tool-call id keeps one identity", () => {
	it("start/delta/end all carry the REAL id when it arrives late", async () => {
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [
					// First delta: arguments but NO id (compat behavior).
					CHUNK(null, { tool_calls: [{ index: 0, id: null, type: "function", function: { name: "web_search", arguments: '{"q":' } }] }),
					// Second delta: the id finally arrives, with more args.
					CHUNK(null, { tool_calls: [{ index: 0, id: "call_real_1", type: "function", function: { name: "web_search", arguments: '"kiso"}' } }] }),
					CHUNK("tool_calls"),
				],
			}),
		);
		const events = (await drain(adapter)) as { type: string; callId?: string }[];
		const start = events.find((e) => e.type === "tool_call_start");
		const deltas = events.filter((e) => e.type === "tool_call_input_delta");
		const end = events.find((e) => e.type === "tool_call_end");
		// ONE identity everywhere — never the index fallback.
		expect(start?.callId).toBe("call_real_1");
		expect(deltas.map((d) => d.callId)).toEqual(["call_real_1", "call_real_1"]);
		expect(end?.callId).toBe("call_real_1");
		// The buffered delta is NOT lost — the end parses the full JSON.
		const input = (end as unknown as { input: Record<string, unknown> }).input;
		expect(input).toEqual({ q: "kiso" });
	});

	it("a call whose id NEVER arrives adopts the fallback exactly once, at its end", async () => {
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [
					CHUNK(null, { tool_calls: [{ index: 0, id: null, type: "function", function: { name: "web_search", arguments: "{}" } }] }),
					CHUNK("tool_calls"),
				],
			}),
		);
		const events = (await drain(adapter)) as { type: string; callId?: string }[];
		// No start/delta was ever emitted under a fallback identity.
		expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
		expect(events.some((e) => e.type === "tool_call_input_delta")).toBe(false);
		const end = events.find((e) => e.type === "tool_call_end");
		expect(end?.callId).toBe("call_0");
	});
});

describe("六: real OpenAI cached tokens", () => {
	it("cacheRead reads prompt_tokens_details.cached_tokens — never faked as 0", async () => {
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [
					{
						id: "x",
						object: "chat.completion.chunk",
						created: 0,
						model: "m",
						choices: [],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 80 },
						},
					},
					CHUNK("stop"),
				],
			}),
		);
		const events = (await drain(adapter)) as { type: string; cacheRead?: number | null; known?: boolean }[];
		const usage = events.find((e) => e.type === "usage");
		expect(usage).toMatchObject({ cacheRead: 80, inputTokens: 100, outputTokens: 5, known: true });
	});

	it("an absent cached-token report is null — not 0, not a lie", async () => {
		const adapter = createOpenAICompatAdapter(
			fakeOpenAI({
				chunks: [
					{
						id: "x",
						object: "chat.completion.chunk",
						created: 0,
						model: "m",
						choices: [],
						usage: { prompt_tokens: 10, completion_tokens: 2 },
					},
					CHUNK("stop"),
				],
			}),
		);
		const events = (await drain(adapter)) as { type: string; cacheRead?: number | null }[];
		const usage = events.find((e) => e.type === "usage");
		expect(usage?.cacheRead).toBeNull();
	});
});

describe("六: every Anthropic stop path is preceded by an honest usage", () => {
	it("a degenerate message_stop with no delta yields known:false usage BEFORE the error stop", async () => {
		const events = await drain(
			createAnthropicAdapter(
				{
					messages: {
						stream: () => ({
							async *[Symbol.asyncIterator]() {
								yield { type: "message_stop" }; // no delta, no usage
							},
						}),
					},
				} as unknown as Anthropic,
			),
		);
		const usage = events.find((e) => (e as { type?: string }).type === "usage") as {
			known?: boolean;
			inputTokens?: number | null;
		};
		expect(usage).toBeDefined();
		expect(usage.known).toBe(false);
		expect(usage.inputTokens).toBeNull();
		const stop = events.at(-1) as { type?: string; reason?: string };
		expect(stop).toMatchObject({ type: "stop", reason: "error" });
		// The usage strictly precedes the stop.
		expect(events.indexOf(usage)).toBeLessThan(events.indexOf(stop));
	});
});
