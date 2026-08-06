/**
 * OpenAI-compat adapter — built on the official SDK, covering OpenAI and the
 * compat family (GLM, Kimi, DeepSeek, OpenRouter, ...) via base_url swap.
 *
 * Dialect digestion happens HERE, never in the union (ADR-0003):
 * - reasoning_content / reasoning deltas (DeepSeek, GLM, Qwen) → `thinking`;
 * - streaming tool calls: arguments arrive as fragmented deltas, keyed by
 *   index; the first delta of an index carries the call id + name. The
 *   adapter accumulates each call and emits `tool_call_end` with the parsed
 *   JSON (or null — never a silent repair) at the end of the stream.
 *
 * Invariants: at least one `usage` precedes the final `stop` when the
 * provider reports usage (not all compat providers do); `stop` reason maps
 * from finish_reason.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import type { AdapterEvent, Event, StopReason } from "@vincemakes/kiso-core";
import type { AssistantBlock, ContentBlock, Message } from "@vincemakes/kiso-core";
import type { ToolSpec } from "@vincemakes/kiso-core";
import { mapApiError } from "@vincemakes/kiso-core";

interface PendingToolCall {
	readonly index: number;
	/**
	 * 六: the call's id is only adopted once the provider actually sent it.
	 * The fallback (`call_<index>`) is reserved for calls whose id NEVER
	 * arrives — then no start/delta was ever emitted under that name, so the
	 * identity stays consistent from start to end.
	 */
	id: string;
	name: string;
	json: string;
	emittedStart: boolean;
	/** Argument deltas that arrived BEFORE the id: buffered, flushed under
	 *  the REAL id once it arrives (identity consistency, 六). */
	pendingDeltas: string[];
}

/** Config accepted by the high-level factory (七: the provider owns its SDK). */
export interface OpenAICompatProviderConfig {
	readonly apiKey?: string;
	readonly baseUrl?: string;
}

/**
 * High-level factory (七): builds the adapter FROM CONFIG, owning the SDK
 * inside this package. Consumers (and the runtime's lazy provider path)
 * import ONLY @vincemakes/kiso-provider-openai — the SDK stays a private dependency
 * of this package, so nested installs resolve it next to here, never
 * through a hoisted root.
 */
export function createOpenAICompatProvider(config: OpenAICompatProviderConfig = {}): Adapter {
	const client = new OpenAI({
		...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
		...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
	});
	return createOpenAICompatAdapter(client);
}

