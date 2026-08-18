/**
 * R-F 0.1.46 — the recovery plan: recovery as pure projection. From the
 * durable event prefix the plan derives THE unique safe next step — never
 * the adjudication itself (the approval pipeline stays in the runtime driver
 * layer, run.ts). Purity: no I/O, no ID generation, no time — the same
 * prefix always derives the same plan. The driver consumes one action at a
 * time and re-derives after every append: the recovery is a loop over this
 * projection, not a second state machine (the R-F thesis — fresh execution
 * and resume walk the same ordinary program).
 *
 * The action vocabulary (the R-F directive):
 *   COMPLETED              — no open run: nothing to recover
 *   TERMINAL               — the open run reached its terminal
 *   WAIT_PERMISSION(seq)   — a stored request awaits the human
 *   DECIDE_PERMISSION(seq) — a committed call re-enters the approval pipeline
 *   EXECUTE(seq)           — a durable approval authorizes the persisted call
 *   RESOLVE_UNCERTAIN(id)  — a started execution with no receipt: the crash
 *                            window — the human decides (never auto-rerun)
 *   REPAIR_RESULT(id|seq)  — the model-facing result is missing: complete it
 *                            from the durable fact (the receipt or the denial)
 *   FILL_RESOLUTION(id)    — a resolution's model-facing fill is missing
 *   ABANDON_DRAFT(from)    — a text-bearing no-stop suffix: void it (the
 *                            driver appends the marker AND expires the voided
 *                            requests — one deterministic step, sentence 3)
 *   CONTINUE_MODEL         — nothing left to repair: drive the loop
 *
 * The derivation order is the R-E recovery's phase order (the zero-behavior
 * proof: the prefix-table gate and the healing fixtures run unchanged):
 * terminal > completed > uncertain > draft > invocations (the Gap A calls,
 * then the stored requests) > receipt repairs > resolution fills > continue.
 *
 * Inputs: `events` — the session's full event prefix (the log); `scope` —
 * the open run's stored events at resume start (the run boundaries). Both
 * are pure inputs; the caller loads them.
 */

import type { Event } from "@vincemakes/kiso-core";
import { executionLedger } from "./ledger.js";

export type RecoveryAction =
	| { readonly kind: "COMPLETED" }
	| { readonly kind: "TERMINAL" }
	| { readonly kind: "WAIT_PERMISSION"; readonly invocationSeq: number }
	| { readonly kind: "DECIDE_PERMISSION"; readonly invocationSeq: number }
	| { readonly kind: "EXECUTE"; readonly invocationSeq: number }
	/** The receipt repair (executionId) or the durable-denial repair (invocationSeq). */
	| { readonly kind: "REPAIR_RESULT"; readonly executionId?: string; readonly invocationSeq?: number }
	| { readonly kind: "RESOLVE_UNCERTAIN"; readonly executionId: string }
	| { readonly kind: "FILL_RESOLUTION"; readonly executionId: string }
	| { readonly kind: "ABANDON_DRAFT"; readonly voidFromSeq: number }
	| { readonly kind: "CONTINUE_MODEL" };

/** The committed boundaries of a run's events (Gap B's boundary list). */
const isBoundary = (e: Event): boolean =>
	e.type === "stop" ||
	e.type === "user_input" ||
	e.type === "terminal" ||
	e.type === "microcompacted" ||
	e.type === "compacted" ||
	e.type === "summarized" ||
	e.type === "model_output_abandoned";

/** A request's framework identity: its own invocationSeq, or the old-log
 *  fallback (the last same-callId call before the request, in the scope). */
export function invocationSeqOf(request: Event & { type: "permission_requested" }, scope: readonly Event[]): number | undefined {
	if (request.invocationSeq !== undefined) return request.invocationSeq;
	let seq: number | undefined;
	for (const e of scope) {
		if (e.type === "tool_call_end" && e.callId === request.callId && e.seq < request.seq) seq = e.seq;
	}
	return seq;
}

/** The events of the open run INCLUDING the recovery's own appends — the
 *  scope plus everything the driver appended after it (seq is global and
 *  monotonic, so the tail is exactly the appends). */
function openRunEvents(events: readonly Event[], scope: readonly Event[]): readonly Event[] {
	if (scope.length === 0) return events;
	const lastScopeSeq = scope[scope.length - 1]!.seq;
	const tail = events.filter((e) => e.seq > lastScopeSeq);
	return [...scope, ...tail];
}

