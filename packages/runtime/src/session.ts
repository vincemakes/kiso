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
	type ToolResult,
} from "@kiso/core";
import { denialResult } from "@kiso/core";
import type { SessionStore } from "./store.js";

/** resume() refuses while interrupted executions still await a human verdict. */
export class ResumeBlockedError extends Error {
	readonly uncertain: readonly { executionId: string; callId: string; name: string }[];
	constructor(uncertain: readonly { executionId: string; callId: string; name: string }[]) {
		super(
			`resume is blocked by ${uncertain.length} uncertain execution(s): ` +
				uncertain.map((u) => `${u.name}(${u.executionId})`).join(", ") +
				" — resolve each with resolveUncertain(executionId, 'rerun'|'abandoned') first",
		);
		this.name = "ResumeBlockedError";
		this.uncertain = uncertain;
	}
}

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
	readonly #answered = new Set<string>();

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
		return new Run(this.#store, this.#adapter, this.#config, this, input, options?.signal, false);
	}

	/**
	 * Continue the interrupted run (Area 2): apply durable decisions,
	 * fill missing receipts, resume the pause, and drive the original
	 * trajectory to its terminal — WITHOUT inventing a new user turn.
	 * Yields nothing when the session already completed.
	 */
	resume(): Run {
		return new Run(this.#store, this.#adapter, this.#config, this, undefined, undefined, true);
	}

	// ── Phase D: approvals ───────────────────────────────────────────────

	/**
	 * Pauses that still await a human decision (durable, survives restart).
	 * B 组: a request whose RUN has terminated is DEAD — it is neither
	 * re-presented here nor recoverable; expired requests are excluded too.
	 */
	pendingApprovals(): ApprovalRequest[] {
		const records = this.#store.load(this.id);
		const terminatedRuns = new Set<string>();
		for (const r of records) {
			if (r.event.type === "terminal") terminatedRuns.add(r.runId);
		}
		const requestRun = new Map<string, string>();
		for (const r of records) {
			if (r.event.type === "permission_requested") requestRun.set(r.event.decisionId, r.runId);
		}
		const decided = new Set(
			this.log.all.filter((e) => e.type === "permission_decided").map((e) => (e as { decisionId: string }).decisionId),
		);
		const expired = new Set(
			this.log.all.filter((e) => e.type === "permission_expired").map((e) => (e as { decisionId: string }).decisionId),
		);
		return this.log.all
			.filter((e): e is Event & { type: "permission_requested" } => {
				if (e.type !== "permission_requested") return false;
				if (decided.has(e.decisionId) || expired.has(e.decisionId)) return false;
				const runId = requestRun.get(e.decisionId);
				return runId === undefined || !terminatedRuns.has(runId);
			})
			.map((e) => ({
				decisionId: e.decisionId,
				callId: e.callId,
				name: e.name,
				input: e.input,
			}));
	}

	/**
	 * Answer a pending approval (Area 2). With a live run, the decision is
	 * RESOLVED into the run's frame — the loop (or the resume recovery)
	 * writes `permission_decided` itself, so there is exactly one writer per
	 * event and seq never duplicates. With no live run, the decision is
	 * persisted directly (durable, attributed to the original run) and the
	 * next resume applies it without re-asking. The crash window between a
	 * resolve and the run's write is benign: nothing has executed yet, so a
	 * lost decision only re-presents the request.
	 */
	approve(decisionId: string, allow: boolean): void {
		// Idempotent: one decision per request (review finding 7). The
		// in-memory answered-set covers the same-tick double answer — the
		// loop writes the durable record asynchronously after the resolver
		// wakes, so the log cannot be consulted yet. The durable check below
		// covers answers arriving after the record landed.
		if (this.#answered.has(decisionId)) return;
		this.#answered.add(decisionId);
		if (this.log.all.some((e) => e.type === "permission_decided" && e.decisionId === decisionId)) return;
		// B 组: a late approve() on a TERMINATED run writes nothing and
		// executes nothing — a dead run's approval cannot resurrect it.
		const records = this.#store.load(this.id);
		const request = records.find(
			(r) => r.event.type === "permission_requested" && (r.event as { decisionId: string }).decisionId === decisionId,
		);
		if (request) {
			const runTerminated = records.some((r) => r.runId === request.runId && r.event.type === "terminal");
			if (runTerminated) return;
		}
		const resolver = this.#pendingResolvers.get(decisionId);
		if (resolver !== undefined) {
			this.#pendingResolvers.delete(decisionId);
			resolver(allow ? { action: "allow" } : { action: "deny", reason: "denied by user" });
			return;
		}
		const runId = request?.runId ?? "approval";
		const decided = this.log.append({
			type: "permission_decided",
			decisionId,
			...(request !== undefined ? { callId: (request.event as { callId: string }).callId } : {}),
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
	 * The human's verdict on an interrupted execution, keyed by EXECUTION ID
	 * (B 组): "rerun" (the human says the side effect did NOT happen — the
	 * attempt is completed with a recorded failure so the model may re-issue
	 * it as a new logical call) or "abandoned" (treated as failed forever).
	 * Only uncertain → rerun/abandoned is legal; a resolved or successful
	 * execution is left untouched (idempotent, irreversible). Both fill a
	 * model-facing result — a dangling tool_use with NO result would be
	 * rejected by real providers (review finding 1).
	 */
	resolveUncertain(executionId: string, resolution: "rerun" | "abandoned"): void {
		const record = executionLedger(this.log.all).get(executionId);
		if (!record) throw new Error(`no execution record for ${executionId}`);
		if (record.status !== "uncertain") return; // idempotent + irreversible
		const resolved = this.log.append({
			type: "tool_execution_resolved",
			executionId,
			callId: record.callId,
			resolution,
		});
		this.#store.append(this.id, "resolution", resolved);
		if (!this.log.all.some((e) => e.type === "tool_result" && e.callId === record.callId)) {
			const denial = denialResult(
				resolution === "rerun"
					? "interrupted execution — rerun approved: the attempt is treated as NOT applied; the model may retry"
					: "abandoned by human decision — the interrupted attempt must not be treated as applied",
			);
			const result = this.log.append({
				type: "tool_result",
				callId: record.callId,
				content: denial.content,
				isError: true,
				errorKind: denial.errorKind,
			});
			this.#store.append(this.id, "resolution", result);
		}
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
	runId: string;
	readonly #store: SessionStore;
	readonly #adapter: Adapter;
	readonly #config: SessionConfig;
	readonly #session: AgentSession;
	readonly #input: string | undefined;
	readonly #resume: boolean;
	readonly #abort = new AbortController();
	readonly #externalSignal: AbortSignalLike | undefined;
	readonly #decisionIds: string[] = [];
	#started = false;

	constructor(
		store: SessionStore,
		adapter: Adapter,
		config: SessionConfig,
		session: AgentSession,
		input: string | undefined,
		externalSignal: AbortSignalLike | undefined,
		resume: boolean,
	) {
		this.#store = store;
		this.#adapter = adapter;
		this.#config = config;
		this.#session = session;
		this.#input = input;
		this.#externalSignal = externalSignal;
		this.#resume = resume;
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
			const signal = this.#externalSignal ? new MergedSignal(this.#abort.signal, this.#externalSignal) : this.#abort.signal;
			const loopConfig = () =>
				({
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
					signal,
					resolveApproval: (decisionId: string) =>
						new Promise<PermissionDecision>((resolve) => {
							this.#decisionIds.push(decisionId);
							this.#session.registerResolver(decisionId, resolve);
						}),
				}) satisfies Parameters<typeof loop>[0];

			const self = this;
			const runLoop = async function* (): AsyncGenerator<Event> {
				for await (const ev of loop(loopConfig())) {
					self.#store.append(self.#session.id, self.runId, ev);
					yield ev;
				}
			};

			if (this.#resume) {
				// ── B 组: recovery is PER-RUN, keyed by StoreRecord.runId ──
				// Rebuild run boundaries; only the LAST unterminated run is
				// recovered. Earlier runs that DID terminate have their
				// dangling approvals closed (permission_expired) — a dead
				// run's approval is never re-presented or resurrected.
				const records = this.#store.load(this.#session.id);
				const runs = new Map<string, Event[]>();
				const order: string[] = [];
				for (const r of records) {
					if (!runs.has(r.runId)) {
						runs.set(r.runId, []);
						order.push(r.runId);
					}
					runs.get(r.runId)!.push(r.event);
				}
				let lastOpen: { runId: string; events: Event[] } | undefined;
				for (const runId of order) {
					const events = runs.get(runId)!;
					if (!events.some((e) => e.type === "terminal")) lastOpen = { runId, events };
				}
				if (!lastOpen) return; // everything terminated — nothing to resume

				// Adopt the ORIGINAL runId so the whole trajectory stays one
				// run in the audit.
				this.runId = lastOpen.runId;

				// Close dangling approvals of TERMINATED runs.
				for (const [runId, events] of runs) {
					if (runId === lastOpen.runId) continue;
					if (!events.some((e) => e.type === "terminal")) continue; // an open earlier run? impossible — lastOpen is the LAST
					for (const ev of events) {
						if (ev.type !== "permission_requested") continue;
						const dead = this.#session.log.all.some(
							(e) =>
								(e.type === "permission_decided" || e.type === "permission_expired") &&
								e.decisionId === ev.decisionId,
						);
						if (dead) continue;
						const expired = this.#session.log.append({
							type: "permission_expired",
							decisionId: ev.decisionId,
							reason: `run ${runId} terminated before the request was answered`,
						});
						this.#store.append(this.#session.id, runId, expired);
					}
				}

				// Uncertain executions block until a human decides.
				const uncertain = this.#session.uncertainExecutions();
				if (uncertain.length > 0) {
					throw new ResumeBlockedError(uncertain.map((u) => ({ executionId: u.executionId, callId: u.callId, name: u.name })));
				}

				// 1. Recovery scoped to the LAST OPEN RUN's events. The recover
				//    phase re-announces ALREADY-PERSISTED events (the stored
				//    permission_requested) for the consumer to re-prompt on —
				//    those must never be written to the store again, or seq
				//    would duplicate. Only events newer than the base log
				//    entry are durable.
				const baseSeq = log.lastSeq;
				const persist = (ev: Event): void => {
					if (ev.seq > baseSeq) this.#store.append(this.#session.id, this.runId, ev);
				};
				for await (const ev of this.#recover(log, signal, lastOpen.events)) {
					persist(ev);
					yield ev;
				}
				// 2. Continuation: drive the LAST OPEN run to its terminal.
				//    The guard is scoped to that run — an earlier run's
				//    terminal must not suppress it (B 组).
				if (!lastOpen.events.some((e) => e.type === "terminal")) {
					for await (const ev of runLoop()) yield ev;
				}
				return;
			}

			// 1. Durable first: the prompt enters the log and the store
			//    before any model call — a crash here leaves a restorable
			//    session. The prompt is also the first event the consumer
			//    sees, so what was asked and what happened live in the same
			//    stream.
			const inputEvent = log.append({ type: "user_input", content: this.#input! });
			this.#store.append(this.#session.id, this.runId, inputEvent);
			yield inputEvent;

			// 2. The loop projects from the session log — multi-turn context
			//    is the projection, not a second copy.
			for await (const ev of runLoop()) yield ev;
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

	// ── Area 2: the durable recovery state machine ───────────────────────

	/**
	 * Apply every durable decision and fill every missing receipt, in log
	 * order. A decision with no execution yet EXECUTES the persisted call
	 * (its original name/input/callId — never re-asked of the model, never
	 * re-approved); a denial writes its tool result; a succeeded/failed
	 * execution whose tool_result never landed is completed from the
	 * receipt. Undecided requests pause and await approve().
	 */
	async *#recover(log: EventLog, signal: AbortSignalLike, scope: readonly Event[]): AsyncGenerator<Event> {
		const requests = scope.filter(
			(e): e is Event & { type: "permission_requested" } => e.type === "permission_requested",
		);
		for (const pending of requests) {
			const decided = log.all.find(
				(e): e is Event & { type: "permission_decided" } => e.type === "permission_decided" && e.decisionId === pending.decisionId,
			);
			const hasExecution = log.all.some((e) => e.type === "tool_execution_started" && e.callId === pending.callId);
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.callId === pending.callId);

			if (decided === undefined) {
				// Pause: announce the stored request, await the human.
				const pendingDecision = new Promise<PermissionDecision>((resolve) => {
					this.#decisionIds.push(pending.decisionId);
					this.#session.registerResolver(pending.decisionId, resolve);
				});
				yield pending;
				// Area 4: an abort during the resumed approval wait ends the
				// run; the request stays durable and pending.
				if (signal.aborted) return;
				const final = await abortable(pendingDecision, signal);
				if (final === ABORTED) return;
				// The decision is written here — exactly one writer per event.
				yield log.append({
					type: "permission_decided",
					decisionId: pending.decisionId,
					callId: pending.callId, // binds the decision to the invocation (B 组)
					decision: final.action === "allow" ? "approved" : "denied",
					...(final.action === "deny" && final.reason !== undefined ? { reason: final.reason } : {}),
				});
				if (final.action === "allow") {
					if (!hasExecution) yield* this.#executePersisted(pending.callId, pending.name, pending.input, signal);
				} else if (!hasResult) {
					yield* this.#denialResult(pending.callId, final.reason ?? "denied by user");
				}
			} else if (decided.decision === "approved") {
				// Decided while no process was running: apply without pausing.
				// An abort during recovery must stop the pending executions,
				// exactly like the live loop's sibling guard (finding 3).
				if (signal.aborted) return;
				if (!hasExecution) yield* this.#executePersisted(pending.callId, pending.name, pending.input, signal);
			} else if (!hasResult) {
				yield* this.#denialResult(pending.callId, decided.reason ?? "denied by user");
			}
		}

		// Receipt repair: an execution that reached a terminal state but
		// whose model-facing result never landed is completed FROM THE
		// RECEIPT — never re-executed. Snapshot the scope first: this phase
		// appends the repaired results, and iterating a growing array would
		// re-visit them.
		for (const ev of [...scope]) {
			if (ev.type !== "tool_execution_succeeded" && ev.type !== "tool_execution_failed") continue;
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.callId === ev.callId);
			if (hasResult) continue;
			yield log.append(
				ev.type === "tool_execution_succeeded"
					? {
							type: "tool_result",
							callId: ev.callId,
							content: ev.result.content,
							isError: false,
							executionId: ev.executionId,
						}
					: {
							type: "tool_result",
							callId: ev.callId,
							content: ev.error,
							isError: true,
							...(ev.errorKind !== undefined ? { errorKind: ev.errorKind } : {}),
							executionId: ev.executionId,
						},
			);
		}

		// B 组 crash window: a resolution was persisted but its tool_result
		// fill never landed — complete it so the model is never left staring
		// at a dangling tool_use.
		for (const ev of [...scope]) {
			if (ev.type !== "tool_execution_resolved") continue;
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.callId === ev.callId);
			if (hasResult) continue;
			const denial = denialResult(
				ev.resolution === "rerun"
					? "interrupted execution — rerun approved: the attempt is treated as NOT applied; the model may retry"
					: "abandoned by human decision — the interrupted attempt must not be treated as applied",
			);
			yield log.append({
				type: "tool_result",
				callId: ev.callId,
				content: denial.content,
				isError: true,
				errorKind: denial.errorKind,
			});
		}
	}

	/**
	 * Execute a call whose approval is already durable: the original
	 * name/input/callId from the persisted permission_requested, bypassing
	 * the permission hook (it was decided) and the model (it was never
	 * asked to re-issue). Full ledgered lifecycle.
	 */
	async *#executePersisted(
		callId: string,
		name: string,
		input: Readonly<Record<string, unknown>>,
		signal: AbortSignalLike,
	): AsyncGenerator<Event> {
		const log = this.#session.log;
		const tool = this.#config.registry.get(name);
		const executionId = `ex-${log.lastSeq + 1}`;

		// An abort that landed while the decision was being applied must
		// not start the side effect (finding 3).
		if (signal.aborted) return;
		yield log.append({ type: "tool_execution_started", executionId, callId, name, input });

		let result: ToolResult;
		if (tool === undefined) {
			result = { content: `Unknown tool: ${name}`, isError: true, errorKind: "invalid_input" };
		} else {
			try {
				if (signal.aborted) {
					result = { content: "aborted before execution", isError: true, errorKind: "fatal" };
				} else {
					result = await tool.execute(input, { signal });
				}
			} catch (err) {
				result = {
					content: err instanceof Error ? err.message : String(err),
					isError: true,
					errorKind: "fatal",
				};
			}
			if (this.#config.hooks?.onPostTool) {
				result = await this.#config.hooks.onPostTool({ callId, name, input }, result, { sessionId: this.#session.id });
			}
		}

		if (result.isError) {
			yield log.append({
				type: "tool_execution_failed",
				executionId,
				callId,
				error: result.content,
				...(result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
				safeToRetry: tool?.idempotent === true,
			});
		} else {
			yield log.append({
				type: "tool_execution_succeeded",
				executionId,
				callId,
				result: { content: result.content, isError: false },
			});
		}
		yield log.append({
			type: "tool_result",
			callId,
			content: result.content,
			isError: result.isError,
			...(result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
			executionId,
		});
	}

	/** The model-facing result of a durable denial — no execution happened. */
	async *#denialResult(callId: string, reason: string): AsyncGenerator<Event> {
		const denial = denialResult(reason);
		yield this.#session.log.append({
			type: "tool_result",
			callId,
			content: denial.content,
			isError: true,
			errorKind: denial.errorKind,
		});
	}
}

/** Sentinel: the signal aborted while the recovery awaited a decision. */
const ABORTED = Symbol("kiso-resume-aborted");

/** Resolve with the decision, or ABORTED when the signal fires first. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignalLike): Promise<T | typeof ABORTED> {
	if (signal.aborted) return ABORTED;
	return new Promise<T | typeof ABORTED>((resolve) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(ABORTED);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				throw err;
			},
		);
	});
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
