/**
 * AgentSession + Run — the durable multi-turn conversation (Phase C).
 *
 * A session owns ONE EventLog, seeded from disk on load and continued in
 * memory. Each `run(input)`:
 *
 *   1. appends the user input to the log AND the store (durable first);
 *   2. drives the kernel loop against the session's log — every adapter
 *      call is a pure projection of that log (ADR-0002), so multi-turn
 *      context is free;
 *   3. writes every event to the store BEFORE yielding it (write-ahead);
 *   4. yields the stream; the run's `runId` and `abort()` ride on the Run
 *      handle, not on the event union.
 *
 * Restart recovery is the same code path as a second run: rebuild the log
 * from the JSONL, continue numbering where the file ended.
 */

import {
	EventLog,
	loop,
	projectMessages,
	type Adapter,
	type Event,
	type Message,
	type Tool,
} from "@kiso/core";
import type { SessionStore } from "./store.js";

export class AgentSession {
	readonly id: string;
	readonly log: EventLog;
	readonly #store: SessionStore;
	readonly #adapter: Adapter;
	readonly #config: SessionConfig;

	constructor(id: string, log: EventLog, store: SessionStore, adapter: Adapter, config: SessionConfig) {
		this.id = id;
		this.log = log;
		this.#store = store;
		this.#adapter = adapter;
		this.#config = config;
	}

	/** The conversation so far, as the model sees it. */
	projected(): readonly Message[] {
		return projectMessages(this.log.all);
	}

	/** Run one user turn. Iterate to consume; `run.abort()` cancels. */
	run(input: string): Run {
		return new Run(this.#store, this.#adapter, this.#config, this, input);
	}
}

export interface SessionConfig {
	readonly model: string;
	readonly systemPrompt?: string;
	readonly tools?: readonly Tool[];
	readonly registry: import("@kiso/core").ToolRegistry;
	readonly hooks?: import("@kiso/core").HookHost;
	readonly maxTurns?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly compaction?: { readonly thresholdTokens: number };
	readonly maxRetries?: number;
}

/**
 * A single turn. Async-iterable, so `for await (const ev of session.run(x))`
 * is the natural shape; the handle also carries the runId and the abort.
 */
export class Run implements AsyncIterable<Event> {
	readonly runId: string;
	readonly #store: SessionStore;
	readonly #adapter: Adapter;
	readonly #config: SessionConfig;
	readonly #session: AgentSession;
	readonly #input: string;
	readonly #abort = new AbortController();
	#started = false;

	constructor(store: SessionStore, adapter: Adapter, config: SessionConfig, session: AgentSession, input: string) {
		this.#store = store;
		this.#adapter = adapter;
		this.#config = config;
		this.#session = session;
		this.#input = input;
		this.runId = crypto.randomUUID();
	}

	/** Cancel the run: propagates to the adapter (SDK) and future executions. */
	abort(): void {
		this.#abort.abort();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<Event> {
		if (this.#started) throw new Error("a run may only be consumed once");
		this.#started = true;

		const log = this.#session.log;

		// 1. Durable first: the prompt enters the log and the store before
		//    any model call — a crash here leaves a restorable session. The
		//    prompt is also the first event the consumer sees, so what was
		//    asked and what happened live in the same stream.
		const inputEvent = log.append({ type: "user_input", content: this.#input });
		this.#store.append(this.#session.id, this.runId, inputEvent);
		yield inputEvent;

		// 2. The loop projects from the session log — multi-turn context is
		//    the projection, not a second copy.
		for await (const ev of loop({
			adapter: this.#adapter,
			model: this.#config.model,
			...(this.#config.systemPrompt !== undefined ? { systemPrompt: this.#config.systemPrompt } : {}),
			registry: this.#config.registry,
			...(this.#config.hooks !== undefined ? { hooks: this.#config.hooks } : {}),
			...(this.#config.maxTurns !== undefined ? { maxTurns: this.#config.maxTurns } : {}),
			...(this.#config.maxTokens !== undefined ? { maxTokens: this.#config.maxTokens } : {}),
			...(this.#config.temperature !== undefined ? { temperature: this.#config.temperature } : {}),
			...(this.#config.compaction !== undefined ? { compaction: this.#config.compaction } : {}),
			...(this.#config.maxRetries !== undefined ? { maxRetries: this.#config.maxRetries } : {}),
			log,
			signal: this.#abort.signal,
		})) {
			// 3. Write-ahead: durable before the consumer sees it.
			this.#store.append(this.#session.id, this.runId, ev);
			yield ev;
		}
	}
}

