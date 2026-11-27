/**
 * ADR-0064 § 3 — the work-log events (the A1 subset of the actor RFC § 5.1)
 * and their strict reader. An unknown type, a missing field or an unknown
 * `format` is corruption, never something to skip: a later stage adds events
 * and fields by bumping WORK_LOG_FORMAT, and an older reader refuses.
 */
import type { EvidenceOwner, EvidenceRef } from "@vincemakes/kiso-runtime/evidence";

export type { EvidenceOwner, EvidenceRef };

export const WORK_LOG_FORMAT = 1;

export type Authority = "user" | "system" | "agent";
export type WorkQuote = { readonly owner: EvidenceOwner; readonly seq: number; readonly span: string };

export type WorkEvidence =
	| { readonly log: EvidenceRef }
	| { readonly effect: { readonly effectId: string } }
	| { readonly external: { readonly source: string; readonly observedAt: number; readonly digest?: string } };

export type WorkEvent =
	| { readonly type: "work_created"; readonly format: number; readonly workId: string; readonly actorId: string; readonly objective: string }
	| {
			readonly type: "acceptance_added";
			readonly criterionId: string;
			readonly text: string;
			readonly authority: Authority;
			readonly quote?: WorkQuote;
			readonly required: boolean;
			readonly supersedes?: readonly string[];
	  }
	| { readonly type: "evidence_added"; readonly evidenceId: string; readonly criterionIds: readonly string[]; readonly ref: WorkEvidence; readonly note?: string }
	| {
			readonly type: "effect_prepared";
			readonly effectId: string;
			readonly workId: string;
			readonly actionDigest: string;
			readonly workRevision: number;
			readonly approvalId?: string;
			readonly label: string;
	  }
	| { readonly type: "effect_dispatching"; readonly effectId: string; readonly attempt: number; readonly execution?: { readonly sessionId: string; readonly executionId: string } }
	| {
			readonly type: "effect_resolved";
			readonly effectId: string;
			readonly attempt: number;
			readonly outcome: "succeeded" | "failed" | "rerun" | "abandoned";
			readonly by: "receipt" | "human" | "host";
			readonly receipt?: string;
	  }
	| { readonly type: "state_changed"; readonly to: "active" | "waiting" | "needs-human" | "verifying"; readonly reason: string }
	| { readonly type: "completed"; readonly summary?: string }
	| { readonly type: "failed"; readonly reason: string }
	| { readonly type: "cancelled"; readonly reason: string };

export class WorkLogCorruptionError extends Error {
	constructor(seq: number, message: string) {
		super(`work log corrupt at seq ${seq}: ${message}`);
		this.name = "WorkLogCorruptionError";
	}
}

type Raw = Record<string, unknown>;
const str = (v: unknown): boolean => typeof v === "string";
const int = (v: unknown): boolean => Number.isInteger(v);
const opt = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v);
const strs = (v: unknown): boolean => Array.isArray(v) && v.every(str);
const oneOf =
	(...xs: string[]) =>
	(v: unknown): boolean =>
		typeof v === "string" && xs.includes(v);
const owner = (v: unknown): boolean => typeof v === "string" && /^(session|work)\/[A-Za-z0-9._-]+$/.test(v);
const ref = (v: unknown): boolean => typeof v === "object" && v !== null && owner((v as Raw).owner) && int((v as Raw).seq);
const quote = (v: unknown): boolean => ref(v) && str((v as Raw).span);

function evidence(v: unknown): boolean {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Raw;
	const keys = Object.keys(r);
	if (keys.length !== 1) return false;
	if (keys[0] === "log") return ref(r.log);
	if (keys[0] === "effect") return typeof r.effect === "object" && r.effect !== null && str((r.effect as Raw).effectId);
	if (keys[0] === "external") {
		const x = r.external as Raw | null;
		return typeof x === "object" && x !== null && str(x.source) && typeof x.observedAt === "number" && opt(x.digest, str);
	}
	return false;
}

const SHAPES: Record<WorkEvent["type"], (e: Raw) => boolean> = {
	work_created: (e) => e.format === WORK_LOG_FORMAT && str(e.workId) && str(e.actorId) && str(e.objective),
	acceptance_added: (e) =>
		str(e.criterionId) && str(e.text) && oneOf("user", "system", "agent")(e.authority) && opt(e.quote, quote) && typeof e.required === "boolean" && opt(e.supersedes, strs),
	evidence_added: (e) => str(e.evidenceId) && strs(e.criterionIds) && evidence(e.ref) && opt(e.note, str),
	effect_prepared: (e) => str(e.effectId) && str(e.workId) && str(e.actionDigest) && int(e.workRevision) && opt(e.approvalId, str) && str(e.label),
	effect_dispatching: (e) =>
		str(e.effectId) && int(e.attempt) && opt(e.execution, (x) => typeof x === "object" && x !== null && str((x as Raw).sessionId) && str((x as Raw).executionId)),
	effect_resolved: (e) =>
		str(e.effectId) && int(e.attempt) && oneOf("succeeded", "failed", "rerun", "abandoned")(e.outcome) && oneOf("receipt", "human", "host")(e.by) && opt(e.receipt, str),
	state_changed: (e) => oneOf("active", "waiting", "needs-human", "verifying")(e.to) && str(e.reason),
	completed: (e) => opt(e.summary, str),
	failed: (e) => str(e.reason),
	cancelled: (e) => str(e.reason),
};

/** Read one stored event strictly. */
export function parseWorkEvent(raw: unknown, seq: number): WorkEvent {
	const e = raw as Raw;
	const shape = SHAPES[e.type as WorkEvent["type"]];
	if (shape === undefined) throw new WorkLogCorruptionError(seq, `unknown event type ${JSON.stringify(e.type)}`);
	if (!shape(e)) throw new WorkLogCorruptionError(seq, `malformed ${String(e.type)}`);
	return e as unknown as WorkEvent;
}
