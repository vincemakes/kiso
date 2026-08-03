/**
 * AgentSession + Run — the durable multi-turn conversation (Phase C/D).
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
 * Phase D adds the human-in-the-loop surface:
 *   - `pendingApprovals()` — pauses that still await a decision
 *     (permission_requested without permission_decided);
 *   - `approve(decisionId, allow)` — resumes a paused run in-process, or
 *     persists the decision directly when the run is gone;
 *   - `uncertainExecutions()` / `resolveUncertain(...)` — the ledger of
 *     interrupted side effects and the human's rerun/abandon verdict.
 *
 * Restart recovery is the same code path as a second run: rebuild the log
 * from the JSONL, continue numbering where the file ended.
 */

import {
	EventLog,
	executionLedger,
	loop,
	projectMessages,
	type AbortSignalLike,
	type AbortSignalStub,
	type Adapter,
	type Event,
	type Message,
	type PermissionDecision,
	type Tool,
} from "@kiso/core";
import type { SessionStore } from "./store.js";

export interface ApprovalRequest {
	readonly decisionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export class AgentSession {
	readonly id: string;
	readonly log: EventLog;
	readonly #store: SessionStore;
	readonly #adapter: Adapter;
	readonly #config: SessionConfig;
	readonly #pendingResolvers = new Map<string, (decision: PermissionDecision) => void>();

	readonly #activeRuns = new Set<Run>();

	constructor(id: string, log: EventLog, store: SessionStore, adapter: Adapter, config: SessionConfig) {
		this.id = id;
		this.log = log;
		this.#store = store;
		this.#adapter = adapter;
		this.#config = config;
	}

	// ── one active run per session (Area 1) ──────────────────────────────

	beginRun(run: Run): void {
		if (this.#activeRuns.size > 0) {
			throw new Error("this session already has an active run — one run at a time");
		}
		this.#activeRuns.add(run);
	}

	endRun(run: Run): void {
		this.#activeRuns.delete(run);
	}

	/** The conversation so far, as the model sees it. */
	projected(): readonly Message[] {
		return projectMessages(this.log.all);
	}

	/** Run one user turn. Iterate to consume; `run.abort()` cancels. */
	run(input: string, options?: { signal?: AbortSignalLike }): Run {
		return new Run(this.#store, this.#adapter, this.#config, this, input, options?.signal);
	}

	// ── Phase D: approvals ───────────────────────────────────────────────

	/** Pauses that still await a human decision (durable, survives restart). */
	pendingApprovals(): ApprovalRequest[] {
		const decided = new Set(
			this.log.all.filter((e) => e.type === "permission_decided").map((e) => (e as { decisionId: string }).decisionId),
		);
		return this.log.all
			.filter((e): e is Event & { type: "permission_requested" } => e.type === "permission_requested" && !decided.has(e.decisionId))
			.map((e) => ({
				decisionId: e.decisionId,
				callId: e.callId,
				name: e.name,
				input: e.input,
			}));
	}

	/**
	 * Answer a pending approval. In-process: resumes the paused run, which
	 * persists the decision. After a restart: persists the decision
	 * directly — the durable record is the same either way.
	 */
	approve(decisionId: string, allow: boolean): void {
		const resolver = this.#pendingResolvers.get(decisionId);
		if (resolver !== undefined) {
			this.#pendingResolvers.delete(decisionId);
			resolver(allow ? { action: "allow" } : { action: "deny", reason: "denied by user" });
			return;
		}
		const runId =
			this.#store
				.load(this.id)
				.find((r) => r.event.type === "permission_requested" && (r.event as { decisionId: string }).decisionId === decisionId)
				?.runId ?? "approval";
		const decided = this.log.append({
			type: "permission_decided",
			decisionId,
			decision: allow ? "approved" : "denied",
			...(allow ? {} : { reason: "denied by user" }),
		});
		this.#store.append(this.id, runId, decided);
	}

	// ── Phase D: the uncertain-execution ledger ──────────────────────────

	/** Executions that started but never reported a result (crash window). */
	uncertainExecutions() {
		return [...executionLedger(this.log.all).values()].filter((r) => r.status === "uncertain");
	}

	/**
	 * The human's verdict on an interrupted execution: "rerun" (the human
	 * takes responsibility — the side effect may run again) or "abandoned"
	 * (treated as failed forever). Durable, write-ahead.
	 */
	resolveUncertain(callId: string, resolution: "rerun" | "abandoned"): void {
		const resolved = this.log.append({ type: "tool_execution_resolved", callId, resolution });
		this.#store.append(this.id, "resolution", resolved);
	}

	// ── internal: the resolver registry ──────────────────────────────────

	registerResolver(decisionId: string, resolve: (decision: PermissionDecision) => void): void {
		this.#pendingResolvers.set(decisionId, resolve);
	}

	dropResolver(decisionId: string): void {
		this.#pendingResolvers.delete(decisionId);
	}
}

export interface SessionConfig {
	readonly model: string;
	readonly systemPrompt?: string;
	readonly tools?: readonly Tool<any>[];
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
	readonly #externalSignal: AbortSignalLike | undefined;
	readonly #decisionIds: string[] = [];
	#started = false;

	constructor(
		store: SessionStore,
		adapter: Adapter,
		config: SessionConfig,
		session: AgentSession,
		input: string,
		externalSignal?: AbortSignalLike,
	) {
		this.#store = store;
		this.#adapter = adapter;
		this.#config = config;
		this.#session = session;
		this.#input = input;
		this.#externalSignal = externalSignal;
		this.runId = crypto.randomUUID();
	}

	/** Cancel the run: propagates to the adapter (SDK) and future executions. */
	abort(): void {
		this.#abort.abort();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<Event> {
		if (this.#started) throw new Error("a run may only be consumed once");
		this.#started = true;

		// The WHOLE body is one try/finally: a consumer that abandons the
		// run at ANY yield (even the user_input one) must release the
		// session's single-run slot and its approval resolvers.
		try {
			this.#session.beginRun(this);
			const log = this.#session.log;

			// 1. Durable first: the prompt enters the log and the store
			//    before any model call — a crash here leaves a restorable
			//    session. The prompt is also the first event the consumer
			//    sees, so what was asked and what happened live in the same
			//    stream.
			const inputEvent = log.append({ type: "user_input", content: this.#input });
			this.#store.append(this.#session.id, this.runId, inputEvent);
			yield inputEvent;

			// 2. The loop projects from the session log — multi-turn context
			//    is the projection, not a second copy. `resolveApproval`
			//    bridges the loop's pause to the session's approval surface.
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
				signal: this.#externalSignal ? new MergedSignal(this.#abort.signal, this.#externalSignal) : this.#abort.signal,
				resolveApproval: (decisionId) =>
					new Promise<PermissionDecision>((resolve) => {
						this.#decisionIds.push(decisionId);
						this.#session.registerResolver(decisionId, resolve);
					}),
			})) {
				// 3. Write-ahead: durable before the consumer sees it.
				this.#store.append(this.#session.id, this.runId, ev);
				yield ev;
			}
		} finally {
			// The run is over (or abandoned): its unanswered approvals must
			// fall back to the direct-persist path, so a late approve() is
			// still durable.
			for (const decisionId of this.#decisionIds) {
				this.#session.dropResolver(decisionId);
			}
			this.#session.endRun(this);
		}
	}
}

/**
 * A signal that fires when ANY source fires — the run's own controller and
 * an optional external signal (the CLI's Ctrl+C, a fixture's flip).
 */
class MergedSignal implements AbortSignalStub {
	readonly #sources: readonly AbortSignalLike[];
	readonly #listeners = new Set<() => void>();

	constructor(...sources: readonly AbortSignalLike[]) {
		this.#sources = sources;
		for (const source of sources) {
			if (source.aborted) continue;
			source.addEventListener("abort", () => {
				for (const listener of this.#listeners) listener();
			});
		}
	}

	get aborted(): boolean {
		return this.#sources.some((s) => s.aborted);
	}

	addEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void): void {
		this.#listeners.add(() => listener.call(this, undefined));
	}

	removeEventListener(_type: string, listener: (this: AbortSignalStub, ev: unknown) => void): void {
		this.#listeners.delete(listener as () => void);
	}
}
