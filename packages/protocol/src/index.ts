/**
 * @vincemakes/kiso-protocol — the wire contract.
 *
 * What a client and a hosted kiso session say to each other: request
 * envelopes, wire events, the session snapshot, one error shape, a version.
 *
 * Two contracts, kept apart. The runtime's durable Event union answers
 * "what became a fact" and is frozen by ADR-0051. The wire answers "how two
 * processes talk". A wire event is a PROJECTION of a durable event — a
 * curated subset of types, an allowlist of fields per type, tool arguments
 * sanitized — and never the durable type itself, even where the shapes
 * coincide today. So the persistence contract and the transport contract
 * move on their own.
 *
 * This package imports nothing at runtime and nothing from the runtime:
 * the content-block and approval shapes below are the wire's own
 * structural copies, so a browser client never pulls kiso-runtime.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---- structural copies (the wire's own) ---------------------------------------

export interface WireTextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface WireImageBlock {
	readonly type: "image";
	readonly sourceType: "url" | "base64";
	readonly url?: string;
	readonly data?: string;
	readonly mediaType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export type WireContentBlock = WireTextBlock | WireImageBlock;
export type WireInput = string | readonly WireContentBlock[];

/** Where a user line came from — mirrors the runtime's MessageSource. */
export type WireSource = "user" | "suggestion" | "tool_result";

