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
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import type { AdapterEvent, Event, StopReason } from "@vincemakes/kiso-core";
import type { AssistantBlock, ContentBlock, Message, ToolSpec } from "@vincemakes/kiso-core";
import { mapApiError } from "@vincemakes/kiso-core";

/** Config accepted by the high-level factory (round 7: the provider owns its SDK). */
export interface AnthropicProviderConfig {
	readonly apiKey?: string;
	readonly baseUrl?: string;
}

/**
 * High-level factory (round 7): builds the adapter FROM CONFIG, owning the SDK
 * inside this package. Consumers (and the runtime's lazy provider path)
 * import ONLY @vincemakes/kiso-provider-anthropic — the SDK stays a private
 * dependency of this package, so nested installs resolve it next to here,
 * never through a hoisted root.
 */
export function createAnthropicProvider(config: AnthropicProviderConfig = {}): Adapter {
	const client = new Anthropic({
		...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
		...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
	});
	return createAnthropicAdapter(client);
}

export function createAnthropicAdapter(client: Anthropic): Adapter {
	return {
		async *stream(options: StreamOptions): AsyncIterable<AdapterEvent> {
			// D4: the stream CREATION is inside the error normalization —
			// connection/timeout/5xx failures before the first byte are
			// mapped, retryable StructuredErrors.
			let stream;
			try {
				stream = client.messages.stream(
					{
						model: options.model,
						...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
						max_tokens: options.maxTokens ?? 4096,
						messages: toAnthropicMessages(options.messages),
						...(options.tools?.length ? { tools: toAnthropicTools(options.tools) } : {}),
						...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
					},
					// Phase B: cancellation reaches the SDK, which aborts the fetch.
					options.signal !== undefined ? { signal: options.signal as AbortSignal } : undefined,
				);
			} catch (err) {
				throw toAnthropicError(err);
			}

			let inputTokens: number | null = null;
			let outputTokens: number | null = null;
			let cacheRead: number | null = null;
			let cacheWrite: number | null = null;
			// round 9: "usage SEEN" (data arrived) is distinct from "usage YIELDED"
			// (an event left the adapter). message_start may report usage with
			// no message_delta ever following — the stop must then still be
			// preceded by an honest usage event built from that data.
			let usageSeen = false;
			let usageYielded = false;
			let stopReasonSeen = false;
			let stopReason: StopReason = "end_turn";
			const toolBuffer = new Map<number, { id: string; name: string; json: string }>();

			try {
				for await (const event of stream) {
					switch (event.type) {
						case "message_start":
							inputTokens = event.message.usage.input_tokens ?? null;
							// D5: cache counters are READ from the SDK — never
							// faked as zero.
							cacheRead = event.message.usage.cache_read_input_tokens ?? null;
							cacheWrite = event.message.usage.cache_creation_input_tokens ?? null;
							if (event.message.usage.input_tokens !== undefined) usageSeen = true;
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
							stopReasonSeen = true;
							stopReason = mapStopReason((event.delta.stop_reason ?? "error") as Anthropic.Messages.StopReason);
							outputTokens = event.usage?.output_tokens ?? null;
							if (event.usage?.output_tokens !== undefined) usageSeen = true;
							usageYielded = true;
							yield {
								seq: 0,
								type: "usage",
								inputTokens,
								outputTokens,
								cacheRead,
								cacheWrite,
								known: usageSeen,
							};
							break;
						case "message_stop":
							// round 6/round 9: EVERY stop path emits a usage first. If no
							// message_delta yielded one, but message_start DID
							// report usage data, an honest KNOWN usage is built
							// from that data now — only a truly silent provider
							// gets known:false (nulls, never faked). The
							// ADR-0003 invariant "usage precedes stop" holds
							// structurally.
							if (!usageYielded) {
								yield {
									seq: 0,
									type: "usage",
									inputTokens,
									outputTokens,
									cacheRead,
									cacheWrite,
									known: usageSeen,
								};
							}
							// D3: a message_stop with NO delta means the
							// provider never reported a stop reason — that is
							// an error, never a default end_turn.
							yield { seq: 0, type: "stop", reason: stopReasonSeen ? stopReason : "error" };
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

/**
 * Exhaustive over the SDK's CLOSED StopReason union (Area 6): a new SDK
 * enum is a compile error here, and none of them degrades into `end_turn`.
 * `pause_turn` and `refusal` are explicit non-completions.
 */
function mapStopReason(reason: Anthropic.Messages.StopReason): StopReason {
	switch (reason) {
		case "end_turn":
			return "end_turn";
		case "max_tokens":
			return "max_tokens";
		case "stop_sequence":
			return "stop_sequence";
		case "tool_use":
			return "tool_use";
		case "pause_turn":
			return "pause_turn";
		case "refusal":
			return "refusal";
		case "model_context_window_exceeded":
			return "context_window";
		default: {
			// The `never` annotation fails the typecheck when the SDK grows
			// a new member; at runtime an unexpected value is an honest
			// `error`, never a completed.
			const _exhaustive: never = reason;
			void _exhaustive;
			return "error";
		}
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
	// D4: connection-level failures are recognized, not lumped into unknown.
	if (err instanceof Anthropic.APIConnectionTimeoutError) {
		return { code: "timeout", retryable: true, message: err.message };
	}
	if (err instanceof Anthropic.APIConnectionError) {
		return { code: "network", retryable: true, message: err.message };
	}
	if (err instanceof Anthropic.APIError) {
		return mapApiError(err.status, err.message);
	}
	return err;
}
