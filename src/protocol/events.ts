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
 * `seq` — every event carries a monotonically increasing sequence number,
 * assigned by the kernel's EventLog at append time. Consumers (surfaces,
 * persistence, eval) sync by `seq`; a trajectory is the complete replay of
 * `seq` 0..N. Without `seq`, "what happened" can only be reconstructed by
 * array-shape heuristics — the exact failure Claude Code's transcript sync
 * lives in. See ADR-0002.
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
	readonly seq: number;
	readonly type: "text_start";
}

export interface TextDelta {
	readonly seq: number;
	readonly type: "text_delta";
	readonly text: string;
}

export interface ToolCallStart {
	readonly seq: number;
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
	readonly seq: number;
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
	readonly seq: number;
	readonly type: "tool_call_end";
	readonly callId: string;
	readonly input: Readonly<Record<string, unknown>> | null;
}

/**
 * Emitted by the KERNEL (never by an adapter) once a handler returns.
 * The next `adapter.stream()` call translates it back into a provider message.
 */
export interface ToolResultEvent {
	readonly seq: number;
	readonly type: "tool_result";
	readonly callId: string;
	readonly content: string;
	readonly isError: boolean;
	/** Present only when `isError` is true and the handler classified it. */
	readonly errorKind?: ToolErrorKind;
}

/** Extended-thinking content. Providers without it emit nothing here. */
export interface Thinking {
	readonly seq: number;
	readonly type: "thinking";
	readonly text: string;
}

/**
 * Token accounting.
 * INVARIANT: at least one `Usage` MUST precede each `Stop`. A turn that cannot
 * report its cost is a turn you cannot bill, cap, or trust.
 */
export interface Usage {
	readonly seq: number;
	readonly type: "usage";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface Stop {
	readonly seq: number;
	readonly type: "stop";
	readonly reason: StopReason;
}

/**
 * Structured failure classification for MODEL / TRANSPORT errors.
 *
 * Distinct from `ToolErrorKind` (which classifies a tool's own failure and
 * which the kernel never branches on): a `StructuredError` is an error the
 * LOOP itself may branch on — `retryable: true` means the loop may retry
 * (backoff, max attempts, state entirely inside the loop — see ADR-0005).
 * Adapters translate provider wire errors into this shape. No regex over
 * error strings anywhere: classification happens at the adapter boundary.
 */
export type ErrorCode =
	| "rate_limit"
	| "overloaded"
	| "network"
	| "timeout"
	| "quota"
	| "api_5xx"
	| "context_overflow"
	| "invalid_request"
	| "unknown";

export interface StructuredError {
	readonly code: ErrorCode;
	readonly status?: number;
	readonly retryable: boolean;
	readonly message: string;
}

/**
 * Why the whole run ended. The ONE terminal shape every run converges to.
 *
 * Every consumer switches on `kind`; with `exactOptionalPropertyTypes` and
 * `strictNullChecks` on, a terminal that nobody handles is a compile error,
 * not a production mystery. CC's query() returns 11 different reasons that
 * every consumer discards — here the terminal is an event like any other,
 * so it cannot be lost. See ADR-0004.
 *
 * - `completed`      — the loop ended on its own terms (no tool call, or the
 *                      mode's stop predicate fired).
 * - `max_turns`      — the round budget was consumed.
 * - `error`          — a `StructuredError` the loop could not retry past.
 * - `aborted`        — a human (user) or the parent agent stopped it.
 * - `hook_stopped`   — a Stop-hook prevented continuation.
 */
export type Terminal =
	| { kind: "completed" }
	| { kind: "max_turns"; turns: number }
	| { kind: "error"; error: StructuredError }
	| { kind: "aborted"; by: "user" | "parent" }
	| { kind: "hook_stopped"; hook: string };

/** The kernel yields exactly one of these per run, as its last event. */
export interface TerminalEvent {
	readonly seq: number;
	readonly type: "terminal";
	readonly outcome: Terminal;
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
	| Stop
	| TerminalEvent;
