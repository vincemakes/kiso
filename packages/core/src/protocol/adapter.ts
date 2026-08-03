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

import type { Event } from "./events.js";
import type { Message, ToolSpec } from "./messages.js";

/**
 * What the kernel accepts as a cancellation signal: a REAL AbortSignal
 * (the universal host type — every Node and browser host has one) or a
 * minimal structural stub for tests and exotic hosts. `AbortSignal` itself
 * is not structurally assignable to a hand-rolled interface (its listener
 * and options shapes are richer), so the union is the honest contract:
 * real signals pass without casts, stubs stay possible.
 */
export type AbortSignalLike = AbortSignal | AbortSignalStub;

/** Minimal structural stand-in: `aborted` + `addEventListener` + `removeEventListener`. */
export interface AbortSignalStub {
	readonly aborted: boolean;
	addEventListener(
		type: string,
		listener: (this: AbortSignalStub, ev: unknown) => void,
		options?: { once?: boolean },
	): void;
	removeEventListener(
		type: string,
		listener: (this: AbortSignalStub, ev: unknown) => void,
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
