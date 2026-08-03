/**
 * L2 — the reducer: messages are a PURE projection of the event log.
 *
 * ADR-0002 says the log is the single truth. These two functions are what
 * make that claim enforceable: `projectMessages(log.all)` rebuilds the exact
 * message array the loop hands to the adapter, and `messagesToEvents`
 * encodes seed history into the log. Round-trip property:
 * `projectMessages(messagesToEvents(m)) === m` — pinned by tests.
 *
 * The loop no longer keeps a parallel `messages` array (the Phase B fix):
 * every adapter call derives from the log, so there is one store and the
 * replay of `seq` 0..N reproduces the run exactly.
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
	ContentBlock,
	Message,
	ToolResultMessage,
} from "../protocol/messages.js";
import { microcompact } from "./compaction.js";

interface PendingCall {
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>> | null;
}

/**
 * Rebuild the message array from events. Deterministic and order-sensitive:
 * replaying the same log always produces the same messages.
 */
export function projectMessages(events: readonly (Event | EventInput)[]): readonly Message[] {
	const out: Message[] = [];
	let text = "";
	let calls: PendingCall[] = [];

	const flushAssistant = (): void => {
		if (text === "" && calls.length === 0) return;
		const blocks: AssistantBlock[] = [];
		if (text !== "") blocks.push({ type: "text", text });
		for (const call of calls) {
			blocks.push({
				type: "tool_use",
				callId: call.callId,
				name: call.name,
				input: call.input ?? {},
			});
		}
		out.push({ role: "assistant", blocks });
		text = "";
		calls = [];
	};

	for (const ev of events) {
		switch (ev.type) {
			case "user_input":
				flushAssistant();
				out.push({ role: "user", content: ev.content });
				break;
			case "text_start":
			case "text_end":
				break; // boundaries are implicit; text accumulates
			case "text_delta":
				text += ev.text;
				break;
			case "tool_call_start":
				break; // identity arrives at tool_call_end
			case "tool_call_input_delta":
				break; // the parsed input arrives at tool_call_end
			case "tool_call_end":
				calls.push({ callId: ev.callId, name: ev.name, input: ev.input });
				break;
			case "tool_result":
				flushAssistant();
				out.push({
					role: "tool",
					callId: ev.callId,
					content: ev.content,
					isError: ev.isError,
				} satisfies ToolResultMessage);
				break;
			case "compacted":
				flushAssistant();
				{
					const compacted = microcompact(out);
					out.splice(0, out.length, ...compacted.messages);
				}
				break;
			case "thinking":
			case "usage":
			case "stop":
			case "terminal":
				flushAssistant();
				break;
		}
	}
	flushAssistant();
	return out;
}

/**
 * Encode seed messages into log events. Used by the loop when it starts with
 * a fresh log: the seed enters the log as events, so the projection (and the
 * replay) contains it. Not a lossless serializer for every Message shape —
 * content blocks and error kinds pass through, tags do not.
 */
export function messagesToEvents(messages: readonly Message[]): EventInput[] {
	const out: EventInput[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
				out.push({ type: "user_input", content: msg.content });
				break;
			case "assistant": {
				let pendingText: string | null = null;
				for (const block of msg.blocks) {
					if (block.type === "text") {
						if (pendingText === null) {
							out.push({ type: "text_start" });
							pendingText = "";
						}
						pendingText += block.text;
					} else {
						if (pendingText !== null) {
							out.push({ type: "text_delta", text: pendingText });
							out.push({ type: "text_end" });
							pendingText = null;
						}
						out.push({
							type: "tool_call_start",
							callId: block.callId,
							name: block.name,
						});
						out.push({
							type: "tool_call_end",
							callId: block.callId,
							name: block.name,
							input: block.input as Record<string, unknown>,
						});
					}
				}
				if (pendingText !== null) {
					out.push({ type: "text_delta", text: pendingText });
					out.push({ type: "text_end" });
				}
				break;
			}
			case "tool":
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
				});
				break;
		}
	}
	return out;
}

export type { ContentBlock };