export function createOpenAICompatAdapter(client: OpenAI): Adapter {
	return {
		async *stream(options: StreamOptions): AsyncIterable<AdapterEvent> {
			// The explicit streaming params type keeps the `stream: true`
			// literal overload — a widened `stream: boolean` would type the
			// create() call as the NON-streaming variant (TS2504).
			const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
				model: options.model,
				messages: toOpenAIMessages(options.messages, options.systemPrompt),
				stream: true,
				// D5: request real streaming usage — without this the
				// provider never sends a usage chunk and we would
				// report known:false forever.
				stream_options: { include_usage: true },
				...(options.tools?.length ? { tools: options.tools.map(toOpenAITool) } : {}),
				...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
				...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
			};
			maybeDumpRequest(body);
			// Area 6: the stream CREATION is inside the error normalization —
			// a 429/5xx/connection failure before the first byte is a mapped,
			// retryable StructuredError, so the loop's pre-stream retry works.
			let stream;
			try {
				stream = await client.chat.completions.create(
					body,
					// Phase B: cancellation reaches the SDK; the system prompt is a
					// first-class message, not a dropped option.
					options.signal !== undefined ? { signal: options.signal as AbortSignal } : undefined,
				);
			} catch (err) {
				throw toOpenAIError(err);
			}

			const pending = new Map<number, PendingToolCall>();
			let finishReason: string | null = null;
			let usageSent = false;
			let stopReason: StopReason = "end_turn";
			// P1-10: the FIRST finish reason is FINAL — later content and
			// finish reasons are ignored (a provider that emits text after a
			// content_filter must not be reported as a clean end_turn). The
			// usage chunk is still accepted after the finish: some compat
			// providers send it late.
			let finishSeen = false;

			try {
				for await (const chunk of stream) {
					if (finishSeen) {
						if (chunk.usage) {
							usageSent = true;
							const details = (chunk.usage as {
								prompt_tokens_details?: { cached_tokens?: number };
							}).prompt_tokens_details;
							yield {
								seq: 0,
								type: "usage",
								inputTokens: chunk.usage.prompt_tokens ?? null,
								outputTokens: chunk.usage.completion_tokens ?? null,
								cacheRead: details?.cached_tokens ?? null,
								cacheWrite: null,
								known: true,
							};
						}
						continue; // content and finish reasons after the first finish: ignored
					}
					// Reasoning dialect → thinking (digested here, not in the union).
					const reasoning = (chunk.choices?.[0]?.delta as { reasoning_content?: string } | undefined)
						?.reasoning_content;
					if (reasoning) {
						yield { seq: 0, type: "thinking", text: reasoning };
					}

					const delta = chunk.choices?.[0]?.delta;
					if (delta?.content) {
						yield { seq: 0, type: "text_delta", text: delta.content };
					}

					for (const tc of delta?.tool_calls ?? []) {
						const buffered = pending.get(tc.index);
						if (!buffered) {
							// 六: no fallback id is adopted yet — the id must
							// arrive from the provider to become the identity.
							pending.set(tc.index, {
								index: tc.index,
								id: "",
								name: tc.function?.name ?? "",
								json: "",
								emittedStart: false,
								pendingDeltas: [],
							});
						}
						const call = pending.get(tc.index)!;
						// Some compat providers stream the name/id in a LATER
						// delta; update on every delta so tool_call_end never
						// carries an empty name (review finding 10).
						if (tc.function?.name) call.name = tc.function.name;
						if (tc.id) {
							// 九: the FIRST non-empty id is the call's identity,
							// forever. A DIFFERENT id later is a protocol
							// violation — a structured error, never a silent
							// switch (start/delta/end must share one identity).
							if (call.id !== "" && tc.id !== call.id) {
								throw {
									code: "invalid_request",
									retryable: false,
									message: `tool call ${call.index} changed id mid-stream: ${call.id} → ${tc.id}`,
								};
							}
							call.id = tc.id;
							// The identity is now known: emit the start, then
							// flush the argument deltas that arrived before it
							// under the SAME id (六: start → delta → end all
							// share one identity, never the fallback).
							if (!call.emittedStart) {
								call.emittedStart = true;
								yield {
									seq: 0,
									type: "tool_call_start",
									callId: call.id,
									name: call.name,
								};
								for (const d of call.pendingDeltas) {
									yield {
										seq: 0,
										type: "tool_call_input_delta",
										callId: call.id,
										inputJsonDelta: d,
									};
								}
								call.pendingDeltas = [];
							}
						}
						if (tc.function?.arguments) {
							call.json += tc.function.arguments;
							if (call.emittedStart) {
								yield {
									seq: 0,
									type: "tool_call_input_delta",
									callId: call.id,
									inputJsonDelta: tc.function.arguments,
								};
							} else {
								call.pendingDeltas.push(tc.function.arguments);
							}
						}
					}

					if (chunk.usage) {
						usageSent = true;
						// 六: REAL cached-token data is read from the provider's
						// prompt_tokens_details — an absent value is null, NEVER
						// faked as a zero-cache turn. OpenAI does not report a
						// cache write; null is the honest answer.
						const details = (chunk.usage as {
							prompt_tokens_details?: { cached_tokens?: number };
						}).prompt_tokens_details;
						yield {
							seq: 0,
							type: "usage",
							inputTokens: chunk.usage.prompt_tokens ?? null,
							outputTokens: chunk.usage.completion_tokens ?? null,
							cacheRead: details?.cached_tokens ?? null,
							cacheWrite: null,
							known: true,
						};
					}

					const fr = chunk.choices?.[0]?.finish_reason;
					if (fr) {
						// P1-10: the FIRST finish is the terminal one.
						finishReason = fr;
						stopReason = mapFinishReason(fr);
						finishSeen = true;
					}
				}
			} catch (err) {
				throw toOpenAIError(err);
			}

			// Close out any streamed tool calls.
			for (const call of [...pending.values()].sort((a, b) => a.index - b.index)) {
				let input: Record<string, unknown> | null = null;
				try {
					input = call.json ? JSON.parse(call.json) : {};
				} catch {
					input = null; // never a silent repair
				}
				// 六: a call whose id NEVER arrived adopts the index fallback
				// here — no start/delta was emitted under any other identity,
				// so this end is the call's first and only identity.
				yield {
					seq: 0,
					type: "tool_call_end",
					callId: call.id || `call_${call.index}`,
					name: call.name,
					input,
				};
			}

			if (!usageSent) {
				// Area 6: no usage reported is expressed as UNKNOWN — nulls
				// and known:false — never faked as a zero-cost turn.
				yield { seq: 0, type: "usage", inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null, known: false };
			}
			// Area 6 hardening (review finding 4): a stream that ended with
			// NO finish_reason is a TRUNCATED turn — the stop is an explicit
			// error, never a default end_turn/completed.
			yield { seq: 0, type: "stop", reason: finishReason === null ? "error" : stopReason };
		},
	};
}

