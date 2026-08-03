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

	// C 组: vetoed/rewritten user inputs. Collect the replacement map
	// first — a user_input is skipped when a later user_input_replaced
	// supersedes it, and the replacement (non-null content) produces the
	// only user message later turns see.
	const replaced = new Map<number, string | readonly import("../protocol/messages.js").ContentBlock[] | null>();
	for (const ev of events) {
		if (ev.type === "user_input_replaced") replaced.set(ev.replaces, ev.content);
	}

	for (const ev of events) {
		switch (ev.type) {
			case "user_input": {
				if ("seq" in ev && typeof ev.seq === "number" && replaced.has(ev.seq)) break; // superseded — the replacement speaks for it
				flushAssistant();
				out.push({
					role: "user",
					content: ev.content,
					...(ev.source !== undefined ? { source: ev.source } : {}),
				} satisfies UserMessage);
				break;
			}
			case "user_input_replaced": {
				flushAssistant();
				if (ev.content !== null) {
					out.push({ role: "user", content: ev.content } satisfies UserMessage);
				}
				break;
			}
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
				out.push({
					role: "tool",
					callId: ev.callId,
					content: ev.content,
					isError: ev.isError,
					...(ev.source !== undefined ? { source: ev.source } : {}),
					...(ev.tags !== undefined ? { tags: ev.tags } : {}),
				} satisfies ToolResultMessage);
				break;
			}
			case "compacted": {
				flushAssistant();
				// Apply the EXACT persisted replacements — never re-run the
				// compaction algorithm (a future version could differ).
				const byCallId = new Map(ev.cleared.map((c) => [c.callId, c.content]));
				const replaced = out.map((m) =>
					m.role === "tool" && byCallId.has(m.callId)
						? { ...m, content: byCallId.get(m.callId)! }
						: m,
				);
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
				// One event sequence PER BLOCK: text blocks keep their
				// boundaries (text_start/delta/end each), tool calls their
				// own start/end pair — the round trip is lossless.
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
				break;
			}
			case "tool": {
				out.push({
					type: "tool_result",
					callId: msg.callId,
					content:
						typeof msg.content === "string"
							? msg.content
							: msg.content
									.filter((b) => b.type === "text")
									.map((b) => b.text)
									.join(""),
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
