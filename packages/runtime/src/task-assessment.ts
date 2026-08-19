/**
 * TV-1A — TaskAssessment as a PURE PROJECTION + Evidence Freshness.
 *
 * The task checklist the model maintains through task_set is a SELF-REPORT:
 * an item is "done" because the model said so. This projection mechanically
 * separates that CLAIM from VERIFIED, under one frozen sentence:
 *
 *   Verified ⟹ evidenceSeq > lastRelevantMutationSeq.
 *
 * No new event kind, no core diff — the projection reads the existing
 * durable vocabulary (`deriveRecoveryPlan` is the shape precedent). The
 * classifiers are maximally conservative and reuse EC-1's certificate
 * direction verbatim:
 *
 * - MUTATION marker: `tool_execution_started` (intent-to-effect) of any
 *   name NOT in `sharedTools`. Started — not the receipt — so failed and
 *   crash-window executions invalidate too, and pre-EC-1 overlap eras are
 *   covered by the same rule. Absence of a certificate is a mutation.
 *   ONE proven exception (TV-1B, grounded in WR-1A): an execution whose
 *   terminal receipt is failed(errorKind:"precondition") never counts —
 *   that kind's frozen contract is "work refused BEFORE it starts".
 * - EVIDENCE: only receipts (`tool_execution_succeeded`) of names in
 *   `evidenceTools`. Default ∅ — the projection never invents evidence.
 *   What TV-1A's verdict asserts is POSITIONAL: the arc's last
 *   intent-to-effect was a successful evidence-class run — an "evidence",
 *   never a "proof" (semantic knowledge is the TV-1B driver's).
 * - task_set itself never invalidates: recording the claim after the check
 *   is the natural arc (tests → mark done), and the claim-recording act
 *   mutates nothing the evidence observed.
 */

import type { Event } from "@vincemakes/kiso-core";

/** One item of the model's plan, exactly as last claimed. */
export interface TaskClaim {
	readonly text: string;
	readonly status: "pending" | "active" | "done";
}

/** The freshness verdict. `stale` and `unreadable` NAME their cause. */
export type EvidenceVerdict =
	| { readonly kind: "verified"; readonly evidenceSeq: number }
	| { readonly kind: "stale"; readonly evidenceSeq: number; readonly invalidatedBySeq: number }
	| { readonly kind: "none" }
	| { readonly kind: "unreadable"; readonly atSeq: number; readonly reason: string };

export interface TaskAssessment {
	/** The LAST successful task_set echo, parsed — the model's claims. */
	readonly claims: readonly TaskClaim[];
	/** True only for a non-empty plan whose every item is claimed done. */
	readonly allClaimedDone: boolean;
	readonly lastTaskSetSeq: number | null;
	/** Seq of the last mutation-class `tool_execution_started`, if any. */
	readonly lastMutationSeq: number | null;
	readonly evidence: EvidenceVerdict;
}

const TASK_TOOL = "task_set";
const STATUSES = new Set(["pending", "active", "done"]);
const COUNT_LINE = /^\[task\] (\d+) items? — (\d+) pending, (\d+) active, (\d+) done$/;
const ITEM_LINE = /^\[(\w+)\] (.*)$/;

/** Parse the canonical task_set echo (the frozen content contract the
 *  checklist cell also reads). Returns the claims, or the reason it
 *  cannot — never a guess. */
function parseEcho(content: string): { claims: TaskClaim[] } | { reason: string } {
	const lines = content.split("\n");
	const head = COUNT_LINE.exec(lines[0] ?? "");
	if (head === null) return { reason: "line 1 is not the [task] count line" };
	const total = Number(head[1]);
	const declared = { pending: Number(head[2]), active: Number(head[3]), done: Number(head[4]) };
	const claims: TaskClaim[] = [];
	for (let i = 1; i < lines.length; i += 1) {
		const m = ITEM_LINE.exec(lines[i]!);
		if (m === null || !STATUSES.has(m[1]!)) return { reason: `line ${i + 1} is not a [pending|active|done] item line` };
		claims.push({ text: m[2]!, status: m[1] as TaskClaim["status"] });
	}
	const counts = { pending: 0, active: 0, done: 0 };
	for (const c of claims) counts[c.status] += 1;
	if (claims.length !== total || counts.pending !== declared.pending || counts.active !== declared.active || counts.done !== declared.done) {
		return { reason: "the count line disagrees with the item lines" };
	}
	return { claims };
}

