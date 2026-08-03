/**
 * L2 — the reducer: messages are a PURE projection of the event log.
 *
 * ADR-0002 says the log is the single truth. These two functions are what
 * make that claim enforceable: `projectMessages(log.all)` rebuilds the exact
 * message array the loop hands to the adapter, and `messagesToEvents`
 * encodes seed history into the log. Round-trip property:
 * `projectMessages(messagesToEvents(m)) === m` — pinned by tests, and
 * LOSSLESS (Area 6): `source`, `tags`, image content blocks, and assistant
 * text-block boundaries survive the round trip.
 *
 * The loop no longer keeps a parallel `messages` array: every adapter call
 * derives from the log, so there is one store and the replay of `seq` 0..N
 * reproduces the run exactly.
 *
 * Events with no message shape (usage, stop, thinking, terminal, compacted's
 * own record) are skipped by the projection; `compacted` REPLAYS the
 * compaction by re-running microcompact at that point in the sequence —
 * microcompact is deterministic and idempotent, so the replay equals the
 * live run. See ADR-0002.
 */

import type { Event } from "../protocol/events.js";
import type { EventInput } from "./event-log.js";
import type {
	AssistantBlock,
	AssistantMessage,
	Message,
	MessageSource,
	ToolResultMessage,
	UserMessage,
} from "../protocol/messages.js";

/**
 * Rebuild the message array from events. Deterministic and order-sensitive:
 * replaying the same log always produces the same messages.
 *
 * Text block boundaries are preserved: `text_end` closes the current text
 * block (an explicit boundary); `text_start` after a block opens a new one.
 * A stream of deltas WITHOUT `text_end` (the adapters' common shape) closes
 * at the next block/tool/result boundary.
 */
export function projectMessages(events: readonly (Event | EventInput)[]): readonly Message[] {
	const out: Message[] = [];
	let blocks: AssistantBlock[] = [];
	let text: string | null = null;
	let assistantSource: MessageSource | undefined;

	const pushText = (): void => {
		if (text !== null) {
			blocks.push({ type: "text", text });
			text = null;
		}
	};
	const flushAssistant = (): void => {
		pushText();
		if (blocks.length === 0) {
			assistantSource = undefined;
			return;
		}
		out.push({
			role: "assistant",
			blocks: [...blocks],
			...(assistantSource !== undefined ? { source: assistantSource } : {}),
		} satisfies AssistantMessage);
		blocks = [];
		assistantSource = undefined;
	};

	// C 组/六: vetoed/rewritten user inputs. Collect the replacement map
	// first — the FINAL replacement for each input wins (later replacements
	// never produce extra messages), and the replacement renders AT THE
	// INPUT'S OWN POSITION: the original is skipped, the final non-null
	// content speaks for it there, a null content is a true veto (nothing
	// at that position).
	const replaced = new Map<
		number,
		{ content: string | readonly import("../protocol/messages.js").ContentBlock[] | null; source?: MessageSource }
	>();
	for (const ev of events) {
		if (ev.type === "user_input_replaced") {
			replaced.set(ev.replaces, {
				content: ev.content,
				...(ev.source !== undefined ? { source: ev.source } : {}),
			});
		}
	}

	let explicitAssistant = false;

	for (const ev of events) {
		switch (ev.type) {
			case "user_input": {
				// 六: the final replacement renders HERE, at the input's own
				// position — the original is skipped, the replacement event
				// itself produces nothing (a later replacement for the same
				// input never becomes a second message).
				if ("seq" in ev && typeof ev.seq === "number" && replaced.has(ev.seq)) {
					const replacement = replaced.get(ev.seq)!;
					flushAssistant();
					if (replacement.content !== null) {
						out.push({
							role: "user",
							content: replacement.content,
							...(replacement.source !== undefined ? { source: replacement.source } : {}),
						} satisfies UserMessage);
					}
					break;
				}
				flushAssistant();
				out.push({
					role: "user",
					content: ev.content,
					...(ev.source !== undefined ? { source: ev.source } : {}),
				} satisfies UserMessage);
				break;
			}
			case "user_input_replaced":
				// The replacement already rendered at its input's position —
				// this event carries no message of its own (六).
				break;
			case "assistant_start":
				// D 组: an explicit message boundary — close any open message
				// and begin a new one (adjacent assistants stay separate).
				flushAssistant();
				explicitAssistant = true;
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "assistant_end":
				// Close the message; an EMPTY explicit message is preserved.
				if (explicitAssistant && blocks.length === 0 && text === null) {
					out.push({
						role: "assistant",
						blocks: [],
						...(assistantSource !== undefined ? { source: assistantSource } : {}),
					} satisfies AssistantMessage);
					assistantSource = undefined;
				} else {
					flushAssistant();
				}
				explicitAssistant = false;
				break;
			case "text_start":
				pushText(); // an explicit boundary: a new block begins
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "text_end":
				pushText(); // an explicit boundary: the block closes
				break;
			case "text_delta":
				text = (text ?? "") + ev.text;
				break;
			case "tool_call_start":
				if (ev.source !== undefined) assistantSource = ev.source;
				break;
			case "tool_call_input_delta":
				break; // the parsed input arrives at tool_call_end
			case "tool_call_end":
				pushText();
				blocks.push({
					type: "tool_use",
					callId: ev.callId,
					name: ev.name,
					input: ev.input ?? {},
				});
				break;
			case "tool_result": {
				flushAssistant();
				const message: ToolResultMessage = {
					role: "tool",
					callId: ev.callId,
					content: ev.content,
					isError: ev.isError,
					...(ev.source !== undefined ? { source: ev.source } : {}),
					...(ev.tags !== undefined ? { tags: ev.tags } : {}),
				};
				// 五: the originating event's seq rides on the message as a
				// NON-ENUMERABLE correlation field — the stable identity
				// compaction uses to name WHICH result it replaced. Deep
				// equality with seed messages (which carry no such field)
				// still holds; a spread drops it, which is fine because the
				// projection re-derives everything fresh from the log.
				if ("seq" in ev && typeof ev.seq === "number") {
					Object.defineProperty(message, "eventSeq", { value: ev.seq, enumerable: false, configurable: true });
				}
				out.push(message);
				break;
			}
			case "compacted": {
				flushAssistant();
				// Apply the EXACT persisted replacements — never re-run the
				// compaction algorithm (a future version could differ). 五:
				// v2 entries are keyed by the replaced tool-result EVENT's
				// seq, so only the specific result is rewritten — never a
				// same-callId sibling from another turn or run. 第四轮: v1
				// entries (round-three sessions, no eventSeq) replay with v1
				// semantics — every tool result with that callId is replaced,
				// exactly as the old framework did.
				const byEventSeq = new Map(
					ev.cleared.filter((c) => c.eventSeq !== undefined).map((c) => [c.eventSeq!, c.content]),
				);
				const byCallId = new Map(
					ev.cleared.filter((c) => c.eventSeq === undefined).map((c) => [c.callId, c.content]),
				);
				const replaced = out.map((m) => {
					if (m.role !== "tool") return m;
					if (m.eventSeq !== undefined && byEventSeq.has(m.eventSeq)) {
						return { ...m, content: byEventSeq.get(m.eventSeq)! };
					}
					if (byCallId.has(m.callId)) return { ...m, content: byCallId.get(m.callId)! };
					return m;
				});
				out.splice(0, out.length, ...replaced);
				break;
			}
			case "thinking":
			case "usage":
			case "stop":
			case "terminal":
			case "tool_execution_started":
			case "tool_execution_succeeded":
			case "tool_execution_failed":
			case "tool_execution_resolved":
			case "permission_requested":
			case "permission_decided":
			case "permission_expired":
			case "uncertain_pending":
				flushAssistant();
				break;
		}
	}
	flushAssistant();
	return out;
}

