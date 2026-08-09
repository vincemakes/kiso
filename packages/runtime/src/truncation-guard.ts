/**
 * 0.1.40 (R-C item 3) — the truncation guard: a runtime adapter wrapper.
 *
 * The pi protection: a truncated stream (stopReason max_tokens/length) can
 * yield tool args that parse and validate but are silently incomplete —
 * executing them is the destructive-bug class. The provider adapters already
 * see the stop reason; the RUNTIME vetoes execution of the whole batch:
 *
 *   - tool_call_end events are held per turn (the deltas pass through live —
 *     the UI still shows the calls building, only the COMPLETION is gated);
 *   - a compatible stop flushes the held calls in order, then the stop — the
 *     kernel launches them exactly as before (the parallel window survives;
 *     only the 0.1.26 mid-stream launch timing is gone — the cost of the
 *     guarantee: the turn's truncated intent is never half-executed);
 *   - a truncation stop flushes the held calls with input: null — the
 *     kernel's EXISTING invalid-input denial fails the whole batch without
 *     executing anything (the same honest null the adapters already emit
 *     for unparseable partials — zero new protocol surface), and the turn
 *     still ends with the max_tokens terminal (the loop's voided settle).
 *
 * The kernel machinery (the streaming launch, the window, the voided
 * settle) is untouched — the gate lives at the adapter boundary, where the
 * stop reason is already known.
 */

import type { Adapter, AdapterEvent } from "@vincemakes/kiso-core";

type ToolCallEndEvent = Extract<AdapterEvent, { type: "tool_call_end" }>;

/** Wrap the adapter so a truncated turn's tool batch can never execute. */
export function truncationGuard(adapter: Adapter): Adapter {
	return {
		stream(options) {
			return guardStream(adapter.stream(options));
		},
	};
}

async function* guardStream(stream: AsyncIterable<AdapterEvent>): AsyncIterable<AdapterEvent> {
	const held: ToolCallEndEvent[] = [];
	for await (const ev of stream) {
		if (ev.type === "tool_call_end") {
			held.push(ev);
			continue; // held — emitted at the stop, complete or nulled
		}
		if (ev.type === "stop") {
			const truncated = ev.reason === "max_tokens";
			for (const call of held) {
				// truncation: null input — the kernel's denial path fails the
				// call without executing it; otherwise: untouched, in order.
				yield truncated ? { ...call, input: null } : call;
			}
			held.length = 0;
		}
		yield ev;
	}
	// A stream that ends WITHOUT a stop drops the held ends — the kernel
	// already voids the malformed turn (invalid_request); the dangling
	// deltas are the pre-existing malformed-stream shape.
}
