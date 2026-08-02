/**
 * L1 — the adapter contract.
 *
 * One interface every provider implements. `stream()` returns an
 * ASYNC ITERABLE of events — never a settled promise of a list, and never a
 * callback emitter. An async iterable is incremental (the consumer sees each
 * event as it happens), interruptible (AbortSignal), and replayable (the
 * events carry `seq`). The three properties that let a ReAct loop stream
 * without buffering and without losing its place.
 *
 * WHY not a `Promise<Event[]>`: a buffered adapter is what made agno's
 * streaming a second-class feature bolted onto a batch loop. The contract
 * shape IS the architecture — see ADR-0001.
 *
 * Adapters translate provider wire events INTO `Event`. They never see tool
 * handlers (only `ToolSpec` projections) — the kernel is the only thing that
 * runs tools. Provider-private fields (thinking blocks, cache_control,
 * reasoning_content) are digested HERE and never leak into the union.
 */

import type { Event } from "./events";
import type { Message, ToolSpec } from "./messages";

/**
 * Structural stand-in for AbortSignal. The kernel must not depend on Node or
 * DOM globals — it runs in any host. Anything with `aborted` + `addEventListener`
 * satisfies it: a real AbortSignal, a test stub, a timeout wrapper.
 */
export interface AbortSignalLike {
	readonly aborted: boolean;
	addEventListener(
		type: "abort",
		listener: (this: AbortSignalLike, ev: Event) => void,
		options?: { once?: boolean },
	): void;
	removeEventListener(
		type: "abort",
		listener: (this: AbortSignalLike, ev: Event) => void,
		options?: { once?: boolean },
	): void;
}

export interface StreamOptions {
	readonly model: string;
	readonly messages: readonly Message[];
	/** Provider-level system prompt. The kernel never composes prompts. */
	readonly systemPrompt?: string;
	readonly tools?: readonly ToolSpec[];
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignalLike;
}

export interface Adapter {
	stream(options: StreamOptions): AsyncIterable<Event>;
}
