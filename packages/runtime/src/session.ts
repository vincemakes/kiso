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
	type HookContext,
	type HookHost,
	type KisoExtension,
	type Message,
	type PermissionDecision,
	type Tool,
	type ToolResult,
} from "@vincemakes/kiso-core";
import { denialResult } from "@vincemakes/kiso-core";
import { StaleWriterError, type SessionStore, type StoreRecord } from "./store.js";

/** A session whose disk write was rejected (stale handle) is PERMANENTLY
 * poisoned: its in-memory log no longer matches the disk, so no further
 * run may proceed — reload the session (一). */
export class PoisonedSessionError extends Error {
	constructor(reason: string) {
		super(`session is poisoned: ${reason} — reload it; the in-memory log no longer matches the disk`);
		this.name = "PoisonedSessionError";
	}
}

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
	readonly #uncertaintyResolvers = new Map<string, (resolution: "rerun" | "abandoned") => void>();
	readonly #answered = new Set<string>();
	/** 七: verdicts already passed to a live resolver — the resolution event
	 *  lands in the log asynchronously (the loop owns it), so the ledger
	 *  alone cannot make resolveUncertain idempotent across the same tick. */
	readonly #uncertaintyAnswered = new Set<string>();
	/** 第四轮(对抗): verdicts the human GAVE, recorded when passed to a live
	 *  resolver. If an abort races the verdict, the loop / recovery queries
	 *  these and records the decision (exactly once) instead of losing it. */
	readonly #approvalVerdicts = new Map<string, boolean>();
	readonly #uncertaintyVerdicts = new Map<string, "rerun" | "abandoned">();
	/** 第五轮(P1-5): verdicts submitted to a LIVE resolver but not yet known
	 *  durable. An async generator only advances on next(), so approve()/
	 *  resolveUncertain() CANNOT wait for the loop to persist — that would
	 *  deadlock (the consumer waits while the generator needs a next()).
	 *  Instead the verdict is recorded here, and the Run's iterator FINALLY
	 *  flushes every not-yet-durable verdict to disk — an abandoned generator
	 *  can never lose a verdict the human gave. */
	readonly #pendingDurableApprovals = new Map<string, boolean>();
	readonly #pendingDurableUncertainties = new Map<string, { resolution: "rerun" | "abandoned"; callId: string }>();
	#poisoned: string | null = null;

	/** Permanently invalidate the session after a rejected disk write (一). */
	poison(reason: string): void {
		if (this.#poisoned === null) this.#poisoned = reason;
	}

	ensureHealthy(): void {
		if (this.#poisoned !== null) throw new PoisonedSessionError(this.#poisoned);
	}

	readonly #activeRuns = new Set<Run>();

	constructor(id: string, log: EventLog, store: SessionStore, adapter: Adapter, config: SessionConfig) {
		this.id = id;
		this.log = log;
		this.#store = store;
		this.#adapter = adapter;
		// E1: extension tools join the registry. The collision check already
		// happened at agent creation (loud startup error); the idempotent
		// skip keeps a second session on the same registry from re-registering.
		for (const ext of config.extensions ?? []) {
			for (const tool of ext.tools ?? []) {
				if (!config.registry.has(tool.name)) config.registry.register(tool);
			}
		}
		const composedHooks = composeHooks(config.hooks, config.extensions ?? []);
		this.#config = composedHooks === undefined ? config : { ...config, hooks: composedHooks };
	}

	/** Write-ahead through the store; a rejected write POISONS the session
	 *  (一/第四轮): the in-memory log no longer matches the disk — whatever
	 *  the cause (stale handle, corruption, a live external writer, an I/O
	 *  fault) — so no further run, resume, or log mutation may proceed.
	 *  The health check runs BEFORE every write, on every path. */
	async persist(runId: string, event: Event): Promise<void> {
		this.ensureHealthy();
		try {
			await this.#store.append(this.id, runId, event);
		} catch (err) {
			// 第四轮: ANY rejected write poisons — not only the typed
			// stale/corruption errors. A live external writer's lock error
			// is the realistic case; the in-memory log is ahead of the disk
			// in all of them.
			this.poison((err as Error).message);
			throw err;
		}
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
		this.ensureHealthy();
		return new Run(this.#store, this.#adapter, this.#config, this, input, options?.signal, false);
	}

	/**
	 * Continue the interrupted run (Area 2): apply durable decisions,
	 * fill missing receipts, resume the pause, and drive the original
	 * trajectory to its terminal — WITHOUT inventing a new user turn.
	 * Yields nothing when the session already completed.
	 */
	resume(): Run {
		this.ensureHealthy();
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
	async approve(decisionId: string, allow: boolean): Promise<void> {
		// 第四轮: a poisoned session may not mutate the log — checked before
		// anything is recorded.
		this.ensureHealthy();
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
			// 第四轮(对抗): recorded so an abort racing the verdict cannot
			// lose it — the loop's abort path consults approvalVerdict.
			this.#approvalVerdicts.set(decisionId, allow);
			// 第五轮(P1-5): the verdict is SUBMITTED — the Run's finally
			// flushes it to disk if the generator never gets to persist it.
			// (Waiting here for durability would deadlock: the generator
			// only advances on the consumer's next(), which the consumer
			// cannot issue while awaiting approve().)
			this.#pendingDurableApprovals.set(decisionId, allow);
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
		await this.persist(runId, decided);
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
	async resolveUncertain(executionId: string, resolution: "rerun" | "abandoned"): Promise<void> {
		// 第四轮: a poisoned session may not mutate the log.
		this.ensureHealthy();
		const record = executionLedger(this.log.all).get(executionId);
		if (!record) throw new Error(`no execution record for ${executionId}`);
		if (record.status !== "uncertain") return; // idempotent + irreversible
		// 七: a verdict already passed to a live resolver is FINAL — the
		// loop's resolution event lands asynchronously, so the ledger alone
		// cannot make this idempotent across the same tick.
		if (this.#uncertaintyAnswered.has(executionId)) return;
		this.#uncertaintyAnswered.add(executionId);
		// 七: with a LIVE resolver, the active loop / recovery generator
		// OWNS the resolution event — it appends, yields, and persists it
		// through the Run, so the consumer's stream and the durable log
		// stay identical. We only pass the verdict; a hidden append here
		// would leave a seq gap. 第四轮(对抗): the verdict is recorded so an
		// abort racing it cannot lose it.
		const resolver = this.#uncertaintyResolvers.get(executionId);
		if (resolver !== undefined) {
			this.#uncertaintyVerdicts.set(executionId, resolution);
			// 第五轮(P1-5): submitted — flushed to disk by the Run's finally
			// if the generator never persists it.
			this.#pendingDurableUncertainties.set(executionId, { resolution, callId: record.callId });
			this.#uncertaintyResolvers.delete(executionId);
			resolver(resolution);
			return;
		}
		// 七: OFFLINE verdict — no live resolver: persist directly.
		// 四: the verdict is attributed to the ORIGINAL run of the execution
		// — never the fake runId "resolution".
		const runId = this.runIdFor(executionId);
		const resolved = this.log.append({
			type: "tool_execution_resolved",
			executionId,
			callId: record.callId,
			resolution,
		});
		await this.persist(runId, resolved);
		// 四: the fill is keyed by THIS execution — a tool_result belonging to
		// a different (same-callId) execution must not suppress the verdict's
		// model-facing result, and the fill itself carries the executionId.
		// 八(对抗): the fill also carries the tags from the durable RECEIPT —
		// the normal live path emits the result with tags before the pause,
		// so a crash-window repair reproduces them.
		if (!this.log.all.some((e) => e.type === "tool_result" && e.executionId === record.executionId)) {
			const denial = denialResult(
				resolution === "rerun"
					? "interrupted execution — rerun approved: the attempt is treated as NOT applied; the model may retry"
					: "abandoned by human decision — the interrupted attempt must not be treated as applied",
			);
			const receipt = [...this.log.all]
				.reverse()
				.find(
					(e): e is Event & { type: "tool_execution_failed" | "tool_execution_succeeded"; tags?: readonly string[] } =>
						(e.type === "tool_execution_failed" || e.type === "tool_execution_succeeded") &&
						e.executionId === executionId,
				);
			const result = this.log.append({
				type: "tool_result",
				callId: record.callId,
				content: denial.content,
				isError: true,
				errorKind: denial.errorKind,
				...(receipt?.tags !== undefined ? { tags: receipt.tags } : {}),
				executionId: record.executionId,
			});
			await this.persist(runId, result);
		}
	}

	/** The runId that owns an execution — from its durable started record. */
	private runIdFor(executionId: string): string {
		const rec = this.#store
			.load(this.id)
			.find(
				(r) =>
					r.event.type === "tool_execution_started" &&
					(r.event as { executionId?: string }).executionId === executionId,
			);
		if (!rec) throw new Error(`no durable execution record for ${executionId}`);
		return rec.runId;
	}

	registerUncertaintyResolver(executionId: string, resolve: (resolution: "rerun" | "abandoned") => void): void {
		this.#uncertaintyResolvers.set(executionId, resolve);
	}

	dropUncertaintyResolver(executionId: string): void {
		this.#uncertaintyResolvers.delete(executionId);
	}

	// ── internal: the resolver registry ──────────────────────────────────

	registerResolver(decisionId: string, resolve: (decision: PermissionDecision) => void): void {
		this.#pendingResolvers.set(decisionId, resolve);
	}

	/** 第四轮(对抗): a verdict the human already gave for a live decision. */
	approvalVerdict(decisionId: string): boolean | undefined {
		return this.#approvalVerdicts.get(decisionId);
	}

	/** 第四轮(对抗): a verdict the human already gave for a live execution. */
	uncertaintyVerdict(executionId: string): "rerun" | "abandoned" | undefined {
		return this.#uncertaintyVerdicts.get(executionId);
	}

	/**
	 * 第五轮(P1-5): flush every verdict submitted to a live resolver that is
	 * not yet durable. Called from the Run iterator's FINALLY — whether the
	 * run completed, aborted, or was abandoned by the consumer. An event the
	 * loop already appended is left alone (its persist precedes its yield);
	 * a missing event is appended here and persisted, attributed to the run.
	 */
	async flushPendingVerdicts(runId: string, log: EventLog): Promise<void> {
		for (const [decisionId, allow] of this.#pendingDurableApprovals) {
			const decided = log.all.find(
				(e): e is Event & { type: "permission_decided" } => e.type === "permission_decided" && e.decisionId === decisionId,
			);
			if (decided === undefined) {
				const app = log.append({
					type: "permission_decided",
					decisionId,
					decision: allow ? "approved" : "denied",
					...(allow ? {} : { reason: "denied by user" }),
				});
				await this.persist(runId, app);
			}
			this.#pendingDurableApprovals.delete(decisionId);
		}
		for (const [executionId, pending] of this.#pendingDurableUncertainties) {
			const resolved = log.all.find(
				(e): e is Event & { type: "tool_execution_resolved" } =>
					e.type === "tool_execution_resolved" && e.executionId === executionId,
			);
			if (resolved === undefined) {
				const app = log.append({
					type: "tool_execution_resolved",
					executionId,
					callId: pending.callId,
					resolution: pending.resolution,
				});
				await this.persist(runId, app);
			}
			this.#pendingDurableUncertainties.delete(executionId);
		}
	}

	dropResolver(decisionId: string): void {
		this.#pendingResolvers.delete(decisionId);
	}
}

export interface SessionConfig {
	readonly model: string;
	readonly systemPrompt?: string;
	readonly tools?: readonly Tool<any>[];
	readonly registry: import("@vincemakes/kiso-core").ToolRegistry;
	readonly hooks?: import("@vincemakes/kiso-core").HookHost;
	readonly maxTurns?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly compaction?: { readonly thresholdTokens: number };
	/** C 区: microcompact threshold — passed through to the loop verbatim. */
	readonly microcompact?: { readonly thresholdTokens: number };
	readonly maxRetries?: number;
	/**
	 * E1: loaded extensions — their tools join the registry (idempotently;
	 * a collision with a built-in name was already rejected at agent
	 * creation), their hooks compose AFTER the existing ones (既有先行),
	 * their approval policies enter the loop's policy chain.
	 */
	readonly extensions?: readonly KisoExtension[];
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
	readonly #uncertaintyIds: string[] = [];
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
			// 第四轮: health is re-checked when the iterator ACTUALLY starts —
			// a run constructed before the session was poisoned must fail
			// here, before any log or disk mutation.
			this.#session.ensureHealthy();
			this.#session.beginRun(this);
			const log = this.#session.log;
			const signal = this.#externalSignal ? new MergedSignal(this.#abort.signal, this.#externalSignal) : this.#abort.signal;
			// E2: the session's own microcompact wins; otherwise the FIRST
			// extension providing a compaction config supplies it.
			const microcompact = microcompactFor(this.#config);
			// E2: the session's own systemPrompt first, then every extension
			// append in LOAD order — deterministic (same extensions → same
			// prompt); no appends → byte-identical to the extension-less run.
			const systemPrompt = composeSystemPrompt(this.#config.systemPrompt, this.#config.extensions ?? []);
			const loopConfig = () =>
				({
					adapter: this.#adapter,
					model: this.#config.model,
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
					registry: this.#config.registry,
					...(this.#config.hooks !== undefined ? { hooks: this.#config.hooks } : {}),
					...(this.#config.maxTurns !== undefined ? { maxTurns: this.#config.maxTurns } : {}),
					...(this.#config.maxTokens !== undefined ? { maxTokens: this.#config.maxTokens } : {}),
					...(this.#config.temperature !== undefined ? { temperature: this.#config.temperature } : {}),
					...(this.#config.compaction !== undefined ? { compaction: this.#config.compaction } : {}),
					...(microcompact !== undefined ? { microcompact } : {}),
					...(this.#config.maxRetries !== undefined ? { maxRetries: this.#config.maxRetries } : {}),
					approvalPolicies: (this.#config.extensions ?? []).flatMap((e) =>
						(e.approvals ?? []).map((policy) => ({ extension: e.name, policy })),
					),
					log,
					signal,
					resolveApproval: (decisionId: string) =>
						new Promise<PermissionDecision>((resolve) => {
							this.#decisionIds.push(decisionId);
							this.#session.registerResolver(decisionId, resolve);
						}),
					// 第四轮(对抗): the abort paths consult these so a verdict
					// the human gave in the same instant as the abort is
					// recorded, exactly once.
					approvalVerdict: (decisionId: string) => this.#session.approvalVerdict(decisionId),
					uncertaintyVerdict: (executionId: string) => this.#session.uncertaintyVerdict(executionId),
					resolveUncertainty: (executionId: string) =>
						new Promise<"rerun" | "abandoned">((resolve) => {
							this.#uncertaintyIds.push(executionId);
							this.#session.registerUncertaintyResolver(executionId, resolve);
						}),
				}) satisfies Parameters<typeof loop>[0];

			const self = this;
			const runLoop = async function* (): AsyncGenerator<Event> {
				for await (const ev of loop(loopConfig())) {
					await self.#session.persist(self.runId, ev);
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
						await this.#session.persist(runId, expired);
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
				const persist = async (ev: Event): Promise<void> => {
					if (ev.seq > baseSeq) await this.#session.persist(this.runId, ev);
				};
				for await (const ev of this.#recover(log, signal, lastOpen.events)) {
					await persist(ev);
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

			// 四: a session with an open run REFUSES new runs at the
			// persistence layer — a second open run would be permanently
			// orphaned (recovery only ever recovers the last one). The
			// open run is continued via resume(), never by starting another.
			const openRun = openRunId(this.#store.load(this.#session.id));
			if (openRun !== undefined) {
				throw new Error(
					`session ${this.#session.id} still has an open run (${openRun}) — resume() it instead of starting a new run`,
				);
			}

			// 1. Durable first: the prompt enters the log and the store
			//    before any model call — a crash here leaves a restorable
			//    session. The prompt is also the first event the consumer
			//    sees, so what was asked and what happened live in the same
			//    stream.
			const inputEvent = log.append({ type: "user_input", content: this.#input! });
			await this.#session.persist(this.runId, inputEvent);
			yield inputEvent;

			// 2. The loop projects from the session log — multi-turn context
			//    is the projection, not a second copy.
			for await (const ev of runLoop()) yield ev;
		} finally {
			// 第五轮(P1-5): flush verdicts the consumer submitted before the
			// generator was abandoned — an approve()/resolveUncertain() whose
			// durable event the loop never got to persist must STILL land on
			// disk, exactly once.
			try {
				await this.#session.flushPendingVerdicts(this.runId, this.#session.log);
			} catch {
				// the flush itself failed (poisoned session) — the error
				// already poisoned everything; nothing more can be done.
			}
			// The run is over (or abandoned): its unanswered approvals must
			// fall back to the direct-persist path, so a late approve() is
			// still durable.
			for (const decisionId of this.#decisionIds) {
				this.#session.dropResolver(decisionId);
			}
			for (const executionId of this.#uncertaintyIds) {
				this.#session.dropUncertaintyResolver(executionId);
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
			// 四: paired by events NEWER than the request — a historical
			// same-callId execution from an earlier run must not count as THIS
			// request's execution (the provider callId may repeat across runs).
			const hasExecution = log.all.some(
				(e) => e.type === "tool_execution_started" && e.callId === pending.callId && e.seq > pending.seq,
			);
			const hasResult = log.all.some(
				(e) => e.type === "tool_result" && e.callId === pending.callId && e.seq > pending.seq,
			);

			if (decided === undefined) {
				// Pause: announce the stored request, await the human.
				const pendingDecision = new Promise<PermissionDecision>((resolve) => {
					this.#decisionIds.push(pending.decisionId);
					this.#session.registerResolver(pending.decisionId, resolve);
				});
				yield pending;
				// Area 4: an abort during the resumed approval wait ends the
				// run; the request stays durable and pending.
				if (signal.aborted) {
					// 第五轮(P1-6): a verdict given in the same instant as the
					// abort is still recorded — the abort must not bypass the
					// durable fallback (aligned with the loop's abort path).
					const verdict = this.#session.approvalVerdict(pending.decisionId);
					if (verdict !== undefined) {
						yield log.append({
							type: "permission_decided",
							decisionId: pending.decisionId,
							callId: pending.callId,
							decision: verdict ? "approved" : "denied",
							...(verdict ? {} : { reason: "denied by user" }),
						});
					}
					return;
				}
				const final = await abortable(pendingDecision, signal);
				if (final === ABORTED) {
					// 第四轮(对抗): a verdict given in the same instant as the
					// abort is recorded (exactly once), never lost.
					const verdict = this.#session.approvalVerdict(pending.decisionId);
					if (verdict !== undefined) {
						yield log.append({
							type: "permission_decided",
							decisionId: pending.decisionId,
							callId: pending.callId,
							decision: verdict ? "approved" : "denied",
							...(verdict ? {} : { reason: "denied by user" }),
						});
					}
					return;
				}
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
		// re-visit them. 四: pairing is by executionId — a same-callId result
		// from a different execution never suppresses the repair.
		for (const ev of [...scope]) {
			if (ev.type !== "tool_execution_succeeded" && ev.type !== "tool_execution_failed") continue;
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.executionId === ev.executionId);
			if (hasResult) continue;
			yield log.append(
				ev.type === "tool_execution_succeeded"
					? {
							type: "tool_result",
							callId: ev.callId,
							content: ev.result.content,
							isError: false,
							// 八: the repaired result reproduces the normal path
							// losslessly — the tags ride on the durable receipt.
							...(ev.tags !== undefined ? { tags: ev.tags } : {}),
							executionId: ev.executionId,
						}
					: {
							type: "tool_result",
							callId: ev.callId,
							content: ev.error,
							isError: true,
							...(ev.errorKind !== undefined ? { errorKind: ev.errorKind } : {}),
							...(ev.tags !== undefined ? { tags: ev.tags } : {}),
							executionId: ev.executionId,
						},
			);
		}

		// B 组 crash window: a resolution was persisted but its tool_result
		// fill never landed — complete it so the model is never left staring
		// at a dangling tool_use. 四: keyed by executionId, and the fill
		// carries it, so a same-callId result from another execution is never
		// confused with this one.
		for (const ev of [...scope]) {
			if (ev.type !== "tool_execution_resolved") continue;
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.executionId === ev.executionId);
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
				executionId: ev.executionId,
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
				// P1-9: errorKind only exists on errors — runtime-guarded too.
			...(result.isError && result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
				safeToRetry: tool?.idempotent === true,
				...(result.tags !== undefined ? { tags: result.tags } : {}),
			});
		} else {
			yield log.append({
				type: "tool_execution_succeeded",
				executionId,
				callId,
				result: { content: result.content, isError: false },
				...(result.tags !== undefined ? { tags: result.tags } : {}),
			});
		}
		yield log.append({
			type: "tool_result",
			callId,
			content: result.content,
			isError: result.isError,
			// P1-9: errorKind only exists on errors — runtime-guarded too.
			...(result.isError && result.errorKind !== undefined ? { errorKind: result.errorKind } : {}),
			// 五: live tags survive the resumed path too.
			...(result.tags !== undefined ? { tags: result.tags } : {}),
			executionId,
		});
		// 四: a failed NON-idempotent execution after a cross-process approval
		// is a durable uncertain PAUSE, exactly like the live loop's — the
		// provider and any sibling executions stop until a human decides.
		// An abort during the wait leaves the execution uncertain; the next
		// resume blocks on it (ResumeBlockedError) instead of continuing.
		if (result.isError && tool !== undefined && tool.idempotent !== true) {
			const pendingResolution = new Promise<"rerun" | "abandoned">((resolve) => {
				this.#uncertaintyIds.push(executionId);
				this.#session.registerUncertaintyResolver(executionId, resolve);
			});
			const pendingUncertain = log.append({
				type: "uncertain_pending",
				executionId,
				callId,
				name,
				error: result.content,
			});
			yield pendingUncertain;
			const verdict = await abortable(pendingResolution, signal);
			if (verdict === ABORTED) {
				// 第四轮(对抗): a verdict given in the same instant as the
				// abort is recorded (exactly once), never lost.
				const given = this.#session.uncertaintyVerdict(executionId);
				if (given !== undefined) {
					yield log.append({
						type: "tool_execution_resolved",
						executionId,
						callId,
						resolution: given,
					});
				}
				return;
			}
			// 七: the recovery generator owns the resolution event — appended
			// and yielded here, persisted by the Run's wrapper (a live
			// resolveUncertain() only passed the verdict).
			yield log.append({
				type: "tool_execution_resolved",
				executionId,
				callId,
				resolution: verdict,
			});
		}
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

/**
 * E2: the session's systemPrompt plus every extension's append, in LOAD
 * order, \n\n-joined — deterministic (same extension list → same prompt).
 * No appends → the base passes through byte-identical.
 */
function composeSystemPrompt(base: string | undefined, extensions: readonly KisoExtension[]): string | undefined {
	const appends = extensions.flatMap((e) => (e.systemPrompt?.append === undefined ? [] : [e.systemPrompt.append]));
	if (appends.length === 0) return base;
	return base === undefined ? appends.join("\n\n") : `${base}\n\n${appends.join("\n\n")}`;
}

/**
 * E1: extension hooks compose AFTER the agent's own (既有先行 — the existing
 * hook sees every event first). Observers all run, in order; onUserMessage
 * and onPreTool — the FIRST decisive answer wins (the existing hook
 * outranks extensions; defers fall through); onPostTool folds — each
 * transforms the previous result. Returns the existing host unchanged when
 * no extension provides hooks.
 */
function composeHooks(existing: HookHost | undefined, extensions: readonly KisoExtension[]): HookHost | undefined {
	const extHooks = extensions.flatMap((e) => (e.hooks === undefined ? [] : [e.hooks]));
	if (extHooks.length === 0) return existing;
	const out: HookHost = { ...existing };
	const sources: readonly HookHost[] = existing === undefined ? extHooks : [existing, ...extHooks];
	type Observer = (payload: never, ctx: HookContext) => Promise<void>;
	const observers = (key: (h: HookHost) => Observer | undefined): Observer | undefined => {
		const handlers = sources.map(key).filter((h): h is Observer => h !== undefined);
		if (handlers.length <= 1) return handlers[0];
		return async (payload, ctx) => {
			for (const h of handlers) await h(payload, ctx);
		};
	};
	for (const key of ["onPreLlm", "onEvent", "onPreCompact", "onPostCompact", "onPause", "onStop"] as const) {
		const handler = observers((h) => h[key]);
		if (handler !== undefined) (out as Record<string, unknown>)[key] = handler;
	}
	const messageHandlers = sources
		.map((h) => h.onUserMessage)
		.filter((h): h is NonNullable<HookHost["onUserMessage"]> => h !== undefined);
	if (messageHandlers.length === 1) {
		out.onUserMessage = messageHandlers[0]!; // length 1 guarantees the element
	} else if (messageHandlers.length > 1) {
		// 复审 E1-P2: the pipe + veto short-circuit — each handler sees the
		// message as the PREVIOUS one left it (既有先行), and a null (veto)
		// anywhere ends the chain immediately: never "no opinion" for the
		// next handler to outvote. Adding an extension can therefore never
		// make the chain MORE permissive (the approval chain's deny>ask>allow
		// monotonicity, on the message side).
		out.onUserMessage = async (msg, ctx) => {
			let current = msg;
			for (const h of messageHandlers) {
				const r = await h(current, ctx);
				if (r === null) return null;
				current = r;
			}
			return current;
		};
	}
	const preToolHandlers = sources
		.map((h) => h.onPreTool)
		.filter((h): h is NonNullable<HookHost["onPreTool"]> => h !== undefined);
	if (preToolHandlers.length === 1) {
		out.onPreTool = preToolHandlers[0]!;
	} else if (preToolHandlers.length > 1) {
		out.onPreTool = async (call, ctx) => {
			for (const h of preToolHandlers) {
				const d = await h(call, ctx);
				if (d.action !== "defer") return d;
			}
			return { action: "defer" };
		};
	}
	const postToolHandlers = sources
		.map((h) => h.onPostTool)
		.filter((h): h is NonNullable<HookHost["onPostTool"]> => h !== undefined);
	if (postToolHandlers.length === 1) {
		out.onPostTool = postToolHandlers[0]!;
	} else if (postToolHandlers.length > 1) {
		out.onPostTool = async (call, result, ctx) => {
			let r = result;
			for (const h of postToolHandlers) r = await h(call, r, ctx);
			return r;
		};
	}
	return out;
}

/**
 * E2: the loop's microcompact config — the session's own microcompact wins;
 * otherwise the FIRST extension providing a compaction config supplies it.
 * An extension config without a threshold contributes nothing (a boundary
 * needs a threshold to ever fire).
 */
function microcompactFor(config: SessionConfig): { readonly thresholdTokens: number; readonly keepResults?: number } | undefined {
	if (config.microcompact !== undefined) return config.microcompact;
	for (const ext of config.extensions ?? []) {
		const c = ext.compaction;
		if (c !== undefined && c.thresholdTokens !== undefined) {
			return { thresholdTokens: c.thresholdTokens, ...(c.keepResults !== undefined ? { keepResults: c.keepResults } : {}) };
		}
	}
	return undefined;
}

/**
 * The most recent run WITHOUT a terminal, or undefined when every recorded
 * run terminated. Recovery can only drive ONE run to its terminal, so an
 * open run must be the exclusive reason a session refuses new runs (四).
 */
function openRunId(records: readonly StoreRecord[]): string | undefined {
	const terminated = new Set(records.filter((r) => r.event.type === "terminal").map((r) => r.runId));
	for (let i = records.length - 1; i >= 0; i--) {
		const runId = records[i]!.runId;
		if (!terminated.has(runId)) return runId;
	}
	return undefined;
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
