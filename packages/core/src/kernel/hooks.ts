/**
 * L2 — the hook vocabulary: 3 phases + lifecycle (mauri ADR-0006).
 *
 * ReAct's loop has exactly three model↔world interfaces — assemble (feed the
 * model), model (the model speaks), execute (the model makes the world work)
 * — plus lifecycle points around them. Every hook is either a transform
 * (returns a replacement) or an observer (void); the kernel never invents
 * phases beyond these nine.
 *
 * Payload types are SHARED between fire-site and read-site: a hook author
 * cannot drift a key name, because the keys do not exist — the payload is a
 * typed object (the mauri payload-contract discipline, ADR-0017, as a
 * compile-time fact instead of a written rule).
 */

import type { Event } from "../protocol/events.js";
import type { Message, UserMessage } from "../protocol/messages.js";
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
	/** Lifecycle: compaction is about to replace history. */
	onPreCompact?(messages: readonly Message[], ctx: HookContext): Promise<void>;
	/** Lifecycle: compaction finished. */
	onPostCompact?(messages: readonly Message[], ctx: HookContext): Promise<void>;
	/** Lifecycle: the loop paused (human decision pending). */
	onPause?(reason: string, ctx: HookContext): Promise<void>;
	/** Lifecycle: the loop is about to stop. */
	onStop?(reason: string, ctx: HookContext): Promise<void>;
}

/** Every hook optional; unset = pass-through. The kernel runs with this. */
export const NoOpHooks: HookHost = {};