/**
 * Encode seed messages into log events — LOSSLESSLY for the framework's own
 * shapes (Area 6): one `text_delta` per text block (boundaries preserved),
 * `source` on the first event of each message, `tags` on tool results,
 * content blocks passed through. Nothing a legal Message can express is
 * dropped.
 */
export function messagesToEvents(messages: readonly Message[]): EventInput[] {
	const out: EventInput[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				out.push({
					type: "user_input",
					content: msg.content,
					...(msg.source !== undefined ? { source: msg.source } : {}),
				});
				break;
			}
			case "assistant": {
				// D 组: an explicit assistant_start/assistant_end pair frames
				// the message — adjacent and empty assistants round-trip.
				out.push({
					type: "assistant_start",
					...(msg.source !== undefined ? { source: msg.source } : {}),
				});
				for (const block of msg.blocks) {
					if (block.type === "text") {
						out.push({
							type: "text_start",
							...(msg.source !== undefined ? { source: msg.source } : {}),
						});
						out.push({ type: "text_delta", text: block.text });
						out.push({ type: "text_end" });
					} else {
						out.push({
							type: "tool_call_start",
							callId: block.callId,
							name: block.name,
							...(msg.source !== undefined ? { source: msg.source } : {}),
						});
						out.push({
							type: "tool_call_end",
							callId: block.callId,
							name: block.name,
							input: block.input as Record<string, unknown>,
						});
					}
				}
				out.push({ type: "assistant_end" });
				break;
			}
			case "tool": {
				// D1: the FULL content (blocks included) is preserved — never
				// flattened to text.
				out.push({
					type: "tool_result",
					callId: msg.callId,
					content: msg.content,
					isError: msg.isError,
					...(msg.source !== undefined ? { source: msg.source } : {}),
					...(msg.tags !== undefined ? { tags: msg.tags } : {}),
				});
				break;
			}
		}
	}
	return out;
}

export type { AssistantBlock, MessageSource };