export interface WireApproval {
	readonly decisionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export interface WireUncertain {
	readonly executionId: string;
	readonly callId: string;
	readonly name: string;
}

// ---- requests -------------------------------------------------------------------

export interface RunRequest {
	readonly sessionId: string;
	readonly input: WireInput;
	readonly source?: WireSource;
	/** The log holds an open run from a previous process: resume it first. */
	readonly resumeFirst?: boolean;
}

/** ADR-0057: a person's input for the live run, admitted at its next Safe
 *  Admission boundary. */
export interface SteerRequest {
	readonly sessionId: string;
	readonly input: WireInput;
}

export interface ResumeRequest {
	readonly sessionId: string;
}

export interface AbortRequest {
	readonly sessionId: string;
	readonly force?: boolean;
}

export interface ApproveRequest {
	readonly sessionId: string;
	readonly decisionId: string;
	readonly allow: boolean;
	readonly reason?: string;
}

export interface ResolveUncertainRequest {
	readonly sessionId: string;
	readonly executionId: string;
	readonly resolution: "rerun" | "abandoned";
}

export interface SubscribeRequest {
	readonly sessionId: string;
	/** The last seq the client saw; −1 for everything. */
	readonly after: number;
}

// ---- replies ----------------------------------------------------------------------

export interface RunReply {
	readonly runId: string;
}

export interface SteerReply {
	readonly runId: string;
}

/** ADR-0057: the data of the non-durable `event: unadmitted` frame a stream
 *  carries right after a run's terminal — input a steer handed the run that
 *  it never admitted. The client starts a new run with it. */
export interface UnadmittedFrameData {
	readonly runId: string;
	readonly items: readonly WireInput[];
}

export interface ApproveReply {
	/** No run was live to consume the answer: the decision is durable, and
	 *  a resume is what makes the run continue. */
	readonly needsResume: boolean;
}

export interface ResolveUncertainReply {
	readonly remaining: number;
}

export type AbortReply =
	| { readonly kind: "idle" }
	| { readonly kind: "parked"; readonly runId: string; readonly approvals: readonly WireApproval[]; readonly reasons: readonly string[] }
	| { readonly kind: "stopped"; readonly runId: string };

/** What a client asks for on (re)connect, beside the stream. */
export interface SessionState {
	readonly sessionId: string;
	readonly running: boolean;
	/** The highest seq on the log; the client subscribes from here. */
	readonly highWater: number;
	/** A run a previous process left without a terminal, or null. */
	readonly openRun: string | null;
	readonly pendingApprovals: readonly WireApproval[];
	readonly uncertain: readonly WireUncertain[];
}

// ---- errors, one shape -----------------------------------------------------------

/** `idle` / `closed` (ADR-0057): a steer found no live run, or a run whose ingress had sealed. */
export type WireErrorCode = "in_flight" | "open_run" | "draining" | "idle" | "closed" | "not_found" | "bad_request" | "forbidden" | "internal";

export interface WireError {
	readonly code: WireErrorCode;
	readonly message: string;
	/** `in_flight` and `open_run` name the run. */
	readonly runId?: string;
}

// ---- wire events: the projection -------------------------------------------------

/** The durable types that reach the wire, and the wire name of each. The
 *  one rename: the void marker is `draft_voided` on the wire — a client
 *  drops everything after `voidFromSeq`; "model_output_abandoned" is the
 *  kernel's name for the same fact. */
export const DURABLE_TO_WIRE = {
	user_input: "user_input",
	user_input_replaced: "user_input_replaced",
	text_start: "text_start",
	text_delta: "text_delta",
	text_end: "text_end",
	thinking: "thinking",
	tool_call_start: "tool_call_start",
	tool_call_end: "tool_call_end",
	tool_result: "tool_result",
	tool_execution_started: "tool_execution_started",
	tool_execution_succeeded: "tool_execution_succeeded",
	tool_execution_failed: "tool_execution_failed",
	tool_execution_resolved: "tool_execution_resolved",
	permission_requested: "permission_requested",
	permission_decided: "permission_decided",
	permission_expired: "permission_expired",
	uncertain_pending: "uncertain_pending",
	model_output_abandoned: "draft_voided",
	summarized: "summarized",
	terminal: "terminal",
} as const;

export type DurableTypeOnWire = keyof typeof DURABLE_TO_WIRE;
export type WireEventType = (typeof DURABLE_TO_WIRE)[DurableTypeOnWire];

/** Off the wire, by decision: usage (a product bills through its own
 *  frames), stop and the assistant/compaction boundaries (control facts
 *  that render nothing), tool_call_input_delta (the end carries the input). */
export const NOT_ON_WIRE = ["usage", "stop", "assistant_start", "assistant_end", "compacted", "microcompacted", "tool_call_input_delta"] as const;

/** The allowlist: the fields a wire event MAY carry, per wire type. A
 *  field absent here never reaches the wire, whatever the durable event
 *  holds — leakage by omission is impossible. `seq` and `type` are
 *  implicit on every event. */
export const WIRE_FIELDS: Readonly<Record<WireEventType, readonly string[]>> = {
	user_input: ["content", "source"],
	user_input_replaced: ["replaces", "content", "source"],
	text_start: [],
	text_delta: ["text"],
	text_end: [],
	thinking: ["text"],
	tool_call_start: ["callId", "name"],
	tool_call_end: ["callId", "name", "input"],
	tool_result: ["callId", "isError", "errorKind"],
	tool_execution_started: ["executionId", "callId", "name"],
	tool_execution_succeeded: ["executionId", "callId"],
	tool_execution_failed: ["executionId", "callId", "error", "errorKind", "safeToRetry"],
	tool_execution_resolved: ["executionId", "callId", "resolution"],
	permission_requested: ["decisionId", "callId", "name", "input"],
	permission_decided: ["decisionId", "decision"],
	permission_expired: ["decisionId", "reason"],
	uncertain_pending: ["executionId", "callId", "name", "error"],
	draft_voided: ["voidFromSeq", "reason"],
	summarized: ["coversToSeq", "summary"],
	terminal: ["outcome"],
};

/** The fields that are sanitized when they carry tool arguments. */
export const SANITIZED_FIELDS: ReadonlySet<string> = new Set(["input"]);

export interface WireEventBase {
	readonly seq: number;
	readonly type: WireEventType;
}

export type WireEvent =
	| (WireEventBase & { readonly type: "user_input"; readonly content: WireInput; readonly source?: WireSource })
	| (WireEventBase & { readonly type: "user_input_replaced"; readonly replaces: number; readonly content: WireInput | null; readonly source?: WireSource })
	| (WireEventBase & { readonly type: "text_start" })
	| (WireEventBase & { readonly type: "text_delta"; readonly text: string })
	| (WireEventBase & { readonly type: "text_end" })
	| (WireEventBase & { readonly type: "thinking"; readonly text: string })
	| (WireEventBase & { readonly type: "tool_call_start"; readonly callId: string; readonly name: string })
	| (WireEventBase & { readonly type: "tool_call_end"; readonly callId: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> | null })
	| (WireEventBase & { readonly type: "tool_result"; readonly callId: string; readonly isError: boolean; readonly errorKind?: string })
	| (WireEventBase & { readonly type: "tool_execution_started"; readonly executionId: string; readonly callId: string; readonly name: string })
	| (WireEventBase & { readonly type: "tool_execution_succeeded"; readonly executionId: string; readonly callId: string })
	| (WireEventBase & { readonly type: "tool_execution_failed"; readonly executionId: string; readonly callId: string; readonly error: string; readonly errorKind?: string; readonly safeToRetry: boolean })
	| (WireEventBase & { readonly type: "tool_execution_resolved"; readonly executionId: string; readonly callId: string; readonly resolution: "rerun" | "abandoned" })
	| (WireEventBase & { readonly type: "permission_requested"; readonly decisionId: string; readonly callId: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> })
	| (WireEventBase & { readonly type: "permission_decided"; readonly decisionId: string; readonly decision: "approved" | "denied" })
	| (WireEventBase & { readonly type: "permission_expired"; readonly decisionId: string; readonly reason: string })
	| (WireEventBase & { readonly type: "uncertain_pending"; readonly executionId: string; readonly callId: string; readonly name: string; readonly error: string })
	| (WireEventBase & { readonly type: "draft_voided"; readonly voidFromSeq: number; readonly reason: string })
	| (WireEventBase & { readonly type: "summarized"; readonly coversToSeq: number; readonly summary: string })
	| (WireEventBase & { readonly type: "terminal"; readonly outcome: WireTerminal });

export type WireTerminal =
	| { readonly kind: "completed" }
	| { readonly kind: "max_tokens" }
	| { readonly kind: "max_turns"; readonly turns: number }
	| { readonly kind: "error"; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } }
	| { readonly kind: "aborted"; readonly by: "user" | "parent" }
	| { readonly kind: "hook_stopped"; readonly hook: string };

/** A frame a product adds beside the wire events (billing, an estimate, a
 *  courier's payload). Its `event` name is the product's; the transport
 *  carries it on the same connection and never reads it. */
export interface WireFrame {
	readonly event: string;
	readonly data: unknown;
}
