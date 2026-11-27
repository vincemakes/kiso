/**
 * L2 — the hook vocabulary: 3 phases + lifecycle (the predecessor's ADR-0006).
 *
 * ReAct's loop has exactly three model↔world interfaces — assemble (feed the
 * model), model (the model speaks), execute (the model makes the world work)
 * — plus lifecycle points around them. Every hook is either a transform
 * (returns a replacement) or an observer (void); the kernel never invents
 * phases beyond these nine.
 *
 * Payload types are SHARED between fire-site and read-site: a hook author
 * cannot drift a key name, because the keys do not exist — the payload is a
 * typed object (the predecessor's payload-contract discipline, ADR-0017, as a
 * compile-time fact instead of a written rule).
 */

import type { Event } from "../protocol/events.js";
import type { UserMessage } from "../protocol/messages.js";
import type { ToolResult } from "../tools/tool.js";
import type { PermissionDecision } from "./permission.js";

export interface HookContext {
	readonly sessionId?: string;
}

export interface PreLlmPayload {
	readonly model: string;
	readonly turns: number;
}

export interface ToolCallPayload {
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	/** 0.44.0 (#20): the invocation's arguments as the model streamed them —
	 *  the same lexical evidence the tool receives as `ctx.rawInput`, on
	 *  onPreTool and onPostTool alike, fresh or recovered; absent when no
	 *  delta was streamed. Evidence for the host, never a control input: the
	 *  approval chain never receives it, and validation, permission and
	 *  execution read the parsed input. */
	readonly rawInput?: string;
}

export interface HookHost {
	/** Assemble: rewrite or veto the incoming user message. null = drop. */
	onUserMessage?(msg: UserMessage, ctx: HookContext): Promise<UserMessage | null>;
	/** Assemble: last word before the model is called. */
	onPreLlm?(payload: PreLlmPayload, ctx: HookContext): Promise<void>;
	/** Model: observer over every event as it flows. Never throws outward. */
	onEvent?(event: Event, ctx: HookContext): Promise<void>;
	/** Execute: permission negotiation before a tool runs. */
	onPreTool?(call: ToolCallPayload, ctx: HookContext): Promise<PermissionDecision>;
	/** Execute: rewrite the result a tool returns. */
	onPostTool?(call: ToolCallPayload, result: ToolResult, ctx: HookContext): Promise<ToolResult>;
	/** Lifecycle: the loop paused (human decision pending). */
	onPause?(reason: string, ctx: HookContext): Promise<void>;
	/** Lifecycle: the loop is about to stop. */
	onStop?(reason: string, ctx: HookContext): Promise<void>;
	/** Lifecycle: the loop is about to WAIT and retry the model request
	 *  (ADR-0005 Amendment 2). Observation only — it cannot change the
	 *  decision, it writes nothing, and a throw is swallowed. */
	onRetry?(info: RetryInfo, ctx: HookContext): Promise<void>;
}

/** What a retry is, as the loop announces it: the attempt about to be
 *  made, the budget it is counted against, the classified error code,
 *  the wait before it, and whether a draft had already streamed (a
 *  mid-stream retry voids that draft first — ADR-0005 Amendment 1). */
export interface RetryInfo {
	readonly attempt: number;
	readonly maxRetries: number;
	readonly code: string;
	readonly delayMs: number;
	readonly midStream: boolean;
}

/** Every hook optional; unset = pass-through. The kernel runs with this. */
export const NoOpHooks: HookHost = {};
