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

import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Adapter, StreamOptions } from "@kiso/core";
import type { Event, StopReason } from "@kiso/core";
import type { AssistantBlock, ContentBlock, Message } from "@kiso/core";
import type { ToolSpec } from "@kiso/core";
import { mapApiError } from "@kiso/core";

interface PendingToolCall {
	readonly index: number;
	id: string;
	name: string;
	json: string;
	emittedStart: boolean;
}

export function createOpenAICompatAdapter(client: OpenAI): Adapter {
	return {
		async *stream(options: StreamOptions): AsyncIterable<Event> {
			const stream = await client.chat.completions.create(
				{
					model: options.model,
					messages: toOpenAIMessages(options.messages, options.systemPrompt),
					stream: true,
					...(options.tools?.length ? { tools: options.tools.map(toOpenAITool) } : {}),
					...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
					...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
				},
				// Phase B: cancellation reaches the SDK; the system prompt is a
				// first-class message, not a dropped option.
				options.signal !== undefined ? { signal: options.signal as AbortSignal } : undefined,
			);

			const pending = new Map<number, PendingToolCall>();
			let finishReason: string | null = null;
			let usageSent = false;
			let stopReason: StopReason = "end_turn";

			try {
				for await (const chunk of stream) {
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
							const id = tc.id ?? `call_${tc.index}`;
							pending.set(tc.index, {
								index: tc.index,
								id,
								name: tc.function?.name ?? "",
								json: "",
								emittedStart: false,
							});
						}
						const call = pending.get(tc.index)!;
						if (!call.emittedStart) {
							call.emittedStart = true;
							call.name = tc.function?.name ?? call.name;
							call.id = tc.id ?? call.id;
							yield {
								seq: 0,
								type: "tool_call_start",
								callId: call.id,
								name: call.name,
							};
						}
						if (tc.function?.arguments) {
							call.json += tc.function.arguments;
							yield {
								seq: 0,
								type: "tool_call_input_delta",
								callId: call.id,
								inputJsonDelta: tc.function.arguments,
							};
						}
					}

					if (chunk.usage) {
						usageSent = true;
						yield {
							seq: 0,
							type: "usage",
							inputTokens: chunk.usage.prompt_tokens ?? 0,
							outputTokens: chunk.usage.completion_tokens ?? 0,
							cacheRead: 0,
							cacheWrite: 0,
						};
					}

					const fr = chunk.choices?.[0]?.finish_reason;
					if (fr) {
						finishReason = fr;
						stopReason = mapFinishReason(fr);
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
				yield { seq: 0, type: "tool_call_end", callId: call.id, name: call.name, input };
			}

			if (!usageSent) {
				yield { seq: 0, type: "usage", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
			}
			yield { seq: 0, type: "stop", reason: stopReason };
		},
	};
}

// ── Mapping helpers ────────────────────────────────────────────────────

function mapFinishReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "tool_calls":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "stop":
		default:
			return "end_turn";
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
					image_url: { url: block.url ?? "" },
				} as const),
	);
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
	for (const msg of messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: toOpenAIContent(msg.content) });
		} else if (msg.role === "assistant") {
			out.push({
				role: "assistant",
				content: msg.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""),
				tool_calls: msg.blocks
					.filter((b) => b.type === "tool_use")
					.map((b) => {
						const t = b as { callId: string; name: string; input: unknown };
						return {
							id: t.callId,
							type: "function" as const,
							function: { name: t.name, arguments: JSON.stringify(t.input) },
						};
					}),
			});
		} else {
			// tool messages accept text only — images fall back to their
			// text representation (or are dropped).
			out.push({
				role: "tool",
				tool_call_id: msg.callId,
				content:
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b) => b.type === "text")
								.map((b) => (b as { text: string }).text)
								.join(""),
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
	if (err instanceof OpenAI.APIError) {
		return mapApiError(err.status, err.message);
	}
	return err;
}

export type { ChatCompletionChunk };
