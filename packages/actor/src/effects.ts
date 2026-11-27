/**
 * ADR-0064 § 3 — effect identity. The digest names what was decided on; the
 * runtime's execution ledger (ADR-0038) is the one execution identity an
 * effect run inside a tool call shares. Model text never resolves an effect.
 */
import { createHash } from "node:crypto";
import { executionLedger, type Event } from "@vincemakes/kiso-runtime";
import type { WorkEvent } from "./events.js";
import type { Commitment } from "./reducer.js";

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** SHA-256 over the action's canonical JSON (sorted keys, no whitespace). */
export function actionDigest(action: unknown): string {
	return createHash("sha256").update(canonicalJson(action)).digest("hex");
}

/**
 * The resolutions one session's execution ledger proves for this work's
 * uncertain effects dispatched in that session. A ledger "uncertain" proves
 * nothing and yields nothing.
 */
export function effectResolutions(commitment: Commitment, sessionId: string, events: readonly Event[]): WorkEvent[] {
	const ledger = executionLedger(events);
	const out: WorkEvent[] = [];
	for (const fx of commitment.effects) {
		if (fx.status !== "uncertain" || fx.execution?.sessionId !== sessionId) continue;
		const rec = ledger.get(fx.execution.executionId);
		if (rec === undefined || rec.status === "uncertain") continue;
		const receipt = `session/${sessionId}#${rec.executionId}`;
		const by = rec.status === "rerun" || rec.status === "abandoned" ? "human" : "receipt";
		out.push({ type: "effect_resolved", effectId: fx.effectId, attempt: fx.attempt, outcome: rec.status, by, receipt });
	}
	return out;
}
