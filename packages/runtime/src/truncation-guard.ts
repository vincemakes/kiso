/**
 * 0.1.40 (R-C item 3) — the truncation guard: a runtime adapter wrapper.
 *
 * WHY: a truncated stream (stop reason max_tokens/length) can yield tool
 * args that PARSE and VALIDATE while being silently incomplete — a delete
 * whose `filter` never arrived, an edit missing its second hunk. Executing
 * those is the destructive-bug class. The adapters already know the stop
 * reason, so the veto belongs at that boundary.
 *
 * THE CONTRACT this wrapper establishes:
 *
 *   1. HOLD. A `tool_call_end` is withheld until the turn's stop reason is
 *      known. No call completes — so none launches — before the provider
 *      has said why it stopped. The deltas still pass through live: a
 *      surface shows the calls building; only the COMPLETION is gated.
 *   2. RELEASE ON A VALID STOP. A compatible stop flushes the held calls
 *      unchanged and in CALL order, then the stop itself. Downstream sees
 *      exactly what the provider sent.
 *   3. max_tokens VOIDS THE WHOLE BATCH. Every held call is flushed with
 *      `input: null`, and the kernel's EXISTING invalid-input denial fails
 *      all of them without executing anything (the same honest null the
 *      adapters already emit for unparseable partials — zero new protocol
 *      surface). The turn still ends on the max_tokens terminal (the
 *      loop's voided settle). All-or-nothing per turn: a truncated intent
 *      is never HALF executed.
 *   4. NO STOP AT ALL drops the held calls entirely — the kernel already
 *      voids that malformed turn (invalid_request).
 *
 * THE CONSERVATISM SPLIT — core and runtime differ here BY DESIGN:
 *
 *   - the RAW KERNEL STREAMS. `loop()` over a bare adapter launches each
 *     validated, policy-allowed call the moment its `tool_call_end` lands
 *     (ADR-0024 Amendment 1, streaming execution): maximum overlap with
 *     the model stream, trusting calls as they arrive.
 *   - the FLAGSHIP RUNTIME STOP-GATES. `run.ts` composes this wrapper into
 *     EVERY run unconditionally, so the product pays a real latency cost —
 *     the 0.1.26 mid-stream launch timing is gone (the parallel window is
 *     NOT: the released batch still runs concurrently) — to buy the
 *     guarantee.
 *
 * So the kernel's default is speed and the flagship's default is safety;
 * an embedder choosing the kernel alone chooses the streaming launch, and
 * applying this wrapper is how they opt into the guarantee. The kernel
 * machinery (the launch, the window, the voided settle) is untouched
 * either way — the gate lives at the adapter boundary.
 *
 * Pinned by `packages/runtime/tests/truncation-guard.test.ts`.
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