// ── Request dump (debug tool) ───────────────────────────────────────────

let dumpSeq = 0;

/**
 * KISO_DUMP_REQUESTS=<dir> — DEBUG TOOL: writes the FULL request body (the
 * exact JSON the SDK will send) to `<dir>/req-<pid>-<n>.json` before it is
 * sent, numbered per request in process order. Built for the fresh-mystery
 * diagnosis (byte-diff consecutive requests' common prefix); kept as a
 * permanent debug sink. ⚠ The bodies are REAL conversation data (the model
 * may have seen repo contents) — never share a dump dir. A dump failure
 * never breaks the request.
 */
function maybeDumpRequest(body: unknown): void {
	const dir = process.env.KISO_DUMP_REQUESTS;
	if (dir === undefined || dir === "") return;
	dumpSeq += 1;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `req-${process.pid}-${dumpSeq}.json`), JSON.stringify(body));
	} catch {
		// debug tool: silent on failure
	}
}

// ── Mapping helpers ────────────────────────────────────────────────────

/**
 * Exhaustive over the SDK's CLOSED finish_reason union (Area 6): a new SDK
 * enum is a compile error here; `content_filter` and `function_call` are
 * explicit non-completions, never degraded into `end_turn`.
 */
function mapFinishReason(reason: OpenAI.Chat.ChatCompletionChunk.Choice["finish_reason"]): StopReason {
	switch (reason) {
		case "stop":
			return "end_turn";
		case "length":
			return "max_tokens";
		case "tool_calls":
			return "tool_use";
		case "function_call":
			return "function_call";
		case "content_filter":
			return "content_filter";
		case null:
			// D3: a chunk with NO finish reason is not a stop — the caller
			// decides; the trailing stop is only emitted when one was seen.
			return "error";
		default: {
			// D3: an unknown finish reason is an error, never completed.
			return "error";
		}
	}
}

function toOpenAIContent(
	content: string | readonly ContentBlock[],
): OpenAI.Chat.ChatCompletionContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content.map((block) =>
		block.type === "text"
			? ({ type: "text", text: block.text } as const)
			: ({
					type: "image_url",
					// 六: a base64 block becomes a REAL data URL —
					// `data:<media>;base64,<data>` — never an empty string URL.
					// URL-sourced blocks pass the provider URL through.
					image_url: {
						url:
							block.sourceType === "base64"
								? `data:${block.mediaType ?? "image/png"};base64,${block.data ?? ""}`
								: (block.url ?? ""),
					},
				} as const),
	);
}

/**
 * 六: OpenAI tool results accept TEXT ONLY — an image block is converted to
 * an explicit, honest text note (what kind of image was omitted and why),
 * never silently dropped.
 */
