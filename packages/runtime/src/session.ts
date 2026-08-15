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
 * the ergonomics batch B4 (pure move): the Run class lives in run.ts, the recovery
 * support in recovery.ts, the E1/E2 composition helpers in compose.ts —
 * same package, same exports (index.ts re-exports all four).
 */

import {
	EventLog,
	projectMessages,
	type AbortSignalLike,
	type Adapter,
	type Event,
	type KisoExtension,
	type Message,
	type PermissionDecision,
	type Tool,
} from "@vincemakes/kiso-core";
import { executionLedger } from "./ledger.js";
import { denialResult } from "@vincemakes/kiso-core";
import {
	DROP_PLACEHOLDER,
	estimateSummarySavings,
	KEEP_RECENT_ROUNDS,
	KEEP_TOKENS_DEFAULT,
	lastSummaryPoint,
	MAX_SUMMARY_FAILURES,
	policyTriggerFromWindow,
	serializeCovered,
	SUMMARY_MAX_OUTPUT,
	summarizeConversation,
	summaryBoundarySeq,
} from "./summarize.js";
import { canonicalizeUsage } from "./usage/canonical.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@vincemakes/kiso-core";
import { StaleWriterError, type SessionStore } from "./store.js";
import { composeHooks } from "./compose.js";
import { Run } from "./run.js";

/** A session whose disk write was rejected (stale handle) is PERMANENTLY
 * poisoned: its in-memory log no longer matches the disk, so no further
 * run may proceed — reload the session (round 1). */
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

/** W18: the knowable pre-call data, surfaced through onStart — everything
 *  the indicator's indeterminate row shows (rounds, the token estimate)
 *  is computed locally BEFORE the one adapter call; no fraction exists. */
export interface CompactInfo {
	readonly coversToSeq: number;
	/** The covered user rounds — the inputs in (previous summary point, boundary]. */
	readonly rounds: number;
	/** The covered content's estimated tokens (the chars/4 proxy). */
	readonly tokens: number;
}

/** @deprecated the canonical name is `Session` (root export, 1.1.0); this alias is removed in the next major. */
export class AgentSession {
	readonly id: string;
	readonly log: EventLog;
	readonly #store: SessionStore;
	// NOT readonly since 0.1.23: /model replaces it between runs (the
	// constructor and setAdapter are the only writers).
	#adapter: Adapter;
	readonly #config: SessionConfig;
	readonly #pendingResolvers = new Map<string, (decision: PermissionDecision) => void>();
	readonly #uncertaintyResolvers = new Map<string, (resolution: "rerun" | "abandoned") => void>();
	readonly #answered = new Set<string>();
	/** round 7: verdicts already passed to a live resolver — the resolution event
	 *  lands in the log asynchronously (the loop owns it), so the ledger
	 *  alone cannot make resolveUncertain idempotent across the same tick. */
	readonly #uncertaintyAnswered = new Set<string>();
	/** round 4 (adversarial): verdicts the human GAVE, recorded when passed to a live
	 *  resolver. If an abort races the verdict, the loop / recovery queries
	 *  these and records the decision (exactly once) instead of losing it. */
	readonly #approvalVerdicts = new Map<string, boolean>();
	readonly #uncertaintyVerdicts = new Map<string, "rerun" | "abandoned">();
	/** round 5(P1-5): verdicts submitted to a LIVE resolver but not yet known
	 *  durable. An async generator only advances on next(), so approve()/
	 *  resolveUncertain() CANNOT wait for the loop to persist — that would
	 *  deadlock (the consumer waits while the generator needs a next()).
	 *  Instead the verdict is recorded here, and the Run's iterator FINALLY
	 *  flushes every not-yet-durable verdict to disk — an abandoned generator
	 *  can never lose a verdict the human gave. */
	readonly #pendingDurableApprovals = new Map<string, boolean>();
	readonly #pendingDurableUncertainties = new Map<string, { resolution: "rerun" | "abandoned"; callId: string }>();
	#poisoned: string | null = null;
	/** E6 (h): the circuit-breaker counter — consecutive auto-policy
	 *  summary failures this session (a success resets it). */
	#summaryFailures = 0;

