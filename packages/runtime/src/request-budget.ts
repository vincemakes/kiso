/**
 * A1a (A) — request-budget accounting: the parts of the request the
 * kernel assembles (system prompt, tool table, projected messages with
 * their continuation envelopes, the output reserve), each estimated the
 * way the kernel estimates (chars / 4 — a proxy, marked approximate),
 * summed ONCE. The CLI's `ctx left` had measured the projected messages
 * alone, so a fresh session with a large tool table read "~100%" — the
 * headroom was never that.
 *
 * Two definitional points (the 2026-09-07 review): the continuation
 * envelopes ride INSIDE the projected assistant messages and are
 * measured as a sub-part of `messages`, never added on top; the output
 * reserve is the request's `max_tokens` when a profile or provider sets
 * one and NULL when unknown (the openai-compat path sends none unless
 * configured) — the total then excludes it and says so.
 *
 * This is a display and design entry. The auto-compact policy keeps its
 * own number (`estimateCtxRatio` in the CLI) — moving it is A1b's.
 */

import type { Message, ToolSpec } from "@vincemakes/kiso-core";
import { estimateTokens } from "@vincemakes/kiso-core";

export interface RequestParts {
	readonly systemPrompt?: string;
	readonly toolSpecs: readonly ToolSpec[];
	readonly messages: readonly Message[];
	/** the request's max_tokens; undefined/null = the provider sends none */
	readonly maxTokens?: number | null;
}

export interface RequestBudget {
	readonly approximate: true;
	readonly system: number;
	readonly tools: number;
	readonly user: number;
	readonly assistant: number;
	readonly toolResults: number;
	/** the continuation envelopes inside the assistant messages (a sub-part of `messages`) */
	readonly continuations: number;
	/** user + assistant + toolResults + continuations */
	readonly messages: number;
	readonly outputReserve: number | null;
	/** system + tools + messages + (outputReserve ?? 0) */
	readonly total: number;
	readonly window: number;
	readonly headroom: number;
	readonly ratio: number;
}

const chars = (s: string): number => Math.ceil(s.length / 4);

export function requestBudget(parts: RequestParts, window: number): RequestBudget {
	const system = parts.systemPrompt === undefined ? 0 : chars(parts.systemPrompt);
	const tools = parts.toolSpecs.length === 0 ? 0 : chars(JSON.stringify(parts.toolSpecs));
	let user = 0;
	let assistant = 0;
	let toolResults = 0;
	let continuations = 0;
	for (const m of parts.messages) {
		const t = estimateTokens([m]);
		if (m.role === "user") user += t;
		else if (m.role === "assistant") {
			assistant += t;
			if (m.continuation !== undefined) continuations += chars(JSON.stringify(m.continuation));
		} else toolResults += t;
	}
	const messages = user + assistant + toolResults + continuations;
	const outputReserve = parts.maxTokens ?? null;
	const total = system + tools + messages + (outputReserve ?? 0);
	return { approximate: true, system, tools, user, assistant, toolResults, continuations, messages, outputReserve, total, window, headroom: window - total, ratio: total / window };
}
