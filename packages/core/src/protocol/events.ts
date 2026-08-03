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

/**
 * The explicit boundary of an assistant message (D 组). Adapters never emit
 * these (their implicit boundaries — tool_result/user_input/terminal — are
 * enough); the seed encoder uses them so ADJACENT assistant messages and
 * EMPTY assistant messages round-trip losslessly.
 */
export interface AssistantStart {
	readonly seq: number;
	readonly type: "assistant_start";
	readonly source?: import("./messages.js").MessageSource;
}

export interface AssistantEnd {
	readonly seq: number;
	readonly type: "assistant_end";
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
	/** Full content — blocks preserved losslessly (D 组). */
	readonly content: string | readonly import("./messages.js").ContentBlock[];
	readonly isError: boolean;
	/** Present only when `isError` is true and the handler classified it. */
	readonly errorKind?: ToolErrorKind;
	/** The execution that produced this result (B 组) — receipt pairing key. */
	readonly executionId?: string;
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
 * Compaction happened at this point in the trajectory. The EXACT
 * replacements are persisted; the projection applies them verbatim — it
 * never re-runs a future version of the compaction algorithm (A 组/D 组).
 * The replay therefore equals the live run byte for byte, independent of
 * algorithm drift.
 *
 * 五: `eventSeq` is the STABLE identity — the seq of the specific
 * `tool_result` event that was replaced. The provider callId may repeat
 * across runs and is correlation-only; `callId` is kept for traceability.
 * Only THIS turn's NEWLY cleared results are listed, never a cumulative
 * set of already-cleared markers (五).
 *
 * 第四轮: `eventSeq` is OPTIONAL because sessions written by round three
 * (v1) carry `{callId, content}` entries without it. Those are legal and
 * replay with v1 semantics (replace every tool result with that callId,
 * exactly as the old framework did); records written from now on always
 * carry the eventSeq and replace exactly one result.
 */
export interface CompactedEvent {
	readonly seq: number;
	readonly type: "compacted";
	readonly cleared: readonly { readonly eventSeq?: number; readonly callId: string; readonly content: string }[];
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
	/** 八: the tags ride on the durable RECEIPT so a crash-window repair
	 *  of the tool_result can reproduce the normal path losslessly. */
	readonly tags?: readonly string[];
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
	/** 八: tags on the durable receipt, preserved across crash-window repair. */
	readonly tags?: readonly string[];
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
	/** The invocation this decision binds to (B 组). */
	readonly callId?: string;
	readonly decision: "approved" | "denied";
	readonly reason?: string;
}

/**
 * A permission request was CLOSED because its run terminated first (B 组):
 * an aborted/completed/error run's dangling approval is dead — it is never
 * re-presented and a late approve() cannot resurrect the run.
 */
export interface PermissionExpired {
	readonly seq: number;
	readonly type: "permission_expired";
	readonly decisionId: string;
	readonly reason: string;
}

/**
 * A non-idempotent execution FAILED and the run PAUSES until a human
 * decides (C 组): no next model turn, no sibling tool, no auto-retry. The
 * verdict is recorded by the session (resolveUncertain) and the ledger
 * transitions uncertain → rerun/abandoned; the event itself is the durable
 * pause marker.
 */
export interface UncertainPending {
	readonly seq: number;
	readonly type: "uncertain_pending";
	readonly executionId: string;
	readonly callId: string;
	readonly name: string;
	readonly error: string;
}

/**
 * A user input was VETOED or REWRITTEN by the harness (C 组). `replaces`
 * is the seq of the original user_input; the projection skips the original
 * and, when `content` is non-null, produces the replacement instead — the
 * rewritten fact is the ONLY fact every later turn sees. null content = a
 * true veto (the model never receives the message).
 */
export interface UserInputReplaced {
	readonly seq: number;
	readonly type: "user_input_replaced";
	readonly replaces: number;
	readonly content: string | readonly import("./messages.js").ContentBlock[] | null;
	/** Provenance of the replacement — preserved from the hook (三). */
	readonly source?: import("./messages.js").MessageSource;
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
	| AssistantStart
	| AssistantEnd
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
	| PermissionExpired
	| UncertainPending
	| UserInputReplaced
	| TerminalEvent;

// ── deep-shape helpers (五): every variant is validated field by field —
// legal enums, Terminal union members, Usage known/token combos, content
// blocks, plain-object inputs, optional fields when present. A record that
// parses as JSON but violates its variant's shape is corruption, never
// history.

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const STOP_REASONS = new Set<StopReason>([
	"end_turn",
	"tool_use",
	"max_tokens",
	"stop_sequence",
	"abort",
	"error",
	"refusal",
	"pause_turn",
	"content_filter",
	"context_window",
	"function_call",
]);

const TOOL_ERROR_KINDS = new Set<ToolErrorKind>(["invalid_input", "precondition", "transient", "fatal"]);

const ERROR_CODES = new Set<ErrorCode>([
	"rate_limit",
	"overloaded",
	"network",
	"timeout",
	"quota",
	"api_5xx",
	"context_overflow",
	"invalid_request",
	"unknown",
]);

const MESSAGE_SOURCES = new Set<import("./messages.js").MessageSource>([
	"user",
	"suggestion",
	"tool_result",
	"subagent",
	"system",
	"model",
]);

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * A ContentBlock: text (text: string) or image (sourceType with the
 * documented payload — url for "url", data + mediaType for "base64").
 */
function isContentBlock(v: unknown): boolean {
	if (!isPlainObject(v)) return false;
	if (v.type === "text") return typeof v.text === "string";
	if (v.type !== "image") return false;
	if (v.sourceType !== "url" && v.sourceType !== "base64") return false;
	if (v.sourceType === "url") return typeof v.url === "string";
	return typeof v.data === "string" && typeof v.mediaType === "string" && MEDIA_TYPES.has(v.mediaType);
}

/** string content, or an array whose EVERY element is a legal ContentBlock. */
function isContent(v: unknown): boolean {
	return typeof v === "string" || (Array.isArray(v) && v.every(isContentBlock));
}

function isSource(v: Record<string, unknown>): boolean {
	return v.source === undefined || MESSAGE_SOURCES.has(v.source as import("./messages.js").MessageSource);
}

function isTags(v: Record<string, unknown>): boolean {
	return v.tags === undefined || (Array.isArray(v.tags) && v.tags.every((t) => typeof t === "string"));
}

function isErrorKind(v: Record<string, unknown>): boolean {
	return v.errorKind === undefined || TOOL_ERROR_KINDS.has(v.errorKind as ToolErrorKind);
}

function isExecutionId(v: Record<string, unknown>): boolean {
	return v.executionId === undefined || typeof v.executionId === "string";
}

/** A StructuredError — the shape the `error` terminal carries. */
function isStructuredError(v: unknown): boolean {
	if (!isPlainObject(v)) return false;
	return (
		ERROR_CODES.has(v.code as ErrorCode) &&
		typeof v.retryable === "boolean" &&
		typeof v.message === "string" &&
		(v.status === undefined || typeof v.status === "number")
	);
}

/** Terminal union members validated by their own required fields. */
function isTerminal(v: unknown): boolean {
	if (!isPlainObject(v)) return false;
	switch (v.kind) {
		case "completed":
		case "max_tokens":
			return true;
		case "max_turns":
			return typeof v.turns === "number";
		case "error":
			return isStructuredError(v.error);
		case "aborted":
			return v.by === "user" || v.by === "parent";
		case "hook_stopped":
			return typeof v.hook === "string";
		default:
			return false;
	}
}

/**
 * Usage invariant (Area 6): `known: false` means the provider reported NO
 * usage — every token field is null, never faked as zero. `known: true`
 * means SOME usage was reported; each field is a non-negative number when
 * the provider reported it, null otherwise.
 */
function isUsage(v: Record<string, unknown>): boolean {
	if (typeof v.known !== "boolean") return false;
	const tokens = [v.inputTokens, v.outputTokens, v.cacheRead, v.cacheWrite];
	if (v.known === false) return tokens.every((t) => t === null);
	return tokens.every((t) => t === null || (typeof t === "number" && t >= 0));
}

/**
 * Per-variant runtime validation (五): the table is
 * `satisfies Record<Event["type"], ...>` — adding a variant without a
 * validator here is a compile error (ADR-0003).
 */
const EVENT_VALIDATORS = {
	assistant_start: (v: Record<string, unknown>) => isSource(v),
	assistant_end: () => true,
	text_start: (v: Record<string, unknown>) => isSource(v),
	text_delta: (v: Record<string, unknown>) => typeof v.text === "string",
	text_end: () => true,
	tool_call_start: (v: Record<string, unknown>) =>
		typeof v.callId === "string" && typeof v.name === "string" && isSource(v),
	tool_call_input_delta: (v: Record<string, unknown>) =>
		typeof v.callId === "string" && typeof v.inputJsonDelta === "string",
	tool_call_end: (v: Record<string, unknown>) =>
		typeof v.callId === "string" && typeof v.name === "string" && (v.input === null || isPlainObject(v.input)),
	tool_result: (v: Record<string, unknown>) =>
		typeof v.callId === "string" &&
		isContent(v.content) &&
		typeof v.isError === "boolean" &&
		isErrorKind(v) &&
		isExecutionId(v) &&
		isSource(v) &&
		isTags(v),
	thinking: (v: Record<string, unknown>) => typeof v.text === "string",
	usage: isUsage,
	stop: (v: Record<string, unknown>) => STOP_REASONS.has(v.reason as StopReason),
	user_input: (v: Record<string, unknown>) => isContent(v.content) && isSource(v),
	compacted: (v: Record<string, unknown>) =>
		Array.isArray(v.cleared) &&
		v.cleared.every(
			(c) =>
				isPlainObject(c) &&
				// 第四轮: eventSeq is optional — v1 (round three) entries are
				// {callId, content} and remain legal; v2 entries must carry a
				// valid eventSeq.
				(c.eventSeq === undefined || isNonNegativeInt(c.eventSeq)) &&
				typeof c.callId === "string" &&
				typeof c.content === "string",
		),
	tool_execution_started: (v: Record<string, unknown>) =>
		typeof v.executionId === "string" &&
		typeof v.callId === "string" &&
		typeof v.name === "string" &&
		isPlainObject(v.input),
	tool_execution_succeeded: (v: Record<string, unknown>) =>
		typeof v.executionId === "string" &&
		typeof v.callId === "string" &&
		isPlainObject(v.result) &&
		typeof (v.result as Record<string, unknown>).content === "string" &&
		(v.result as Record<string, unknown>).isError === false &&
		isTags(v),
	tool_execution_failed: (v: Record<string, unknown>) =>
		typeof v.executionId === "string" &&
		typeof v.callId === "string" &&
		typeof v.error === "string" &&
		typeof v.safeToRetry === "boolean" &&
		isErrorKind(v) &&
		isTags(v),
	tool_execution_resolved: (v: Record<string, unknown>) =>
		typeof v.executionId === "string" &&
		typeof v.callId === "string" &&
		(v.resolution === "rerun" || v.resolution === "abandoned"),
	permission_requested: (v: Record<string, unknown>) =>
		typeof v.decisionId === "string" &&
		typeof v.callId === "string" &&
		typeof v.name === "string" &&
		isPlainObject(v.input),
	permission_decided: (v: Record<string, unknown>) =>
		typeof v.decisionId === "string" &&
		(v.decision === "approved" || v.decision === "denied") &&
		(v.callId === undefined || typeof v.callId === "string") &&
		(v.reason === undefined || typeof v.reason === "string"),
	permission_expired: (v: Record<string, unknown>) => typeof v.decisionId === "string" && typeof v.reason === "string",
	uncertain_pending: (v: Record<string, unknown>) =>
		typeof v.executionId === "string" && typeof v.callId === "string" && typeof v.name === "string" && typeof v.error === "string",
	user_input_replaced: (v: Record<string, unknown>) =>
		isNonNegativeInt(v.replaces) && (v.content === null || isContent(v.content)) && isSource(v),
	terminal: (v: Record<string, unknown>) => isTerminal(v.outcome),
} satisfies Record<Event["type"], (v: Record<string, unknown>) => boolean>;

/**
 * Runtime type guard for the union. The store validates every JSONL record
 * with it: valid JSON that is not a kiso event is corruption, not history.
 */
export function isKisoEvent(value: unknown): value is Event {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.type !== "string" || !isNonNegativeInt(v.seq)) return false;
	const validate = EVENT_VALIDATORS[v.type as Event["type"]];
	return validate !== undefined && validate(v);
}