	/** Permanently invalidate the session after a rejected disk write (round 1). */
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
	 *  (round 1/round 4): the in-memory log no longer matches the disk — whatever
	 *  the cause (stale handle, corruption, a live external writer, an I/O
	 *  fault) — so no further run, resume, or log mutation may proceed.
	 *  The health check runs BEFORE every write, on every path. */
	async persist(runId: string, event: Event): Promise<void> {
		this.ensureHealthy();
		try {
			await this.#store.append(this.id, runId, event);
		} catch (err) {
			// round 4: ANY rejected write poisons — not only the typed
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

	/**
	 * merge round B (/model): replace the adapter for SUBSEQUENT runs. The
	 * kernel reads the adapter through the loop-config closure at each
	 * turn, so the swap takes effect at the next turn — a run already in
	 * flight keeps the adapter it started with. The CLI calls this between
	 * turns (dispatch's /model), never mid-run.
	 */
	setAdapter(adapter: Adapter): void {
		this.#adapter = adapter;
	}

	/** E2: the adapter identity ("anthropic" | "openai-compat") — the route
	 *  key the canonical consumer (CLI usage, the trace block) keys on. The
	 *  per-run tracer reads the SAME #config.provider; one source, one
	 *  route — the CLI and the trace can never disagree. */
	get provider(): "anthropic" | "openai-compat" | undefined {
		return this.#config.provider;
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
	async summarize(options: { keepRounds?: number; keepTokens?: number; signal?: AbortSignalLike; onStart?: (info: CompactInfo) => void; drop?: boolean } = {}): Promise<SummarizeResult | null> {
		this.ensureHealthy();
		const keepRounds = options.keepRounds ?? KEEP_RECENT_ROUNDS;
		// W18: the signal is observed at EVERY phase boundary — the cancel
		// affordance works for the whole call (local work included), never
		// just the adapter's wait. The abort error is the honest "nothing
		// happened" outcome (ADR-0044 crash semantics).
		const cancelled = (): Error => new Error("the compaction was cancelled");
		if (options.signal !== undefined && options.signal.aborted) throw cancelled();
		const events = this.log.all;
		const boundary = summaryBoundarySeq(events, keepRounds, options.keepTokens);
		if (boundary === undefined) return null;
		const prevPoint = lastSummaryPoint(events);
		// E6 (a): the summarizer's input is the covered range SERIALIZED to
		// flat text — one guarded <conversation> user message — never the raw
		// provider message array (the auto-T5-1 DSML garbage). The projected
		// messages still feed the pre-call token estimate and the savings
		// figure (estimate-only, never the model input).
		const covered = projectMessages(
			events.filter((e) => e.seq > prevPoint && e.seq <= boundary && e.type !== "summarized"),
		);
		const serializedInput = serializeCovered({ events, prevPoint, boundary });
		// W18: the indicator's pre-call data — rounds + the token estimate
		// are knowable BEFORE the adapter call; the summary itself is ONE
		// call with no fraction (kiso never invents a percentage here).
		if (options.signal !== undefined && options.signal.aborted) throw cancelled();
		options.onStart?.({
			coversToSeq: boundary,
			rounds: events.filter((e) => e.type === "user_input" && e.seq > prevPoint && e.seq <= boundary).length,
			tokens: estimateTokens(covered),
		});
		let summary: string;
		let usage: import("./usage/canonical.js").RawUsage | null = null;
		if (options.drop === true) {
			// E6 — the crux drop arm: mechanical, no model call, the fixed
			// placeholder replaces the covered range (experiment-only).
			summary = DROP_PLACEHOLDER;
		} else {
			const call = await summarizeConversation({
				adapter: this.#adapter,
				model: this.#config.model,
				// E6 (a): ONE serialized user message — the DSML bug's
				// raw-message array is structurally dead on this path.
				messages: [{ role: "user", content: serializedInput }],
				// E6 (g): the summary call ALWAYS carries the explicit
				// output budget — 4,000 adapter maxTokens (a wire-level
				// truncation is caught by the (b) required-section
				// validation, never silently passed).
				maxOutputTokens: SUMMARY_MAX_OUTPUT,
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			});
			summary = call.text;
			usage = call.usage;
		}
		// The post-call boundary check: an abort that landed while the
		// adapter returned must NOT persist — "nothing happened".
		if (options.signal !== undefined && options.signal.aborted) throw cancelled();
		const full = this.log.append({ type: "summarized", coversToSeq: boundary, summary });
		// The record rides the LAST recorded run's id — a summarized fact
		// must never open a run of its own: the open-run gate keys on
		// terminal-less runIds, and a "compact" runId would block the next
		// run() ("still has an open run").
		const records = this.#store.load(this.id);
		const runId = records.length > 0 ? records[records.length - 1]!.runId : "compact";
		await this.persist(runId, full);
		// E6 — the honest accounting: the summary call's usage rides the
		// trace ledger as a `kind: "summary"` line (the fifth ledger kind,
		// observation-only — the request/run_end/crash vocabulary stands).
		// The E5-era extraction could not see the call at all; both the
		// manual /compact path and the auto policy land here. Soft-fail:
		// a degraded ledger costs one stderr line, never the summary.
		if (usage !== null) {
			try {
				const canonical = canonicalizeUsage(this.#config.provider ?? "adapter", usage);
				const line = JSON.stringify({ kind: "summary", canonical }) + "\n";
				mkdirSync(join(this.#store.root, "traces"), { recursive: true });
				appendFileSync(join(this.#store.root, "traces", `${this.id}.jsonl`), line);
			} catch (err) {
				console.error(
					`[kiso] summary usage ledger degraded (${err instanceof Error ? err.message : String(err)}); the summary call's cost is not recorded`,
				);
			}
		}
		return { coversToSeq: boundary, summary, savedTokens: estimateSummarySavings(covered, summary) };
	}

	/**
	 * E6 — the run-start context policy (candidate A + the crux drop arm).
	 * Called at the start of every FRESH run, BEFORE its user_input lands:
	 * when the policy is armed and the projected context crosses the
	 * trigger (and enough uncovered rounds exist — the keepRounds gate
	 * inside summarize), one `summarized` fact is persisted through the
	 * existing summarize() path. The boundary then rides the LAST recorded
	 * run and the run's first request projects the compressed view.
	 * Restraint: a short session never crosses the trigger — firing is a
	 * net loss by the E5-F1 accounting (a break that cannot amortize).
	 * Failure is swallowed: the compaction is an optimization — "nothing
	 * happened" must never break the user's turn.
	 */
	async maybeApplyContextPolicy(signal?: AbortSignalLike): Promise<void> {
		const policy = this.#config.contextPolicy;
		if (policy === undefined) return;
		const mode = policy.drop ?? policy.summary;
		if (mode === undefined) return;
		// E6 (g): the trigger is exactly one of triggerTokens (absolute)
		// or windowTokens (window − POLICY_RESERVE, the product arming).
		// The undefined guard is the belt: `projected <= undefined` is
		// ALWAYS false, so a naive gate would fall THROUGH and fire
		// unconditionally — an unresolved trigger must never fire.
		const triggerTokens =
			mode.windowTokens !== undefined ? policyTriggerFromWindow(mode.windowTokens) : mode.triggerTokens;
		if (triggerTokens === undefined) return;
		// E6 (h): the circuit breaker — after maxFailures consecutive
		// summary failures the auto policy stands down for the rest of
		// the session (a persistent failure — a broken provider, a
		// hostile model — must never wedge the session into paying the
		// summary call every run).
		const maxFailures = mode.maxFailures ?? MAX_SUMMARY_FAILURES;
		if (this.#summaryFailures >= maxFailures) return;
		if (estimateTokens(this.projected()) <= triggerTokens) return;
		try {
			await this.summarize({
				keepRounds: mode.keepRounds ?? KEEP_RECENT_ROUNDS,
				// E6 (f): the keep budget is rounds AND tokens — the policy
				// layer applies the 20k floor by default (small sessions are
				// inert: the E5-F1 restraint, token-shaped).
				keepTokens: mode.keepTokens ?? KEEP_TOKENS_DEFAULT,
				...(signal !== undefined ? { signal } : {}),
				...(policy.drop !== undefined ? { drop: true } : {}),
			});
			// A persisted fire resets the breaker — the failures were a
			// transient blip, the budget starts fresh.
			this.#summaryFailures = 0;
		} catch {
			// the compaction failed — the session is unchanged and the run
			// proceeds with the full context (the ADR-0044 "nothing
			// happened" crash semantics, policy-shaped). The failure counts
			// toward the breaker (both adapter failures and (b) rejections
			// land here).
			this.#summaryFailures += 1;
		}
	}

	// ── Phase D: approvals ───────────────────────────────────────────────

	/**
	 * Pauses that still await a human decision (durable, survives restart).
	 * B group: a request whose RUN has terminated is DEAD — it is neither
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
	 * W21: an optional reason rides a DENIAL (the panel's feedback — the
	 * tool_result carries `[Permission denied] <the words>`); allow reasons
	 * are never persisted (the words ride the next user turn instead).
	 */
	async approve(decisionId: string, allow: boolean, reason?: string): Promise<void> {
		// round 4: a poisoned session may not mutate the log — checked before
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
		// B group: a late approve() on a TERMINATED run writes nothing and
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
			// round 4 (adversarial): recorded so an abort racing the verdict cannot
			// lose it — the loop's abort path consults approvalVerdict.
			this.#approvalVerdicts.set(decisionId, allow);
			// round 5(P1-5): the verdict is SUBMITTED — the Run's finally
			// flushes it to disk if the generator never gets to persist it.
			// (Waiting here for durability would deadlock: the generator
			// only advances on the consumer's next(), which the consumer
			// cannot issue while awaiting approve().)
			this.#pendingDurableApprovals.set(decisionId, allow);
			this.#pendingResolvers.delete(decisionId);
			// W21: the panel's feedback rides the denial — the tool_result
			// carries `[Permission denied] <the words>` (the rejection
			// asymmetry: words keep the run alive).
			resolver(allow ? { action: "allow" } : { action: "deny", reason: reason ?? "denied by user" });
			return;
		}
		const runId = request?.runId ?? "approval";
		const decided = this.log.append({
			type: "permission_decided",
			decisionId,
			...(request !== undefined ? { callId: (request.event as { callId: string }).callId } : {}),
			decision: allow ? "approved" : "denied",
			...(allow ? {} : { reason: reason ?? "denied by user" }),
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
	 * (B group): "rerun" (the human says the side effect did NOT happen — the
	 * attempt is completed with a recorded failure so the model may re-issue
	 * it as a new logical call) or "abandoned" (treated as failed forever).
	 * Only uncertain → rerun/abandoned is legal; a resolved or successful
	 * execution is left untouched (idempotent, irreversible). Both fill a
	 * model-facing result — a dangling tool_use with NO result would be
	 * rejected by real providers (review finding 1).
	 */
	async resolveUncertain(executionId: string, resolution: "rerun" | "abandoned"): Promise<void> {
		// round 4: a poisoned session may not mutate the log.
		this.ensureHealthy();
		const record = executionLedger(this.log.all).get(executionId);
		if (!record) throw new Error(`no execution record for ${executionId}`);
		if (record.status !== "uncertain") return; // idempotent + irreversible
		// round 7: a verdict already passed to a live resolver is FINAL — the
		// loop's resolution event lands asynchronously, so the ledger alone
		// cannot make this idempotent across the same tick.
		if (this.#uncertaintyAnswered.has(executionId)) return;
		this.#uncertaintyAnswered.add(executionId);
		// round 7: with a LIVE resolver, the active loop / recovery generator
		// OWNS the resolution event — it appends, yields, and persists it
		// through the Run, so the consumer's stream and the durable log
		// stay identical. We only pass the verdict; a hidden append here
		// would leave a seq gap. round 4 (adversarial): the verdict is recorded so an
		// abort racing it cannot lose it.
		const resolver = this.#uncertaintyResolvers.get(executionId);
		if (resolver !== undefined) {
			this.#uncertaintyVerdicts.set(executionId, resolution);
			// round 5(P1-5): submitted — flushed to disk by the Run's finally
			// if the generator never persists it.
			this.#pendingDurableUncertainties.set(executionId, { resolution, callId: record.callId });
			this.#uncertaintyResolvers.delete(executionId);
			resolver(resolution);
			return;
		}
		// round 7: OFFLINE verdict — no live resolver: persist directly.
		// round 4: the verdict is attributed to the ORIGINAL run of the execution
		// — never the fake runId "resolution".
		const runId = this.runIdFor(executionId);
		const resolved = this.log.append({
			type: "tool_execution_resolved",
			executionId,
			callId: record.callId,
			resolution,
		});
		await this.persist(runId, resolved);
		// round 4: the fill is keyed by THIS execution — a tool_result belonging to
		// a different (same-callId) execution must not suppress the verdict's
		// model-facing result, and the fill itself carries the executionId.
		// round 8 (adversarial): the fill also carries the tags from the durable RECEIPT —
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

	/** round 4 (adversarial): a verdict the human already gave for a live decision. */
	approvalVerdict(decisionId: string): boolean | undefined {
		return this.#approvalVerdicts.get(decisionId);
	}

	/** round 4 (adversarial): a verdict the human already gave for a live execution. */
	uncertaintyVerdict(executionId: string): "rerun" | "abandoned" | undefined {
		return this.#uncertaintyVerdicts.get(executionId);
	}

	/**
	 * round 5(P1-5): flush every verdict submitted to a live resolver that is
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

/**
 * E6 — the session context policy (all optional; absent = the pre-E6
 * behavior, zero change). The policy is INJECTION-side only: every action
 * persists a durable fact (`summarized`, `microcompacted`) whose projection
 * shrinks the SENT view — the durable log's bytes never change (the E5
 * discipline). Actions land at RUN START, never mid-run (D5); the manual
 * /compact affordance point.
 */
export interface ContextPolicy {
	/**
	 * A — the auto-summary: at run start, when the projected context
	 * crosses the trigger AND enough uncovered rounds exist, the
	 * existing summarize() path persists ONE `summarized` fact. The
	 * keepRounds gate is the amortization structure — a fire needs
	 * keepRounds+1 uncovered rounds, so each boundary is preceded by
	 * that much content and followed by the kept rounds' requests to
	 * amortize the break (the E5-F1 accounting).
	 *
	 * E6 (g): the trigger is EXACTLY ONE of triggerTokens (an absolute,
	 * the legacy override) or windowTokens (the product arming — the
	 * runtime computes window − POLICY_RESERVE; never a fixed low
	 * absolute). keepTokens floors the kept suffix (the (f) budget;
	 * the default KEEP_TOKENS_DEFAULT applies when absent). maxFailures
	 * sets the (h) circuit breaker (the default MAX_SUMMARY_FAILURES
	 * applies when absent).
	 */
	readonly summary?: {
		readonly triggerTokens?: number;
		readonly windowTokens?: number;
		readonly keepRounds?: number;
		readonly keepTokens?: number;
		readonly maxFailures?: number;
	};
	/**
	 * C — the crux-experiment drop arm (EXPERIMENT-ONLY, never a default):
	 * the same trigger persists the same-shaped fact with a fixed
	 * placeholder and NO model call — the covered turns leave the sent
	 * context at zero generation cost. When present, it REPLACES the
	 * summary mode (one conversation-layer compactor at a time). The
	 * adopted shape — if the crux evidence earns it — is a distinct
	 * `dropped` event family, not this placeholder text. Same trigger
	 * shapes, keep budget, and breaker as the summary arm.
	 */
	readonly drop?: {
		readonly triggerTokens?: number;
		readonly windowTokens?: number;
		readonly keepRounds?: number;
		readonly keepTokens?: number;
		readonly maxFailures?: number;
	};
	/**
	 * B — the session-aware microcompact: the threshold/keep-window
	 * override the session's own microcompact (a tuned policy wins over
	 * the CLI default). minTurns is the no-fire guard: below that many
	 * completed user inputs the boundary config is OMITTED from the loop
	 * — a short task never pays a break it cannot amortize.
	 */
	readonly microcompact?: { readonly thresholdTokens: number; readonly keepResults?: number; readonly minTurns?: number };
}

export interface SessionConfig {
	readonly model: string;
	/** E1: the adapter identity ("anthropic" | "openai-compat") — trace
	 *  provenance, additive (S1 surface untouched: type-only, optional). */
	readonly provider?: "anthropic" | "openai-compat";
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
	/** C area: microcompact threshold — passed through to the loop verbatim. */
	readonly microcompact?: { readonly thresholdTokens: number };
	/** E6: the session context policy (run-start actions, injection-side only). */
	readonly contextPolicy?: ContextPolicy;
	readonly maxRetries?: number;
	/**
	 * E1: loaded extensions — their tools join the registry (idempotently;
	 * a collision with a built-in name was already rejected at agent
	 * creation), their hooks compose AFTER the existing ones (the existing come first),
	 * their approval policies enter the loop's policy chain.
	 */
	readonly extensions?: readonly KisoExtension[];
}
