/**
 * Anthropic adapter — built on the official SDK, mapping its wire events to
 * the kiso event union. The kernel never sees Anthropic types (ADR-0001);
 * everything provider-private (cache_control, thinking deltas) is digested
 * here.
 *
 * Invariants this adapter upholds:
 * - at least one `usage` precedes the final `stop` (ADR-0003);
 * - `tool_call_end.input` is the parsed JSON or null — never a partial.
 *
 * Tool calls: the SDK streams tool_use as content blocks
 * (content_block_start with the call id, input_json_delta, then stop).
 * The id in the start block IS the callId the kernel echoes back.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { Adapter, StreamOptions } from "@kiso/core";
import type { Event, StopReason } from "@kiso/core";
import type { AssistantBlock, ContentBlock, Message, ToolSpec } from "@kiso/core";
import { mapApiError } from "@kiso/core";

export function createAnthropicAdapter(client: Anthropic): Adapter {
	return {
		async *stream(options: StreamOptions): AsyncIterable<Event> {
			const stream = client.messages.stream({
				model: options.model,
				...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
				max_tokens: options.maxTokens ?? 4096,
				messages: toAnthropicMessages(options.messages),
				...(options.tools?.length ? { tools: toAnthropicTools(options.tools) } : {}),
				...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
			});

			let inputTokens = 0;
			let stopReason: StopReason = "end_turn";
			const toolBuffer = new Map<number, { id: string; name: string; json: string }>();

			try {
				for await (const event of stream) {
					switch (event.type) {
						case "message_start":
							inputTokens = event.message.usage.input_tokens ?? 0;
							break;
						case "content_block_start": {
							const block = event.content_block;
							if (block.type === "text") {
								yield { seq: 0, type: "text_start" };
							} else if (block.type === "tool_use") {
								toolBuffer.set(event.index, { id: block.id, name: block.name, json: "" });
								yield {
									seq: 0,
									type: "tool_call_start",
									callId: block.id,
									name: block.name,
								};
							}
							break;
						}
						case "content_block_delta": {
							const delta = event.delta;
							if (delta.type === "text_delta") {
								yield { seq: 0, type: "text_delta", text: delta.text };
							} else if (delta.type === "input_json_delta") {
								const buffered = toolBuffer.get(event.index);
								if (buffered) {
									buffered.json += delta.partial_json;
									yield {
										seq: 0,
										type: "tool_call_input_delta",
										callId: buffered.id,
										inputJsonDelta: delta.partial_json,
									};
								}
							} else if (delta.type === "thinking_delta") {
								yield { seq: 0, type: "thinking", text: delta.thinking };
							}
							break;
						}
						case "content_block_stop": {
							const buffered = toolBuffer.get(event.index);
							if (buffered) {
								toolBuffer.delete(event.index);
								let input: Record<string, unknown> | null = null;
								try {
									input = JSON.parse(buffered.json || "{}");
								} catch {
									input = null; // never a silent repair
								}
								yield {
									seq: 0,
									type: "tool_call_end",
									callId: buffered.id,
									name: buffered.name,
									input,
								};
							}
							// Text blocks end implicitly: the next TextStart (or
							// the terminal) closes the previous block (ADR-0003).
							break;
						}
						case "message_delta":
							stopReason = mapStopReason(event.delta.stop_reason);
							if (event.usage?.output_tokens) {
								yield {
									seq: 0,
									type: "usage",
									inputTokens,
									outputTokens: event.usage.output_tokens,
									cacheRead: 0,
									cacheWrite: 0,
								};
							}
							break;
						case "message_stop":
							yield { seq: 0, type: "stop", reason: stopReason };
							break;
					}
				}
			} catch (err) {
				throw toAnthropicError(err);
			}
		},
	};
}

// ── Mapping helpers ────────────────────────────────────────────────────

function mapStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "tool_use":
			return "tool_use";
		case "max_tokens":
			return "max_tokens";
		case "stop_sequence":
			return "stop_sequence";
		case "end_turn":
		case "pause_turn":
		default:
			return "end_turn";
	}
}

function toAnthropicContent(
	content: string | readonly ContentBlock[],
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content.map(
		(block): Anthropic.TextBlockParam | Anthropic.ImageBlockParam => {
		if (block.type === "text") return { type: "text", text: block.text };
		return {
			type: "image",
			source:
				block.sourceType === "url"
					? { type: "url", url: block.url ?? "" }
					: { type: "base64", media_type: block.mediaType ?? "image/png", data: block.data ?? "" },
		};
	});
}

function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
	const out: Anthropic.MessageParam[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: toAnthropicContent(msg.content) });
		} else if (msg.role === "assistant") {
			out.push({
				role: "assistant",
				content: msg.blocks.map(toAnthropicBlock),
			});
		} else {
			// tool result: Anthropic nests them as a user message.
			out.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: msg.callId,
						content: toAnthropicContent(msg.content),
						is_error: msg.isError,
					},
				],
			});
		}
	}
	return out;
}

function toAnthropicBlock(block: AssistantBlock): Anthropic.ContentBlockParam {
	return block.type === "text"
		? { type: "text", text: block.text }
		: { type: "tool_use", id: block.callId, name: block.name, input: block.input };
}

function toAnthropicTools(tools: readonly ToolSpec[]): Anthropic.Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
	}));
}

function toAnthropicError(err: unknown): unknown {
	if (err instanceof Anthropic.APIError) {
		return mapApiError(err.status, err.message);
	}
	return err;
}
