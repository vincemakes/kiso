/**
 * L1 — the event sum type.
 *
 * The kernel emits a stream of these. Adapters translate provider-specific
 * wire events INTO these. Surfaces (TUI, web, logs) consume these.
 *
 * WHY a discriminated union instead of `{type: string, ...unknown}`:
 * every consumer gets exhaustiveness checking for free. Add a variant and
 * TypeScript breaks every `switch` that forgot it — which is exactly the
 * moment you want to be interrupted. A loose record defers that failure
 * to production.
 *
 * See ADR-0003. Read it before changing anything in this file.
 *
 * This module is types-only: it compiles to nothing.
 */

/** Why the model stopped producing. */
export type StopReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "stop_sequence"
	| "abort"
	| "error";

/**
 * Structured failure classification, layered ON TOP OF `isError: boolean`.
 * It carries WHY a tool failed, not merely THAT it failed.
 * Only meaningful when `isError` is true.
 *
 * - `invalid_input` — arguments are malformed or fail the schema.
 * - `precondition`  — the tool REFUSED to run because a gate was not met.
 *                     It never attempted the work. This is the slot that
 *                     separates "refused" from "ran and produced nothing" —
 *                     a distinction most harnesses collapse, and then cannot
 *                     tell a blocked agent from an unproductive one.
 * - `transient`     — retriable (network blip, rate limit).
 * - `fatal`         — unrecoverable (handler threw, invariant broken).
 *
 * The kernel never branches on this value. It is a pass-through signal for
 * the harness above; retry and re-route policy stay product-side.
 *
 * See ADR-0020.
 */
export type ToolErrorKind = "invalid_input" | "precondition" | "transient" | "fatal";

/**
 * A new assistant text block begins.
 * Surfaces should open a new paragraph. Subsequent `TextDelta` events with no
 * intervening `TextStart` belong to the same block.
 */
export interface TextStart {
	readonly type: "text_start";
}

export interface TextDelta {
	readonly type: "text_delta";
	readonly text: string;
}

export interface ToolCallStart {
	readonly type: "tool_call_start";
	readonly callId: string;
	readonly name: string;
}

/**
 * Incremental JSON characters for one call's arguments.
 *
 * Concatenating every delta for the same `callId` yields the JSON document the
 * model emitted. It is NOT valid JSON until `ToolCallEnd` — consumers that
 * parse mid-stream must tolerate failure, or wait.
 */
export interface ToolCallInputDelta {
	readonly type: "tool_call_input_delta";
	readonly callId: string;
	readonly inputJsonDelta: string;
}

/**
 * The model finished describing this call.
 * `input` is the parsed document, or `null` when parsing failed — the kernel
 * then decides whether to repair or reject. Adapters never repair silently:
 * a null here is a fact about the model's output, not a defect to hide.
 */
export interface ToolCallEnd {
	readonly type: "tool_call_end";
	readonly callId: string;
	readonly input: Readonly<Record<string, unknown>> | null;
}

/**
 * Emitted by the KERNEL (never by an adapter) once a handler returns.
 * The next `adapter.stream()` call translates it back into a provider message.
 */
export interface ToolResultEvent {
	readonly type: "tool_result";
	readonly callId: string;
	readonly content: string;
	readonly isError: boolean;
	/** Present only when `isError` is true and the handler classified it. */
	readonly errorKind?: ToolErrorKind;
}

/** Extended-thinking content. Providers without it emit nothing here. */
export interface Thinking {
	readonly type: "thinking";
	readonly text: string;
}

/**
 * Token accounting.
 * INVARIANT: at least one `Usage` MUST precede each `Stop`. A turn that cannot
 * report its cost is a turn you cannot bill, cap, or trust.
 */
export interface Usage {
	readonly type: "usage";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface Stop {
	readonly type: "stop";
	readonly reason: StopReason;
}

/**
 * The union. Consume it with a `switch (event.type)`; with
 * `strictNullChecks` on, an unhandled variant is a compile error.
 */
export type Event =
	| TextStart
	| TextDelta
	| ToolCallStart
	| ToolCallInputDelta
	| ToolCallEnd
	| ToolResultEvent
	| Thinking
	| Usage
	| Stop;
