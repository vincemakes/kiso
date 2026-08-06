/**
 * L2 — the execution ledger: exactly-once side effects from the event log.
 *
 * Every tool execution writes `tool_execution_started` before the handler
 * and `tool_execution_succeeded` / `tool_execution_failed` after
 * (kernel/loop.ts). From those events alone — no second store — this module
 * answers the recovery questions:
 *
 *   1. What is the durable status of execution X? (`executionLedger`)
 *   2. What is the latest execution of call Y? (`executionForCallId`)
 *
 * IDENTITY (Area 3): the ledger is keyed by `executionId` — a persistent,
 * framework-generated id unique per log (one per started event). The
 * provider's `callId` is correlation only and may repeat; two logical calls
 * with identical (name, input) are two executions.
 *
 * Status derivation:
 *   started, no terminal event yet   → "uncertain"   (interrupted: human)
 *   succeeded                        → "succeeded"   (confirmed, never re-run)
 *   failed (any)                     → "failed"      (a complete receipt IS
 *                                       the outcome — ruling #12 / ADR-0038;
 *                                       safeToRetry stays on the event for
 *                                       history, it no longer feeds status)
 *   resolved "rerun"                 → "rerun"       (human cleared it)
 *   resolved "abandoned"             → "abandoned"   (human killed it)
 */

import type { Event } from "../protocol/events.js";

export type ExecutionStatus = "uncertain" | "succeeded" | "failed" | "rerun" | "abandoned";

export interface ExecutionRecord {
	readonly executionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly status: ExecutionStatus;
	/** Present when `status` is "succeeded" — the durable result to replay. */
	readonly result?: { readonly content: string; readonly isError: false };
	readonly error?: string;
}

/** executionId → durable status, rebuilt purely from events (ADR-0002). */
export function executionLedger(events: readonly Event[]): Map<string, ExecutionRecord> {
	const ledger = new Map<string, ExecutionRecord>();
	for (const ev of events) {
		switch (ev.type) {
			case "tool_execution_started":
				ledger.set(ev.executionId, {
					executionId: ev.executionId,
					callId: ev.callId,
					name: ev.name,
					input: ev.input,
					status: "uncertain",
				});
				break;
			case "tool_execution_succeeded": {
				const prior = ledger.get(ev.executionId);
				if (prior) {
					ledger.set(ev.executionId, { ...prior, status: "succeeded", result: ev.result });
				}
				break;
			}
			case "tool_execution_failed": {
				const prior = ledger.get(ev.executionId);
				if (prior) {
					ledger.set(ev.executionId, {
						...prior,
						// ruling #12 (ADR-0038): a complete receipt IS the outcome —
						// failed is "failed", never "uncertain"; uncertainty
						// belongs to the crash window alone (started, no receipt).
						status: "failed",
						...(ev.error !== undefined ? { error: ev.error } : {}),
					});
				}
				break;
			}
			case "tool_execution_resolved": {
				const prior = ledger.get(ev.executionId);
				if (prior) {
					ledger.set(ev.executionId, {
						...prior,
						status: ev.resolution === "rerun" ? "rerun" : "abandoned",
					});
				}
				break;
			}
			default:
				break;
		}
	}
	return ledger;
}

/** The LATEST execution record for a provider call id (correlation only). */
export function executionForCallId(events: readonly Event[], callId: string): ExecutionRecord | undefined {
	const ledger = executionLedger(events);
	let found: ExecutionRecord | undefined;
	for (const ev of events) {
		if (ev.type !== "tool_execution_started") continue;
		if (ev.callId !== callId) continue;
		found = ledger.get(ev.executionId);
	}
	return found;
}
