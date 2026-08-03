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
 * This module is almost types-only: the only runtime value it emits is
 * `isKisoEvent`, the type guard the session store validates records with.
 */

/**
 * Why the model stopped producing. Provider-specific reasons are mapped at
 * the ADAPTER boundary into this closed union (Area 6) — `refusal`,
 * `pause_turn`, `content_filter`, and `context_window` are never allowed
 * to degrade into a normal `end_turn`. A new SDK enum that lacks a mapping
 * is a compile error in the adapters' exhaustive switches.
 */
export type StopReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "stop_sequence"
	| "abort"
	| "error"
	| "refusal"
	| "pause_turn"
	| "content_filter"
	| "context_window"
	| "function_call";

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
	/** Provenance of the assistant message this block belongs to (Area 6). */
	readonly source?: import("./messages.js").MessageSource;
}

export interface TextDelta {
	readonly seq: number;
	readonly type: "text_delta";
	readonly text: string;
}

/**
 * The assistant text block closes. Surfaces flush the paragraph here; a
 * block without an explicit end is closed by the next `TextStart` or the
 * terminal. Adapters may omit it; the union admits it so fixtures and
 * replayable trajectories can carry the boundary explicitly (design v3 §4.1).
 */
export interface TextEnd {
	readonly seq: number;
	readonly type: "text_end";
}

export interface ToolCallStart {
	readonly seq: number;
	readonly type: "tool_call_start";
	readonly callId: string;
	readonly name: string;
	/** Provenance of the assistant message this call belongs to (Area 6). */
	readonly source?: import("./messages.js").MessageSource;
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
	/** The tool being called — the registry lookup key. */
	readonly name: string;
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
	/** Provenance + product tags — preserved losslessly (Area 6). */
	readonly source?: import("./messages.js").MessageSource;
	readonly tags?: readonly string[];
}

/**
 * A human/user input entered the run. Emitted by the harness (session layer)
 * or by the loop's seed encoder — never by a provider. This is what makes a
 * trajectory self-contained: ADR-0002's replay of `seq` 0..N must include the
 * prompts, or the run cannot be rebuilt from its own log.
 */
export interface UserInputEvent {
	readonly seq: number;
	readonly type: "user_input";
	readonly content: string | readonly import("./messages.js").ContentBlock[];
	/** Provenance of the prompt (Area 6) — preserved losslessly. */
	readonly source?: import("./messages.js").MessageSource;
}

/**
 * Compaction happened at this point in the trajectory. The projection
 * re-applies microcompact here (idempotent by contract), so the replay and
 * the live run see the same history. `clearedCallIds` is the audit trail.
 */
export interface CompactedEvent {
	readonly seq: number;
	readonly type: "compacted";
	readonly clearedCallIds: readonly string[];
}

/**
 * A tool execution is about to run — the durable START of the side effect
 * (Phase D / Area 3). `executionId` is the framework-generated, persistent
 * identity of THIS logical execution; the provider's `callId` only
 * correlates messages and may repeat across runs. Written BEFORE the
 * handler is invoked, so an interruption between this event and its result
 * leaves an auditably UNCERTAIN state that requires a human decision.
 */
export interface ToolExecutionStarted {
	readonly seq: number;
	readonly type: "tool_execution_started";
	readonly executionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

/** The side effect completed successfully. A confirmed success never re-runs. */
export interface ToolExecutionSucceeded {
	readonly seq: number;
	readonly type: "tool_execution_succeeded";
	readonly executionId: string;
	readonly callId: string;
	readonly result: { readonly content: string; readonly isError: false };
}

/**
 * The side effect ran and FAILED. `safeToRetry` is the tool's own proof
 * (declared idempotent): only then is a failure a clean "failed"; a
 * non-idempotent failure may have produced a side effect and is UNCERTAIN
 * until a human decides (Area 3).
 */
export interface ToolExecutionFailed {
	readonly seq: number;
	readonly type: "tool_execution_failed";
	readonly executionId: string;
	readonly callId: string;
	readonly error: string;
	readonly errorKind?: ToolErrorKind;
	readonly safeToRetry: boolean;
}

/**
 * A human resolved an execution: "rerun" (the human takes responsibility —
 * the side effect may run again) or "abandoned" (the attempt is treated as
 * failed; the trajectory continues with a recorded denial).
 */
export interface ToolExecutionResolved {
	readonly seq: number;
	readonly type: "tool_execution_resolved";
	readonly executionId: string;
	readonly callId: string;
	readonly resolution: "rerun" | "abandoned";
}

/**
 * A permission `defer` became a real pause (Phase D): the run yields this
 * event, persists the request, and waits for the human decision. The
 * decision id is the durable handle `session.approve(decisionId, ...)`
 * resolves.
 */
export interface PermissionRequested {
	readonly seq: number;
	readonly type: "permission_requested";
	readonly decisionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

/** The durable answer to a PermissionRequested. */
export interface PermissionDecided {
	readonly seq: number;
	readonly type: "permission_decided";
	readonly decisionId: string;
	readonly decision: "approved" | "denied";
	readonly reason?: string;
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
 *
 * `known: false` means the provider reported NO usage — the token fields
 * are null, never faked as zero (Area 6).
 */
export interface Usage {
	readonly seq: number;
	readonly type: "usage";
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite: number | null;
	readonly known: boolean;
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
 * - `max_tokens`     — the provider stopped on its output budget; the model's
 *                      turn is truncated, NOT a clean completion (Phase B).
 * - `max_turns`      — the round budget was consumed.
 * - `error`          — a `StructuredError` the loop could not retry past.
 * - `aborted`        — a human (user) or the parent agent stopped it.
 * - `hook_stopped`   — a Stop-hook prevented continuation.
 */
export type Terminal =
	| { kind: "completed" }
	| { kind: "max_tokens" }
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
	| TextEnd
	| ToolCallStart
	| ToolCallInputDelta
	| ToolCallEnd
	| ToolResultEvent
	| Thinking
	| Usage
	| Stop
	| UserInputEvent
	| CompactedEvent
	| ToolExecutionStarted
	| ToolExecutionSucceeded
	| ToolExecutionFailed
	| ToolExecutionResolved
	| PermissionRequested
	| PermissionDecided
	| TerminalEvent;

/**
 * Every event type name, as a `satisfies Record<Event["type"], boolean>`:
 * adding a variant without registering it here is a compile error — the
 * store's corruption check must never drift from the union (ADR-0003).
 */
const EVENT_TYPES = {
	text_start: true,
	text_delta: true,
	text_end: true,
	tool_call_start: true,
	tool_call_input_delta: true,
	tool_call_end: true,
	tool_result: true,
	thinking: true,
	usage: true,
	stop: true,
	user_input: true,
	compacted: true,
	tool_execution_started: true,
	tool_execution_succeeded: true,
	tool_execution_failed: true,
	tool_execution_resolved: true,
	permission_requested: true,
	permission_decided: true,
	terminal: true,
} satisfies Record<Event["type"], boolean>;

/**
 * Runtime type guard for the union. The store validates every JSONL record
 * with it: valid JSON that is not a kiso event is corruption, not history.
 */
export function isKisoEvent(value: unknown): value is Event {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.type === "string" && typeof v.seq === "number" && EVENT_TYPES[v.type as Event["type"]] === true;
}
