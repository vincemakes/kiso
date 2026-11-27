/**
 * ADR-0064 § 2.2 — work state is a pure reducer over the work log. Never a
 * stored blob; `revision` is the last committed seq (WorkRevision).
 *
 * A PROBLEM is an event the reducer ignores and reports (ADR-0063 § 5.1's
 * pattern): it stays in the log, changes nothing, and `problems` names its seq
 * and rule. The ledger's API refuses the same events before writing them, so a
 * problem means something other than the API wrote the log.
 */
import type { LogLine } from "./log.js";
import { parseWorkEvent, WorkLogCorruptionError, type Authority, type WorkEvent, type WorkEvidence, type WorkQuote } from "./events.js";

export type Criterion = {
	readonly criterionId: string;
	readonly text: string;
	readonly authority: Authority;
	readonly quote?: WorkQuote;
	readonly required: boolean;
	readonly seq: number;
};

export type EvidenceRecord = { readonly evidenceId: string; readonly criterionIds: readonly string[]; readonly ref: WorkEvidence; readonly seq: number };

export type EffectStatus = "prepared" | "uncertain" | "succeeded" | "failed" | "abandoned";

export type EffectState = {
	readonly effectId: string;
	readonly workId: string;
	readonly actionDigest: string;
	readonly workRevision: number;
	readonly approvalId?: string;
	readonly label: string;
	readonly attempt: number;
	readonly status: EffectStatus;
	readonly execution?: { readonly sessionId: string; readonly executionId: string };
	readonly receipt?: string;
};

export type WorkStatus = "active" | "waiting" | "needs-human" | "verifying" | "completed" | "failed" | "cancelled";

export type Commitment = {
	readonly id: string;
	readonly actorId: string;
	readonly objective: string;
	readonly status: WorkStatus;
	readonly revision: number;
	/** The active set, after supersession. */
	readonly acceptance: readonly Criterion[];
	readonly evidence: readonly EvidenceRecord[];
	readonly effects: readonly EffectState[];
	readonly completion: Readonly<Record<Authority, { readonly met: number; readonly required: number }>>;
};

export type Problem = { readonly seq: number; readonly rule: string };

/** source may supersede target (ADR-0064 § 4). */
const RANK: Record<Authority, number> = { user: 2, system: 1, agent: 0 };
export const mayEdit = (source: Authority, target: Authority): boolean => RANK[source] >= RANK[target];

const DIGEST = /^[0-9a-f]{64}$/;

