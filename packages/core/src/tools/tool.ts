/**
 * L3 — the tool contract.
 *
 * A tool is a pure declaration + handler pair. The kernel never branches on
 * a tool's internals: `parameters` is a JSON Schema the kernel validates and
 * projects to the adapter as `ToolSpec` (adapter never sees the handler —
 * see ADR-0001), `concurrencySafe` decides batch scheduling, `delivers`
 * marks a tool as an artifact producer (consumed by harness-side delivery
 * tracking; the kernel only carries the flag).
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
	 * Per-call concurrency predicate — a shape the reference implementation's
	 * static executionMode cannot express: the same tool may be parallel-safe for one
	 * input and must be serial for another (generate_image with
	 * `chain_to_previous`). Absent = safe when true-ish; see ADR-0015.
	 */
	readonly concurrencySafe?: (input: I) => boolean;
	/** Marks this tool as an artifact producer (harness-side delivery truth). */
	readonly delivers?: { readonly kind: string };
	/**
	 * Exactly-once guard escape hatch (Phase D): a tool whose side effects
	 * are safe to repeat (reads, searches, pure computations) declares
	 * `idempotent: true`. Without it, the kernel refuses to run the same
	 * tool+input twice in a session — a confirmed success is replayed, an
	 * interrupted attempt blocks. The default is the safe side.
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
