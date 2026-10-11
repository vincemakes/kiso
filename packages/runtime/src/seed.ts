/**
 * Seeding an event log from messages: the SDK/bootstrap side of the kernel's boundary.
 *
 * The kernel takes an EventLog (the single truth, ADR-0002) and projects messages FROM it (`projectMessages`); it no longer encodes messages INTO it.
 * Whoever starts a loop with prior history encodes it here - the runtime does it from its durable session log, a direct caller of `loop` with `seedLog`.
 * ONE encoder: the round trip `projectMessages(messagesToEvents(m)) = m` is pinned by tests that import this function and the kernel's projection together
 * (packages/core/tests/project.test.ts and projection-honesty.test.ts, which import this function from @vincemakes/kiso-runtime); no other copy exists.
 *
 * Moved verbatim from packages/core/src/kernel/project.ts (it used only types), 2026-10-11.
 */
import { EventLog, type EventInput, type Message } from "@vincemakes/kiso-core";

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
				// D group: an explicit assistant_start/assistant_end pair frames
				// the message — adjacent and empty assistants round-trip.
				// bootstrap P1: the reasoning re-enters the log as its ORIGINAL
				// thinking event — the projection re-attaches it identically.
				if (msg.reasoning !== undefined) {
					out.push({ type: "thinking", text: msg.reasoning });
				}
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
						// 0.43.0 (#13): a block with rawInput encodes ONE delta (even ""), so Message → Events → Message is lossless
						if (block.rawInput !== undefined) out.push({ type: "tool_call_input_delta", callId: block.callId, inputJsonDelta: block.rawInput });
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

/**
 * Seed a log with `messages` (a new EventLog by default): exactly what `loop({ messages })` used to do - append each encoded event to an EMPTY log, so the
 * sequence numbers are identical; a log that already holds events (a session being resumed) is returned untouched, because it already holds everything.
 * Pass the result as `loop({ log })`. A caller may hand in its own log (any object with `append` and `all`): that is how the core's own tests, which import
 * the kernel from source rather than from its build, keep one EventLog class without a second encoder.
 */
export function seedLog<L extends { append(ev: EventInput): unknown; readonly all: readonly unknown[] } = EventLog>(messages: readonly Message[], log: L = new EventLog() as unknown as L): L {
	if (log.all.length === 0) for (const ev of messagesToEvents(messages)) log.append(ev);
	return log;
}