export function reduceWork(lines: readonly LogLine<unknown>[]): { readonly commitment: Commitment; readonly problems: readonly Problem[] } {
	const events = lines.map((l, i) => {
		if (l.seq !== i) throw new WorkLogCorruptionError(i, "seq gap");
		return parseWorkEvent(l.event, i);
	});
	const first = events[0];
	if (first?.type !== "work_created") throw new WorkLogCorruptionError(0, "the first event is not work_created");

	const criteria = new Map<string, Criterion>();
	const superseded = new Set<string>();
	const evidence: EvidenceRecord[] = [];
	const effects = new Map<string, EffectState>();
	const problems: Problem[] = [];
	let explicit: WorkStatus | undefined;
	let terminal: WorkStatus | undefined;

	const apply = (ev: WorkEvent, seq: number): string | null => {
		if (seq > 0 && ev.type === "work_created") return "work_created after seq 0";
		if (terminal !== undefined) return `event after ${terminal}`;
		switch (ev.type) {
			case "work_created":
				return null;
			case "acceptance_added": {
				if (criteria.has(ev.criterionId)) return "duplicate criterionId";
				if (ev.authority === "user" && ev.quote === undefined) return "a user criterion without a quote";
				if (ev.authority !== "user" && ev.quote !== undefined) return "a quote on a non-user criterion";
				criteria.set(ev.criterionId, { criterionId: ev.criterionId, text: ev.text, authority: ev.authority, ...(ev.quote ? { quote: ev.quote } : {}), required: ev.required, seq });
				// An invalid supersedes is reported; the source still commits at its own authority.
				for (const target of ev.supersedes ?? []) {
					const t = criteria.get(target);
					if (t === undefined || target === ev.criterionId || superseded.has(target)) problems.push({ seq, rule: `supersedes ${target}: no such active criterion` });
					else if (!mayEdit(ev.authority, t.authority)) problems.push({ seq, rule: `supersedes ${target}: ${ev.authority} may not supersede ${t.authority}` });
					else superseded.add(target);
				}
				return null;
			}
			case "evidence_added": {
				if (evidence.some((e) => e.evidenceId === ev.evidenceId)) return "duplicate evidenceId";
				const missing = ev.criterionIds.find((id) => !criteria.has(id));
				if (missing !== undefined) return `evidence for unknown criterion ${missing}`;
				if ("effect" in ev.ref && !effects.has(ev.ref.effect.effectId)) return "evidence names an unknown effect";
				evidence.push({ evidenceId: ev.evidenceId, criterionIds: ev.criterionIds, ref: ev.ref, seq });
				return null;
			}
			case "effect_prepared": {
				if (effects.has(ev.effectId)) return "duplicate effectId";
				if (ev.workId !== first.workId) return "effect owned by another work";
				if (ev.workRevision < 0 || ev.workRevision >= seq) return "workRevision is not an observed revision";
				if (!DIGEST.test(ev.actionDigest)) return "actionDigest is not a SHA-256 hex digest";
				const { type: _type, ...rest } = ev;
				effects.set(ev.effectId, { ...rest, attempt: 1, status: "prepared" });
				return null;
			}
			case "effect_dispatching": {
				const fx = effects.get(ev.effectId);
				if (fx === undefined) return "dispatch of an unknown effect";
				if (fx.status !== "prepared") return `dispatch from ${fx.status} (no silent retry)`;
				if (ev.attempt !== fx.attempt) return `dispatch attempt ${ev.attempt}, expected ${fx.attempt}`;
				effects.set(ev.effectId, { ...fx, status: "uncertain", ...(ev.execution ? { execution: ev.execution } : {}) });
				return null;
			}
			case "effect_resolved": {
				const fx = effects.get(ev.effectId);
				if (fx === undefined) return "resolution of an unknown effect";
				if (ev.attempt !== fx.attempt) return `resolution of attempt ${ev.attempt}, current is ${fx.attempt}`;
				const receipt = ev.receipt !== undefined ? { receipt: ev.receipt } : {};
				if (ev.outcome === "succeeded" || ev.outcome === "failed") {
					if (fx.status !== "uncertain") return `${ev.outcome} from ${fx.status}`;
					if (ev.by === "human") return `${ev.outcome} by human: an outcome comes from a receipt or the host`;
					effects.set(ev.effectId, { ...fx, status: ev.outcome, ...receipt });
					return null;
				}
				if (ev.outcome === "rerun") {
					if (fx.status !== "uncertain" || ev.by !== "human") return "rerun only by a human, only from uncertain";
					effects.set(ev.effectId, { ...fx, status: "prepared", attempt: fx.attempt + 1, ...receipt });
					return null;
				}
				// abandoned: a human rules on an uncertain effect; an undispatched one may be withdrawn by a human or the host
				if (fx.status === "uncertain" ? ev.by !== "human" : fx.status !== "prepared" || ev.by === "receipt") return `abandoned from ${fx.status} by ${ev.by}`;
				effects.set(ev.effectId, { ...fx, status: "abandoned", ...receipt });
				return null;
			}
			case "state_changed":
				explicit = ev.to;
				return null;
			case "completed": {
				const open = [...effects.values()].find((fx) => fx.status === "prepared" || fx.status === "uncertain");
				if (open !== undefined) return `completion with effect ${open.effectId} ${open.status}`;
				const unmet = active().find((c) => c.required && !evidenced(c.criterionId));
				if (unmet !== undefined) return `completion with criterion ${unmet.criterionId} unevidenced`;
				terminal = "completed";
				return null;
			}
			case "failed":
			case "cancelled":
				terminal = ev.type;
				return null;
		}
	};
	const active = (): Criterion[] => [...criteria.values()].filter((c) => !superseded.has(c.criterionId));
	const evidenced = (id: string): boolean => evidence.some((e) => e.criterionIds.includes(id));

	events.forEach((ev, seq) => {
		const rule = apply(ev, seq);
		if (rule !== null) problems.push({ seq, rule });
	});

	const fx = [...effects.values()];
	const status: WorkStatus = terminal ?? (fx.some((e) => e.status === "uncertain") ? "needs-human" : (explicit ?? "active"));
	const completion = { user: { met: 0, required: 0 }, system: { met: 0, required: 0 }, agent: { met: 0, required: 0 } };
	for (const c of active()) {
		if (!c.required) continue;
		completion[c.authority].required++;
		if (evidenced(c.criterionId)) completion[c.authority].met++;
	}
	return {
		commitment: {
			id: first.workId,
			actorId: first.actorId,
			objective: first.objective,
			status,
			revision: lines.length - 1,
			acceptance: active(),
			evidence,
			effects: fx,
			completion,
		},
		problems,
	};
}
