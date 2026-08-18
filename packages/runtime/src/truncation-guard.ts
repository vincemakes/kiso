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
 * EC-1 ④ — THE CONTRACT AMENDMENT. The kernel closed the destructive half
 * of this by itself: `max_tokens` cannot carry a tool call, so a truncated
 * turn never reaches Turn Commit, and a commit-required handler never starts
 * before that commit. What max_tokens means now, in full — the four clauses
 * that replace the old "zero tools executed on truncation" line:
 *
 *   1. COMMIT-REQUIRED CALLS NEVER EXECUTE. On either path, guarded or bare.
 *      This is the kernel's guarantee, not the wrapper's, and it holds for
 *      every tool that declares nothing — which is every write, edit and
 *      shell tool kiso ships.
 *   2. PRECOMMIT-SAFE CALLS MAY ALREADY HAVE EXECUTED, and that execution is
 *      DECLARED HARMLESS. A tool carrying `effects.precommitSafe` says
 *      running it before the turn commits is harmless for EVERY invocation —
 *      read-only, free, local. Bare, such a call launches during the stream
 *      and a truncated turn may find its receipt already durable. That is
 *      the certificate being spent, not a leak.
 *   3. THE TURN IS NOT COMMITTED. No durable stop is written. The calls are
 *      an uncommitted draft, which is what the resume sees.
 *   4. PRECOMMIT RESULTS NEVER LEGITIMIZE IT (invariant 7). A durable
 *      receipt from clause 2 is an execution fact and nothing more: it does
 *      not commit the invocation, and it does not make the model turn valid.
 *
 * WHAT THE WRAPPER STILL BUYS, given all that:
 *
 *   - REPORTING. It releases the held batch with `input: null`, so every
 *     call is ANSWERED with an honest invalid_input result. Bare, the same
 *     turn leaves its calls with no results at all — an uncommitted draft
 *     the resume must void.
 *   - THE PRECOMMIT CASE. The hold sits UPSTREAM of the kernel: a held call
 *     never reaches the loop until the stop is known, so clause 2's "may
 *     already have executed" is exactly what the guard removes. Guarded,
 *     nothing runs at all — not even a declared read.
 *
 * So the conservatism split did not disappear, it MOVED. It used to be the
 * difference between a destructive edit running and not running; it is now
 * the difference between a harmless read running and not running, plus the
 * reporting. The kernel's default is speed for CERTIFIED calls and safety
 * for everything else; the flagship runtime composes this wrapper into every
 * run and pays the latency to have neither.
 *
 * Pinned by `packages/runtime/tests/truncation-guard.test.ts` (clauses 1-3
 * of the wrapper contract, byte-unchanged across EC-1 — the amendment did
 * not weaken the guard) and by
 * `packages/runtime/tests/sc1-truncation-contract-pins.test.ts` (clause 4 of
 * the wrapper contract, and the four amended max_tokens clauses above — the
 * declared TRUNCATION CLASS).
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