/**
 * Assess the task claims and their evidence freshness over a durable
 * trajectory. Pure: same events, same options, same assessment.
 */
export function assessTasks(
	events: readonly Event[],
	opts?: {
		/** Names whose executions never mutate (from `effects.concurrency:
		 *  "shared"` certificates). Default ∅ — everything mutates. */
		readonly sharedTools?: ReadonlySet<string>;
		/** Names whose successful receipts count as evidence. Default ∅ —
		 *  nothing does. */
		readonly evidenceTools?: ReadonlySet<string>;
	},
): TaskAssessment {
	const shared = opts?.sharedTools ?? new Set<string>();
	const evidenceNames = opts?.evidenceTools ?? new Set<string>();

	// TV-1B: PASS 1 — executions whose terminal receipt is a
	// PRECONDITION failure are PROVEN no-mutation (WR-1A froze that
	// contract: work refused before it starts). Everything else stays
	// conservative: no receipt (crash window), fatal/transient/
	// invalid_input, success, and legacy receipts with no errorKind.
	// Two passes, no temporal rollback state — same events, same verdict.
	const provenNoMutation = new Set<string>();
	for (const ev of events) {
		if (ev.type === "tool_execution_failed" && ev.errorKind === "precondition") {
			provenNoMutation.add(ev.executionId);
		}
	}

	const nameByExecution = new Map<string, string>();
	let claims: readonly TaskClaim[] = [];
	let lastTaskSetSeq: number | null = null;
	let unreadable: { atSeq: number; reason: string } | null = null;
	let lastMutationSeq: number | null = null;
	let lastEvidenceSeq: number | null = null;
	let staleBySeq: number | null = null;

	for (const ev of events) {
		if (ev.type === "tool_execution_started") {
			nameByExecution.set(ev.executionId, ev.name);
			if (ev.name !== TASK_TOOL && !shared.has(ev.name) && !provenNoMutation.has(ev.executionId)) {
				lastMutationSeq = ev.seq;
				if (lastEvidenceSeq !== null && staleBySeq === null) staleBySeq = ev.seq;
			}
		} else if (ev.type === "tool_execution_succeeded") {
			const name = nameByExecution.get(ev.executionId);
			if (name === TASK_TOOL) {
				const parsed = parseEcho(ev.result.content);
				if ("reason" in parsed) {
					unreadable = { atSeq: ev.seq, reason: parsed.reason };
					claims = [];
					lastTaskSetSeq = ev.seq;
				} else {
					unreadable = null;
					claims = parsed.claims;
					lastTaskSetSeq = ev.seq;
				}
			} else if (name !== undefined && evidenceNames.has(name)) {
				// a fresh evidence receipt supersedes both the older evidence
				// AND any staleness its own start incurred.
				lastEvidenceSeq = ev.seq;
				staleBySeq = null;
			}
		}
	}

	const allClaimedDone = claims.length > 0 && claims.every((c) => c.status === "done");
	let evidence: EvidenceVerdict;
	if (unreadable !== null) {
		evidence = { kind: "unreadable", atSeq: unreadable.atSeq, reason: unreadable.reason };
	} else if (lastEvidenceSeq === null) {
		evidence = { kind: "none" };
	} else if (staleBySeq !== null) {
		evidence = { kind: "stale", evidenceSeq: lastEvidenceSeq, invalidatedBySeq: staleBySeq };
	} else {
		evidence = { kind: "verified", evidenceSeq: lastEvidenceSeq };
	}
	return { claims, allClaimedDone, lastTaskSetSeq, lastMutationSeq, evidence };
}
