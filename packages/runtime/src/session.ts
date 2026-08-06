/**
 * AgentSession — the durable multi-turn conversation (Phase C/D).
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
 *
 * 手感批 B4 (pure move): the Run class lives in run.ts, the recovery
 * support in recovery.ts, the E1/E2 composition helpers in compose.ts —
 * same package, same exports (index.ts re-exports all four).
 */

import {
	EventLog,
	executionLedger,
	projectMessages,
	type AbortSignalLike,
	type Adapter,
	type Event,
	type KisoExtension,
	type Message,
	type PermissionDecision,
	type Tool,
} from "@vincemakes/kiso-core";
import { denialResult } from "@vincemakes/kiso-core";
import {
	estimateSummarySavings,
	KEEP_RECENT_ROUNDS,
	lastSummaryPoint,
	summarizeConversation,
	summaryBoundarySeq,
} from "@vincemakes/kiso-core";
import { StaleWriterError, type SessionStore } from "./store.js";
import { composeHooks } from "./compose.js";
import { Run } from "./run.js";

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

/** The /compact result — what the NoticeCell shows (ADR-0044). */
export interface SummarizeResult {
	readonly coversToSeq: number;
	readonly summary: string;
	/** The estimated tokens the compression saved (chars/4 proxy). */
	readonly savedTokens: number;
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

	/**
	 * /compact (ADR-0044): compress the older conversation with a model
	 * summary. Covers the range (previous summary point, boundary] —
	 * boundary = the event before the keepRounds-th most recent round —
	 * and persists ONE `summarized` event. The summary call is OFF-LOOP
	 * through the session's OWN adapter: it writes nothing; a failure
	 * throws and the session is unchanged ("nothing happened"). Returns
	 * null when fewer than keepRounds+1 uncovered rounds exist (nothing
	 * worth covering yet). Crash semantics: a crash BEFORE the persist is
	 * "nothing happened"; after it, a resume projects the compressed view.
	 */
	async summarize(options: { keepRounds?: number; signal?: AbortSignalLike } = {}): Promise<SummarizeResult | null> {
		this.ensureHealthy();
		const keepRounds = options.keepRounds ?? KEEP_RECENT_ROUNDS;
		const events = this.log.all;
		const boundary = summaryBoundarySeq(events, keepRounds);
		if (boundary === undefined) return null;
		const prevPoint = lastSummaryPoint(events);
		const covered = projectMessages(
			events.filter((e) => e.seq > prevPoint && e.seq <= boundary && e.type !== "summarized"),
		);
		const summary = await summarizeConversation({
			adapter: this.#adapter,
			model: this.#config.model,
			messages: covered,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		const full = this.log.append({ type: "summarized", coversToSeq: boundary, summary });
		// The record rides the LAST recorded run's id — a summarized fact
		// must never open a run of its own: the open-run gate keys on
		// terminal-less runIds, and a "compact" runId would block the next
		// run() ("still has an open run").
		const records = this.#store.load(this.id);
		const runId = records.length > 0 ? records[records.length - 1]!.runId : "compact";
		await this.persist(runId, full);
		return { coversToSeq: boundary, summary, savedTokens: estimateSummarySavings(covered, summary) };
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
	/**
	 * DEPRECATED (ADR-0044): forwarded to the loop's deprecated field,
	 * which IGNORES it — kept for type compatibility, removed at 1.0.
	 */
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
