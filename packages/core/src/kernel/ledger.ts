/**
 * L2 — the execution ledger: exactly-once side effects from the event log.
 *
 * Phase D. Every tool execution writes `tool_execution_started` before the
 * handler and `tool_execution_succeeded` / `tool_execution_failed` after
 * (kernel/loop.ts). From those events alone — no second store — this module
 * answers the two questions recovery needs:
 *
 *   1. What is the durable status of call X? (`executionLedger`)
 *   2. Has this tool+input ever reached a terminal state? (`latestExecutionFor`)
 *
 * Status derivation per call:
 *   started, no result yet      → "uncertain"   (interrupted: human decision)
 *   succeeded                   → "succeeded"   (never re-run, non-idempotent)
 *   failed                      → "failed"      (a failed attempt ran nothing)
 *   resolved "rerun"            → "rerun"       (human cleared it: may run)
 *   resolved "abandoned"        → "abandoned"   (human killed it: always blocked)
 */

import type { Event, ToolResultEvent } from "../protocol/events.js";

export type ExecutionStatus = "uncertain" | "succeeded" | "failed" | "rerun" | "abandoned";

export interface ExecutionRecord {
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly status: ExecutionStatus;
	/** Present when `status` is "succeeded" — the durable result to replay. */
	readonly result?: { readonly content: string; readonly isError: false };
	readonly error?: string;
}

/** callId → durable status, rebuilt purely from events (ADR-0002). */
export function executionLedger(events: readonly Event[]): Map<string, ExecutionRecord> {
	const ledger = new Map<string, ExecutionRecord>();
	for (const ev of events) {
		switch (ev.type) {
			case "tool_execution_started":
				ledger.set(ev.callId, {
					callId: ev.callId,
					name: ev.name,
					input: ev.input,
					status: "uncertain",
				});
				break;
			case "tool_execution_succeeded": {
				const prior = ledger.get(ev.callId);
				if (prior) {
					ledger.set(ev.callId, { ...prior, status: "succeeded", result: ev.result });
				}
				break;
			}
			case "tool_execution_failed": {
				const prior = ledger.get(ev.callId);
				if (prior) {
					ledger.set(ev.callId, {
						...prior,
						status: "failed",
						...(ev.error !== undefined ? { error: ev.error } : {}),
					});
				}
				break;
			}
			case "tool_execution_resolved": {
				const prior = ledger.get(ev.callId);
				if (prior) {
					ledger.set(ev.callId, {
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

/**
 * The latest durable execution of a tool with this exact input, across
 * calls — the key the exactly-once guard matches on. Call ids are
 * provider-chosen and never repeat, so the side effect is identified by
 * (name, input), not by call id.
 */
export function latestExecutionFor(
	events: readonly Event[],
	name: string,
	input: Readonly<Record<string, unknown>>,
): ExecutionRecord | undefined {
	const key = stableKey(input);
	const ledger = executionLedger(events);
	let found: ExecutionRecord | undefined;
	for (const ev of events) {
		if (ev.type !== "tool_execution_started") continue;
		if (ev.name !== name) continue;
		if (stableKey(ev.input) !== key) continue;
		found = ledger.get(ev.callId);
	}
	return found;
}

/** Order-insensitive JSON key for input equality. */
function stableKey(value: unknown): string {
	const sorted = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sorted);
		if (typeof v === "object" && v !== null) {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				out[k] = sorted((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		return v;
	};
	return JSON.stringify(sorted(value));
}

export type { ToolResultEvent };
