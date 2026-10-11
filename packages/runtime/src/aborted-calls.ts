/**
 * 0.40.2 — a COMMITTED call that never ran, in a run that ended aborted.
 *
 * The finding: an esc that lands after a turn's `stop` committed it (EC-1
 * ①) but before a call's `tool_execution_started` leaves that call's
 * `tool_call_end` on disk with no started, no receipt and no result — the
 * kernel's abort sentinel is swallowed at the launch (no started, no
 * receipt, never uncertain: right for an UNCOMMITTED turn, which the loop
 * abandons whole). The run's terminal is written, so the recovery plan
 * answers TERMINAL and nothing ever completes the call. The projection
 * keeps the `tool_use` without its result, and every later request is a
 * provider 400 — the session is poisoned for good (the owner's session
 * 2026-09-22T01-58-27-0027: three committed shell calls, two results).
 *
 * The cure lives here, in the runtime's recovery, and not in the kernel:
 * when a session opens, each such call gets ONE durable `tool_result` —
 * "aborted before execution", a precondition error, the very result the
 * kernel writes when the same esc lands one step later — riding the run
 * that owns the call. It is idempotent per invocation (a crash between two
 * repairs leaves the rest for the next open), it never writes a started
 * event (that would make the call `uncertain` and ask a human about work
 * that provably never began), and it heals the already-poisoned logs with
 * no migration: the next open repairs them.
 */
import type { Event } from "@vincemakes/kiso-core";
import type { StoreRecord } from "./store.js";

export interface UnansweredCall {
	/** The run that owns the call — the repair rides it, so no new open run appears. */
	readonly runId: string;
	readonly callId: string;
	/** The call's own seq (its invocation). */
	readonly invocationSeq: number;
}

/** The result a repaired call receives — the kernel's own words for an
 *  abort that lands after the started event. */
export const ABORTED_BEFORE_EXECUTION = "aborted before execution";

/**
 * Every committed `tool_call_end` with neither a started event nor a
 * result, in a run whose terminal is `aborted`. Committed: a `stop` follows
 * the call inside its turn. Voided model output (a `model_output_abandoned`
 * range) is not a call at all.
 */
export function unansweredAbortedCalls(records: readonly StoreRecord[]): UnansweredCall[] {
	const byRun = new Map<string, Event[]>();
	for (const r of records) {
		const events = byRun.get(r.runId) ?? [];
		events.push(r.event);
		byRun.set(r.runId, events);
	}
	// Answered = a started event or a result for THIS invocation. Both carry
	// invocationSeq today; a legacy result without it answers the latest
	// earlier call with its callId (providers may reuse a callId across turns).
	const answeredSeqs = new Set<number>();
	const legacy: { callId: string; seq: number }[] = [];
	for (const r of records) {
		const e = r.event;
		if (e.type !== "tool_result" && e.type !== "tool_execution_started") continue;
		if ((e as { parent?: string }).parent !== undefined) continue; // a child call answers nothing the model asked
		const invocationSeq = (e as { invocationSeq?: number }).invocationSeq;
		if (invocationSeq !== undefined) answeredSeqs.add(invocationSeq);
		else legacy.push({ callId: e.callId, seq: e.seq });
	}
	const answered = (call: Event & { type: "tool_call_end" }): boolean =>
		answeredSeqs.has(call.seq) || legacy.some((l) => l.callId === call.callId && l.seq > call.seq);
	const out: UnansweredCall[] = [];
	for (const [runId, events] of byRun) {
		const terminal = events.find((e) => e.type === "terminal");
		if (terminal === undefined || terminal.type !== "terminal" || terminal.outcome.kind !== "aborted") continue;
		const voided = events.flatMap((e) => (e.type === "model_output_abandoned" ? [{ from: e.voidFromSeq, to: e.seq }] : []));
		let turn: (Event & { type: "tool_call_end" })[] = [];
		for (const e of events) {
			// an abandoned draft's calls and stop are model output that never was
			if ((e.type === "tool_call_end" || e.type === "stop") && voided.some((v) => e.seq > v.from && e.seq <= v.to)) continue;
			if (e.type === "tool_call_end") turn.push(e);
			else if (e.type === "stop") {
				for (const call of turn) if (!answered(call)) out.push({ runId, callId: call.callId, invocationSeq: call.seq });
				turn = [];
			} else if (e.type === "user_input" || e.type === "terminal") turn = [];
		}
	}
	return out;
}
