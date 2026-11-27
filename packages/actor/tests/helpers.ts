import type { WorkEvent } from "../src/events.js";
import type { LogLine } from "../src/log.js";

export const DIGEST = "a".repeat(64);
export const created: WorkEvent = { type: "work_created", format: 1, workId: "w1", actorId: "act", objective: "ship it" };

/** A work log from events, seq in order. */
export const lines = (...events: unknown[]): LogLine<unknown>[] => [created, ...events].map((event, seq) => ({ seq, ts: 0, event }));

export const crit = (criterionId: string, authority: "user" | "system" | "agent", extra: Record<string, unknown> = {}): WorkEvent =>
	({
		type: "acceptance_added",
		criterionId,
		text: `criterion ${criterionId}`,
		authority,
		required: true,
		...(authority === "user" ? { quote: { owner: "session/s1", seq: 0, span: "x" } } : {}),
		...extra,
	}) as WorkEvent;

export const ev = (evidenceId: string, ...criterionIds: string[]): WorkEvent => ({ type: "evidence_added", evidenceId, criterionIds, ref: { log: { owner: "session/s1", seq: 3 } } });

export const prep = (effectId: string, workRevision = 0): WorkEvent => ({ type: "effect_prepared", effectId, workId: "w1", actionDigest: DIGEST, workRevision, label: "send" });
