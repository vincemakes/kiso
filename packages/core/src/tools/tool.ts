/**
 * L3 — the tool contract.
 *
 * A tool is a pure declaration + handler pair. The kernel never branches on
 * a tool's internals: `parameters` is a JSON Schema the kernel validates and
 * projects to the adapter as `ToolSpec` (adapter never sees the handler —
 * see ADR-0001).
 *
 * SC-1b: `concurrencySafe` and `delivers` were REMOVED at 0.12.0 by the
 * SC-1 memo's adjudication — both were declared and consulted by nothing.
 * Their absence is the honest contract; the concurrency RACE they were
 * mistaken for a defense against is a real open question and moved to EC-1,
 * which owes a mechanism that does not depend on a per-tool opt-in.
 * Delivery truth is named by the CALLER (governance/delivery.ts's
 * `DeliveryConfig.producers`), which is where it always actually lived.
 *
 * WHY JSON Schema instead of a runtime library: the kernel has zero runtime
 * dependencies (ADR-0001). Zod / TypeBox / valibot live at the harness layer;
 * a harness author converts their schema to JSON Schema once, at defineTool
 * time, and the kernel stays host- and library-agnostic.
 *
 * `ToolErrorKind` (protocol/events) rides on `ToolResult` so a refusal
 * ("precondition") is distinguishable from a failure after work began.
 */

import type { AbortSignalLike } from "../protocol/adapter.js";
import type { ToolErrorKind } from "../protocol/events.js";

/** Everything a handler needs, and nothing else. */
export interface ToolContext {
	readonly signal: AbortSignalLike;
	/** Opaque session anchor, when the harness has one. */
	readonly sessionId?: string;
	/** Free-form per-call metadata the kernel passes through untouched. */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * round 5(P1-9): a DISCRIMINATED union — `errorKind` is structurally
 * impossible on a non-error result, matching the persisted-event schema
 * (an isError:false result with an errorKind would be rejected by the
 * store's validator and poison the next load).
 */
export type ToolResult =
	| { readonly content: string; readonly isError: false; readonly tags?: readonly string[] }
	| {
			readonly content: string;
			readonly isError: true;
			/** Present only when the handler classified the failure. */
			readonly errorKind?: ToolErrorKind;
			readonly tags?: readonly string[];
	  };

export interface Tool<I = unknown> {
	readonly name: string;
	readonly description: string;
	/** JSON Schema (draft-07 subset). Validated before execute. */
	readonly parameters: Readonly<Record<string, unknown>>;
	/**
	 * The tool's own declaration that REPEATING its side effect is safe
	 * (reads, searches, pure computations).
	 *
	 * It is NOT a dedup guard. The kernel runs every logical call, including
	 * one whose (name, input) is identical to an earlier one — ADR-0024
	 * decision #2's (name, input) guard was REMOVED by ADR-0025 decision #1
	 * ("NO (name, input) dedup", kernel/loop.ts). Exactly-once is enforced
	 * by execution IDENTITY instead: a confirmed success is never
	 * re-executed (a lost model-facing result is repaired FROM the durable
	 * receipt), and an execution that STARTED without reporting — the crash
	 * window — waits for a human verdict. A FAILED execution is failed, not
	 * uncertain: a complete receipt IS the outcome (ADR-0038).
	 *
	 * What this flag actually decides, and nothing more:
	 *   - a failure from a tool that did NOT declare it carries the honest
	 *     "side effects may have partially applied; verify before retrying"
	 *     note on the result (ADR-0038 Amendment 1);
	 *   - it rides the durable receipt as `tool_execution_failed.safeToRetry`
	 *     — history only, since ADR-0038 stopped it feeding ledger status.
	 *
	 * Undeclared is the safe side: unknown idempotency means the note
	 * applies. A retry is a NEW call and re-passes the approval chain.
	 */
	readonly idempotent?: boolean;
	/** R-C: ONE line for the system prompt — the tool's role, never the
	 *  schema (the full description rides the JSON schema the provider
	 *  transmits anyway — never pay twice). */
	readonly promptSnippet?: string;
	/** R-C: bullets injected into the system prompt only while this tool is
	 *  ACTIVE (the registry's active set — deduped by the registry). */
	readonly promptGuidelines?: readonly string[];
	readonly execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<I = unknown>(tool: Tool<I>): Tool<I> {
	return tool;
}