function toOpenAIToolResultContent(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content
		.map((b) =>
			b.type === "text"
				? b.text
				: `[image omitted — OpenAI tool results accept text only: ${b.sourceType === "base64" ? `${b.mediaType ?? "image"} (${b.data?.length ?? 0} base64 chars)` : `url ${b.url ?? ""}`}]`,
		)
		.join("");
}

function toOpenAIMessages(
	messages: readonly Message[],
	systemPrompt?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
	// The OpenAI API takes the system prompt as a system-role message; compat
	// providers (GLM/Kimi/DeepSeek/OpenRouter) follow the same shape. It was
	// silently dropped before Phase B.
	if (systemPrompt !== undefined) {
		out.push({ role: "system", content: systemPrompt });
	}
	// 合并轮 (0.1.23) C7 修订: `reasoning_content` 的存在性由整个投影的
	// 单调状态决定 — 投影里存在任一 reasoning → 每条 assistant 消息都
	// 携带(自身 reasoning,或 "")；否则一条都不带。理由: D 区请求级
	// 字节稳定。旧实现按"当前轮"判定(手感批 C7),轮边界一过,旧轮
	// assistant 消息的字段被剥掉,序列化被改写 — 请求 N 与 N+1 的公共
	// 前缀断在旧消息处,provider 前缀缓存每轮边界断一次(fresh 之谜
	// 实证: 14 请求的会话里两次缓存断点都在轮边界;修复后同会话 0 断
	// 点、逐请求 cached 82-98%)。单调性保证存在性在会话内只翻转一次
	// (首个 thinking 出现时,通常在首轮 — 此前几乎没有旧 assistant
	// 消息),之后从生到死不翻转;真 OpenAI 永不产生 reasoning → 字段
	// 永不出现,其请求路径与旧行为逐字节相同。带 reasoning 的旧轮消息
	// 回传其推理是 DeepSeek 官方推荐的缓存稳定形态;旧内容命中前缀
	// 缓存只按 0.1× 计费,"回传是 token 浪费"的前提在缓存经济下不成立。
	// "" 字段在旧轮同样被接受(真 API 验证: 200 + 2560 cached tokens)。
	const hasReasoning = messages.some((m) => m.role === "assistant" && m.reasoning !== undefined);
	for (const msg of messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: toOpenAIContent(msg.content) });
		} else if (msg.role === "assistant") {
			// OpenAI-compat APIs reject an EMPTY tool_calls array with 400
			// ("expected an array with minimum length 1") — when the turn
			// made no tool calls, the field is omitted entirely.
			const toolCalls = msg.blocks
				.filter((b) => b.type === "tool_use")
				.map((b) => {
					const t = b as { callId: string; name: string; input: unknown };
					return {
						id: t.callId,
						type: "function" as const,
						function: { name: t.name, arguments: JSON.stringify(t.input) },
					};
				});
			out.push({
				role: "assistant",
				content: msg.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""),
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
				// DeepSeek extension field — absent from the SDK's param type,
				// added via spread so the literal stays assignable (the union
				// type carries the extra key). Presence follows hasReasoning
				// (the monotone rule above — the field never flips mid-history).
				...(hasReasoning ? { reasoning_content: msg.reasoning ?? "" } : {}),
			});
		} else {
			// tool messages accept text only — images are converted to an
			// EXPLICIT text note (toOpenAIToolResultContent), never dropped
			// (六).
			out.push({
				role: "tool",
				tool_call_id: msg.callId,
				content: toOpenAIToolResultContent(msg.content),
			});
		}
	}
	return out;
}

function toOpenAITool(tool: ToolSpec): OpenAI.Chat.ChatCompletionTool {
	return {
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	};
}

function toOpenAIError(err: unknown): unknown {
	// D4: connection-level failures are recognized, not lumped into unknown.
	if (err instanceof OpenAI.APIConnectionTimeoutError) {
		return { code: "timeout", retryable: true, message: err.message };
	}
	if (err instanceof OpenAI.APIConnectionError) {
		return { code: "network", retryable: true, message: err.message };
	}
	if (err instanceof OpenAI.APIError) {
		return mapApiError(err.status, err.message);
	}
	return err;
}

export type { ChatCompletionChunk };