/** The one safe next step for the durable prefix (derivation order above). */
export function deriveRecoveryPlan(events: readonly Event[], scope: readonly Event[]): RecoveryAction {
	// 1. the open run reached its terminal → done. The terminal may be in the
	//    scope (a resume adopted a run the loop completed in a previous
	//    process) or in the driver's own tail (the continuation's terminal).
	if (openRunEvents(events, scope).some((e) => e.type === "terminal")) return { kind: "TERMINAL" };
	// 2. nothing open → nothing to recover.
	if (scope.length === 0) return { kind: "COMPLETED" };
	// 3. the crash window: a started execution with no receipt is the human's
	//    (never auto-rerun — the prefix-table gate's row 7). The FIRST in log
	//    order blocks; the driver throws with the full list. A receipted
	//    execution is an outcome (ruling #12 / the α ruling: the audit keeps
	//    it) — never uncertain.
	//    ADR-0038: uncertainty belongs to the crash window ALONE. This filter
	//    is the whole of it — `executionLedger` derives "uncertain" only for
	//    started-without-receipt, so a FAILED execution never reaches this
	//    branch and never blocks a resume, whatever its safeToRetry says.
	const uncertain = [...executionLedger(events).values()].filter((r) => r.status === "uncertain");
	if (uncertain.length > 0) return { kind: "RESOLVE_UNCERTAIN", executionId: uncertain[0]!.executionId };
	// 4. Gap B: a no-stop suffix of MODEL OUTPUT is an abandoned draft — void
	//    it. The boundary/draft scans run over the OPEN RUN's events
	//    INCLUDING the driver's own appends — the driver re-derives after
	//    every append, and the marker IT appended must already be the last
	//    boundary (the old one-pass Gap B never needed this: it ran before
	//    any append).
	//
	//    EC-1, finding EC1-F1: the scan counts `tool_call_end` too. It used
	//    to be text-only, on the 0.1.44 reasoning that "a bare tool-call
	//    suffix is the legal approval-panel pause, never a draft" — but that
	//    reasoning only ever held for a suffix carrying a REQUEST (the
	//    liveAsk clause below, which still decides that case). A bare call
	//    with no request is not a pause; it is an uncommitted draft, and
	//    leaving it un-voided projects an assistant `tool_use` block with no
	//    result — a provider 400. Pre-EC-1 the window was microseconds wide
	//    (the stop was persisted the moment it arrived); ① holds the stop
	//    until the stream is exhausted, so crash-pair A lands in this shape
	//    by construction.
	const openEvents = openRunEvents(events, scope);
	const boundary = [...openEvents].reverse().find(isBoundary);
	if (boundary !== undefined) {
		//    A call only makes a DRAFT while it is still pure intent. Once it
		//    has a durable `tool_execution_started` the world may have moved,
		//    and the existing repair passes own it: voiding such a call would
		//    strand a real receipt behind a voided declaration (pair atomicity
		//    would then drop its result and the model would never learn the
		//    outcome of work that actually happened). Pre-EC-1 logs contain
		//    exactly that shape — a call that launched mid-stream and finished
		//    before its stop was persisted — and they must keep recovering the
		//    way they always did.
		const unexecuted = (e: Event): boolean =>
			e.type === "tool_call_end" && !openEvents.some((x) => x.type === "tool_execution_started" && x.callId === e.callId);
		const afterBoundary = openEvents.some(
			(e) => (e.type === "text_delta" || e.type === "thinking" || unexecuted(e)) && e.seq > boundary.seq,
		);
		// The approval-panel pause: a suffix that carries a pending ask of the
		// LIVE turn — the last boundary is the user_input, no stop since — is
		// the human's pause, never a draft: the call was extracted and asked,
		// the request is durable, the WAIT_PERMISSION step re-announces it.
		// (The loop persists the stream's tail AFTER the pause resolves, so a
		// crash mid-pause leaves exactly this shape.) A request AFTER a STOP
		// is different: it is the draft's own ask (0143's shape) — the marker
		// voids it and the request expires with the draft.
		//
		// EC-1 ERA NOTE — this clause is now GENERATION COMPAT, and is kept
		// for that reason alone. A kiso at 0.13.0 or later cannot produce the
		// shape: asks moved AFTER Turn Commit (③), so a durable
		// `permission_requested` always has a durable stop before it. Logs
		// written by EARLIER bins do carry it, they are on disk, and they
		// must keep re-presenting their ask instead of being voided as
		// drafts. Deleting this clause would silently change how pre-EC-1
		// sessions recover; it stays until the generation corpus no longer
		// contains a pre-EC-1 era.
		const liveAsk =
			afterBoundary &&
			boundary.type === "user_input" &&
			openEvents.some((e) => e.type === "permission_requested" && e.seq > boundary.seq);
		if (afterBoundary && !liveAsk) return { kind: "ABANDON_DRAFT", voidFromSeq: boundary.seq };
	}
	// 5. the invocations: the Gap A calls first (scope order), then the
	//    stored requests (scope order, then this recovery's own asks). Each:
	//    undecided → the pipeline must decide; decided-approved without an
	//    execution → execute the persisted call; decided-denied without a
	//    model-facing result → repair it from the denial.
	const hasRequest = (callId: string, after: number): boolean =>
		events.some((e) => e.type === "permission_requested" && e.callId === callId && e.seq > after);
	const hasExecution = (callId: string, after: number): boolean =>
		events.some((e) => e.type === "tool_execution_started" && e.callId === callId && e.seq > after);
	const hasResult = (callId: string, after: number): boolean =>
		events.some((e) => e.type === "tool_result" && e.callId === callId && e.seq > after);
	const decidedForCall = (callId: string, after: number): (Event & { type: "permission_decided" }) | undefined => {
		for (const e of events) {
			if (e.type !== "permission_decided") continue;
			// a durable POLICY verdict binds the call (E1); a human verdict
			// binds its request, never the call (the requests pass owns it)
			if (e.decidedBy !== undefined && e.callId === callId && e.seq > after) return e;
		}
		return undefined;
	};
	const decidedForRequest = (decisionId: string): (Event & { type: "permission_decided" }) | undefined => {
		for (const e of events) {
			if (e.type === "permission_decided" && e.decisionId === decisionId) return e;
		}
		return undefined;
	};
	for (const call of scope) {
		if (call.type !== "tool_call_end") continue;
		// the boundary clause: a call whose turn has no legal stop is a
		// DRAFT's call — Gap B voids it; this pass never touches it.
		const turnEnd = scope.find((e) => e.type === "user_input" && e.seq > call.seq)?.seq ?? Number.POSITIVE_INFINITY;
		if (!scope.some((e) => e.type === "stop" && e.seq > call.seq && e.seq < turnEnd)) continue;
		// a stored request owns the invocation (the requests pass below) —
		// "only a durable permission_decided authorizes an effect"; Gap A
		// must never re-decide over a stored request.
		if (hasRequest(call.callId, call.seq)) continue;
		if (hasResult(call.callId, call.seq)) continue; // closed — nothing to fill
		const decided = decidedForCall(call.callId, call.seq);
		if (decided === undefined) return { kind: "DECIDE_PERMISSION", invocationSeq: call.seq };
		if (decided.decision === "approved") {
			if (!hasExecution(call.callId, call.seq)) return { kind: "EXECUTE", invocationSeq: call.seq };
		} else if (!hasResult(call.callId, call.seq)) {
			return { kind: "REPAIR_RESULT", invocationSeq: call.seq };
		}
	}
	const lastScopeSeq = scope.length > 0 ? scope[scope.length - 1]!.seq : -1;
	const requests = [
		...scope.filter((e): e is Event & { type: "permission_requested" } => e.type === "permission_requested"),
		// this recovery's own asks (the Gap A ask appends) — the log tail
		...events.filter((e): e is Event & { type: "permission_requested" } => e.type === "permission_requested" && e.seq > lastScopeSeq),
	];
	for (const pending of requests) {
		const invocationSeq = invocationSeqOf(pending, scope);
		// a voided request was expired by the ABANDON_DRAFT step (sentence 3:
		// never re-presented, never executed) — skip it here.
		if (
			invocationSeq !== undefined &&
			events.some((e) => e.type === "model_output_abandoned" && invocationSeq! > e.voidFromSeq && invocationSeq! <= e.seq)
		) {
			continue;
		}
		const decided = decidedForRequest(pending.decisionId);
		if (decided === undefined) {
			return { kind: "WAIT_PERMISSION", invocationSeq: invocationSeq ?? pending.seq };
		}
		if (decided.decision === "approved") {
			if (!hasExecution(pending.callId, pending.seq)) return { kind: "EXECUTE", invocationSeq: invocationSeq ?? pending.seq };
		} else if (!hasResult(pending.callId, pending.seq)) {
			return { kind: "REPAIR_RESULT", invocationSeq: invocationSeq ?? pending.seq };
		}
	}
	// 6. the receipt repairs: an execution that reached a terminal state
	//    whose model-facing result never landed — complete it FROM THE
	//    RECEIPT, never re-executed.
	for (const ev of scope) {
		if (ev.type !== "tool_execution_succeeded" && ev.type !== "tool_execution_failed") continue;
		if (!hasResult(ev.callId, ev.seq) && !events.some((e) => e.type === "tool_result" && e.executionId === ev.executionId)) {
			return { kind: "REPAIR_RESULT", executionId: ev.executionId };
		}
	}
	// 7. the resolution fills: a persisted resolution whose model-facing fill
	//    never landed — the model must never stare at a dangling tool_use.
	for (const ev of scope) {
		if (ev.type !== "tool_execution_resolved") continue;
		if (!events.some((e) => e.type === "tool_result" && e.executionId === ev.executionId)) {
			return { kind: "FILL_RESOLUTION", executionId: ev.executionId };
		}
	}
	// 8. nothing left to repair — the loop drives from here.
	return { kind: "CONTINUE_MODEL" };
}
