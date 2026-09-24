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
	SUMMARY_FRAMING,
	type AbortSignalLike,
	type Adapter,
	type Event,
	type KisoExtension,
	type Message,
	type PermissionDecision,
	type Tool,
	type ToolSpec,
	type EventInput,
	type RetryInfo,
} from "@vincemakes/kiso-core";
import { executionLedger } from "./ledger.js";
import { overflowBelt, type OverflowMeasure } from "./overflow-belt.js";
import { windowLearner } from "./window-learner.js";
import { assessTasks, type TaskAssessment } from "./task-assessment.js";

/** TV-1A — the session-level evidence policy: the PURE projection defaults
 *  to ∅ (never inventing evidence); the session names the one built-in
 *  verification surface. Override per call for custom evidence tools. */
const DEFAULT_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(["shell"]);
import { denialResult, type ContinuationScope } from "@vincemakes/kiso-core";
import { buildProfile, readProfile, writeProfile, writeSummary } from "./profile.js";
import { summarizeEvents } from "./session-summary.js";
import { lookupModelMetadata, resolveReasoning, type ReasoningSetting } from "./provider/metadata.js";
import {
	DROP_PLACEHOLDER,
	estimateSummarySavings,
	KEEP_RECENT_ROUNDS,
	KEEP_TOKENS_DEFAULT,
	lastSummaryPoint,
	MAX_SUMMARY_FAILURES,
	policyTriggerFromWindow,
	serializeCovered,
	MANUAL_SUMMARY_BUDGET,
	SUMMARY_MAX_OUTPUT,
	summarizeConversation,
	SummaryBudgetExhausted,
	summaryBoundarySeq,
} from "./summarize.js";
import { canonicalizeUsageForModel } from "./usage/canonical.js";
import { contextAnchor } from "./context-anchor.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@vincemakes/kiso-core";
import { StaleWriterError, type SessionStore, type StoreRecord } from "./store.js";
import { composeHooks, composeSystemPrompt, microcompactFor, runBasePrompt } from "./compose.js";
import { checkpointBoundarySeq } from "./checkpoint.js";
import { ABORTED_BEFORE_EXECUTION, unansweredAbortedCalls } from "./aborted-calls.js";
import { breakEvenFactor, guardedPruneSeq, KEEP_COMPACTABLE_RESULTS, microcompactBoundarySeq, outputReserve, phaseEnd, runsACheck, tierReason, tiersFor } from "./compaction-policy.js";
import { Run } from "./run.js";
// TUI2-R3v2 ③ — the side query rides the SAME tracer the runs ride; that
// sameness is the whole point (one ledger, one shape, no second path).
import { RequestTracer, traceGuard } from "./trace/guard.js";
import { DEFAULT_STREAM_IDLE_MS, idleGuard } from "./idle-guard.js";
import { runtimeVersion } from "./trace/writer.js";

/** TUI2-R3v2 ③ — one off-trajectory model request (session.sideQuery).
 *  Deliberately tiny: a purpose to mark it in the trace, its own short
 *  system prompt, one user message, and an abort. No tools — a side
 *  query answers, it never acts. */
export interface SideQueryOptions {
	/** what this request is FOR — lands in the trace as `purpose`. */
	readonly purpose: string;
	/** the side query's OWN system prompt; the session's is not sent. */
	readonly systemPrompt: string;
	/** the single user message. */
	readonly prompt: string;
	readonly maxTokens?: number;
	/** cancels the request — the CLI wires esc to it. */
	readonly signal?: AbortSignalLike;
}

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
/**
 * 0.39.2 — thinking OFF for a manual summary, where it can be turned off.
 *
 * The summary call sent no reasoning at all, so it ran at the provider's
 * default, and for a model whose thinking defaults ON the reasoning tokens
 * came out of the same output budget as the checkpoint. Resolved through
 * `resolveReasoning` — the one authority the `/model` path uses — so it
 * only ever sends a NATIVE value for a model the registry knows. For a
 * model it does not know (66 of the 73 profiles on the machine this was
 * found on, the failing one among them) it sends nothing, exactly as
 * before: a raw field to an unknown model can be a 400. That is why this
 * is an optimisation and the scaled budget is the fix — the budget
 * reaches every model, this reaches the ones we can vouch for.
 */
function summaryReasoning(model: string, baseUrl: string | undefined): { reasoning?: { readonly thinking?: "adaptive" | "enabled" | "disabled"; readonly effort?: string } } {
	const r = resolveReasoning(model, { thinking: "disabled", effort: "default" }, baseUrl);
	return r.ok && r.wire.thinking !== undefined ? { reasoning: r.wire } : {};
}

export class AgentSession {
	readonly id: string;
	readonly log: EventLog;
	readonly #store: SessionStore;
	// NOT readonly since 0.1.23: /model replaces it between runs (the
	// constructor, setAdapter, and setModelBinding are the only writers).
	#adapter: Adapter;
	readonly #config: SessionConfig;
	// PH-1a (finding PH-F8, P0): the LIVE model binding. #config froze the
	// startup model/provider, so a /model switch replaced the adapter while
	// every later run kept sending the OLD model id and canonicalizing
	// usage under the OLD route. These two travel WITH the adapter now —
	// setModelBinding writes all three in one call; runs read them through
	// #effectiveConfig at run construction (next-turn semantics, same as
	// setAdapter always had).
	#model: string;
	#provider: "anthropic" | "openai-compat" | "openai-responses" | undefined;
	// OR-1: the fourth passenger — the endpoint moves with the adapter too.
	#baseUrl: string | undefined;
	// MG-1 (A5): travels WITH the adapter, same next-turn semantics.
	#continuationScope: ContinuationScope | undefined;
	// XP-1: the selected axes; resolved per request (next-turn semantics).
	#reasoning: ReasoningSetting;
	// CTX-1: the compaction threshold is derived from the LIVE model's window,
	// so it is a passenger on the binding like the four above. PH-F8 fixed
	// exactly this class — a frozen startup value still in use after a switch
	// — for the model id, the provider, the endpoint and the scope. The
	// threshold was one field over and was never asked.
	#microcompact: { readonly thresholdTokens: number } | undefined;
	// XP-1: a legacy session records revision 1 at the next explicit
	// selection or first request — never eagerly at open.
	#profilePending: boolean;
	/** DC-60: set until a NEW session's first durable event lands. */
	#newSession: { readonly workspace: string | null } | undefined;
	/** 0.40.0: the config profile name of the live binding (configuration:
	 *  each revision records the name in force when it is written). */
	#profileName: string | null;
	/** 0.40.0: what this open's drift acknowledgement replaced — the CLI
	 *  says so once. Null when the session opened without material drift. */
	readonly driftAcknowledgement: import("./agent.js").DriftAcknowledgement | null;
	readonly #pendingResolvers = new Map<string, (decision: PermissionDecision) => void>();
	readonly #answered = new Set<string>();
	/** round 4 (adversarial): verdicts the human GAVE, recorded when passed to a live
	 *  resolver. If an abort races the verdict, the loop / recovery queries
	 *  these and records the decision (exactly once) instead of losing it. */
	readonly #approvalVerdicts = new Map<string, boolean>();
	/** round 5(P1-5): verdicts submitted to a LIVE resolver but not yet known
	 *  durable. An async generator only advances on next(), so approve()
	 *  CANNOT wait for the loop to persist — that would deadlock (the
	 *  consumer waits while the generator needs a next()). Instead the
	 *  verdict is recorded here, and the Run's iterator FINALLY flushes
	 *  every not-yet-durable verdict to disk — an abandoned generator can
	 *  never lose a verdict the human gave. (CT-1: uncertainty verdicts no
	 *  longer have a live resolver — the loop never took one since
	 *  ADR-0038 — so they always take the direct-persist path below.) */
	readonly #pendingDurableApprovals = new Map<string, boolean>();
	#poisoned: string | null = null;
	/** E6 (h): the circuit-breaker counter — consecutive auto-policy
	 *  summary failures this session (a success resets it). */
	#summaryFailures = 0;
	/** 0.40.0: usage at or before this seq was billed under another model — never an anchor. */
	#anchorFloorSeq = -1;
	/** A1b: the window the tiers are drawn from — the live binding's, once a
	 *  switch states one (CTX-1: the threshold travels with the model). */
	#tiersWindow: number | undefined;
	#lastUsageAt: number | undefined;

	/** 0.40.0: when the provider last billed this session (epoch ms) — the
	 *  record's time on load, the write's time after. A provider's prompt
	 *  cache expires with time, so an old bill means a cold prefix. */
	get lastUsageAt(): number | undefined {
		return this.#lastUsageAt;
	}

	/** Permanently invalidate the session after a rejected disk write (round 1). */
	poison(reason: string): void {
		if (this.#poisoned === null) this.#poisoned = reason;
	}

	ensureHealthy(): void {
		if (this.#poisoned !== null) throw new PoisonedSessionError(this.#poisoned);
	}

	readonly #activeRuns = new Set<Run>();

	constructor(id: string, log: EventLog, store: SessionStore, adapter: Adapter, config: SessionConfig, lastUsageAt?: number) {
		this.#lastUsageAt = lastUsageAt;
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
		this.#model = config.model;
		this.#provider = config.provider;
		this.#baseUrl = config.baseUrl;
		this.#continuationScope = config.continuationScope;
		this.#reasoning = config.reasoning ?? { thinking: "default", effort: "default" };
		// CTX-1: starts as the startup policy, then follows the binding.
		this.#microcompact = config.microcompact;
		this.#profilePending = config.profilePending === true;
		this.#newSession = config.newSession;
		this.#profileName = config.profileName ?? null;
		this.driftAcknowledgement = config.driftAcknowledgement ?? null;
	}

	/** The config a NEW run/resume/summary sees: the frozen startup config
	 *  with the LIVE binding fields (model, provider) substituted. Built
	 *  fresh per call so an in-flight run keeps the config it started with
	 *  — the same boundary setAdapter has always drawn. */
	#effectiveConfig(): SessionConfig {
		const { provider: _startup, baseUrl: _startupUrl, continuationScope: _startupScope, microcompact: _startupMicro, ...rest } = this.#config;
		return {
			...rest,
			...(this.#microcompact !== undefined ? { microcompact: this.#microcompact } : {}),
			model: this.#model,
			...(this.#provider !== undefined ? { provider: this.#provider } : {}),
			...(this.#baseUrl !== undefined ? { baseUrl: this.#baseUrl } : {}),
			...(this.#continuationScope !== undefined ? { continuationScope: this.#continuationScope } : {}),
			reasoning: this.#reasoning,
		};
	}

	/** Write-ahead through the store; a rejected write POISONS the session
	 *  (round 1/round 4): the in-memory log no longer matches the disk — whatever
	 *  the cause (stale handle, corruption, a live external writer, an I/O
	 *  fault) — so no further run, resume, or log mutation may proceed.
	 *  The health check runs BEFORE every write, on every path. */
	/**
	 * 0.40.2 — a committed call an aborted run left with no started and no
	 * result gets ONE durable result, "aborted before execution", riding the
	 * run that owns it (aborted-calls.ts). Every path that projects the
	 * session into a request calls this first — a run's start (fresh or
	 * resumed) and /compact — so no dangling tool_use reaches a provider,
	 * and the already-poisoned logs heal with no migration. Idempotent per
	 * invocation: a crash between two repairs leaves the rest for next time.
	 */
	async repairAbortedCalls(records: readonly StoreRecord[]): Promise<void> {
		for (const c of unansweredAbortedCalls(records)) {
			const ev = this.log.append({ type: "tool_result", callId: c.callId, invocationSeq: c.invocationSeq, content: ABORTED_BEFORE_EXECUTION, isError: true, errorKind: "precondition" });
			await this.persist(c.runId, ev);
		}
	}

	async persist(runId: string, event: Event): Promise<void> {
		this.ensureHealthy();
		try {
			// DC-60: a NEW session's revision 1 lands with its first durable
			// event and BEFORE it — a log line never exists without its profile.
			if (this.#newSession !== undefined) {
				const { workspace } = this.#newSession;
				this.#newSession = undefined;
				this.#writeProfileRevision(workspace);
			}
			await this.#store.append(this.id, runId, event);
			if (event.type === "usage" && event.known) this.#lastUsageAt = Date.now();
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

	/** 0.40.0: the context as the last bill measured it, plus what the log
	 *  appended since — or undefined when no bill describes it any more
	 *  (context-anchor.ts). `events` defaults to the session's log. */
	contextAnchor(events: readonly Event[] = this.log.all): number | undefined {
		return contextAnchor(
			events,
			(u) => {
				const c = canonicalizeUsageForModel(this.#model, this.#baseUrl, this.#provider ?? "adapter", u);
				return c.input + c.cacheRead + (c.cacheWrite ?? 0) + c.output;
			},
			this.#anchorFloorSeq,
		);
	}

	/** 0.40.0: what the context holds — the anchored figure, or the estimate
	 *  over the projection when no bill describes it. The thresholds and the
	 *  ctx row read this, never the bare estimate. */
	contextUsed(): number {
		return this.contextAnchor() ?? estimateTokens(this.projected());
	}

	/**
	 * ADR-0055 Amendment 1 (A1b) — the kernel's compaction point for ONE run,
	 * or undefined when nothing in-run is armed (the kernel then never asks).
	 *
	 * With `contextPolicy.tiers`: the §1a figure against the tiers — soft
	 * waits for a phase end (A3), hard and emergency fire now, an overflow
	 * fires once. The summary is in-band (A2) with ONE fallback to the
	 * serialised form; if both fail, an emergency or an overflow may prune
	 * once (A4b), and otherwise nothing happens and the run goes on.
	 *
	 * Without tiers, an EXPLICITLY configured `microcompact` keeps its old
	 * standing prune here, for SDK callers — the kernel no longer has one.
	 */
	compactionPoint(run: {
		readonly systemPrompt?: string;
		readonly tools: () => readonly ToolSpec[];
		readonly reasoning?: { readonly thinking?: "adaptive" | "enabled" | "disabled"; readonly effort?: string };
		readonly signal?: AbortSignalLike;
		readonly maxRetries?: number;
	}): ((events: readonly Event[], messages: readonly Message[], why: "request" | "overflow") => Promise<readonly EventInput[]>) | undefined {
		const tiersPolicy = this.#config.contextPolicy?.tiers;
		const legacy = tiersPolicy === undefined ? microcompactFor(this.#effectiveConfig(), this.log.all) : undefined;
		if (tiersPolicy === undefined && legacy === undefined) return undefined;
		return async (events, messages, why) => {
			const used = this.contextAnchor(events) ?? estimateTokens(messages);
			if (tiersPolicy === undefined) {
				if (legacy === undefined || used <= legacy.thresholdTokens) return [];
				const beforeSeq = microcompactBoundarySeq(events, legacy.keepResults ?? KEEP_COMPACTABLE_RESULTS);
				return beforeSeq === undefined ? [] : [{ type: "microcompacted", beforeSeq }];
			}
			const window = this.#tiersWindow ?? tiersPolicy.windowTokens;
			const t = tiersFor(window, this.#outputReserve());
			const isCheck = tiersPolicy.isCheck ?? ((command: string) => runsACheck(command));
			const reason = tierReason(used, t, why, () => phaseEnd(events, lastSummaryPoint(events), isCheck));
			if (reason === null) return [];
			const urgent = reason === "overflow" || reason === "emergency";
			// ADR-0055 Amendment 2: the breaker stands at every tier but
			// overflow (once per request by construction). An urgent tier that
			// meets it skips the summary call and keeps the prune fallback — a
			// session whose checkpoints cannot shrink it stops paying for them.
			const breakerOpen = reason !== "overflow" && this.#summaryFailures >= (tiersPolicy.maxFailures ?? MAX_SUMMARY_FAILURES);
			if (breakerOpen && !urgent) return [];
			const summarized = breakerOpen ? null : await this.#summarizeInRun(events, messages, t.tail, reason, run, tiersPolicy.onDiscard);
			if (summarized !== null) return [summarized];
			if (!urgent) return [];
			const pricing = lookupModelMetadata(this.#model, this.#baseUrl)?.pricing ?? null;
			const beforeSeq = guardedPruneSeq(events, breakEvenFactor(pricing?.inputPerM, pricing?.cacheReadPerM));
			return beforeSeq === undefined ? [] : [{ type: "microcompacted", beforeSeq }];
		};
	}

	/**
	 * ADR-0055 A2 — one checkpoint call, both paths: IN-BAND first (the
	 * messages as a run sends them, under the run's system prompt and tool
	 * table, the instruction appended — the prefix reads at the cache-hit
	 * price), and ONCE the serialised covered range when that reply is
	 * rejected (a tool call, markup, a missing section). An
	 * abort is never answered with the second call. Throws when both fail.
	 */
	async #checkpointCall(args: {
		readonly messages: readonly Message[];
		readonly inBand: { readonly systemPrompt?: string; readonly tools: readonly ToolSpec[]; readonly focus?: string };
		readonly reasoning?: { readonly thinking?: "adaptive" | "enabled" | "disabled"; readonly effort?: string };
		readonly serialized: () => string;
		readonly serializedReasoning: boolean;
		readonly budget: number;
		readonly signal?: AbortSignalLike;
		readonly onProgress?: (progress: import("./summarize.js").SummaryProgress) => void;
	}): Promise<{ readonly result: Awaited<ReturnType<typeof summarizeConversation>>; readonly path: "in-band" | "serialized" }> {
		const learned = this.#learning(this.#adapter);
		const common = {
			adapter: learned,
			model: this.#model,
			maxOutputTokens: args.budget,
			...(args.signal !== undefined ? { signal: args.signal } : {}),
			...(this.#config.maxRetries !== undefined ? { maxRetries: this.#config.maxRetries } : {}),
			onRetry: async (info: RetryInfo) => {
				await this.#config.hooks?.onRetry?.(info, {});
			},
			...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
		};
		try {
			// The in-band call carries the run's whole context, so the overflow
			// belt applies to it; the serialised fallback below is small, and
			// its failures keep their own classification.
			const inBandAdapter = overflowBelt(learned, () => this.overflowMeasure());
			const result = await summarizeConversation({ ...common, adapter: inBandAdapter, messages: args.messages, inBand: args.inBand, ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}) });
			return { result, path: "in-band" };
		} catch (err) {
			// Only a REJECTED reply earns the second call: a transport failure
			// already spent its retries, and an exhausted budget would exhaust
			// the serialised call the same way.
			if (args.signal?.aborted === true || !(err instanceof Error) || err instanceof SummaryBudgetExhausted) throw err;
			const result = await summarizeConversation({
				...common,
				messages: [{ role: "user", content: args.serialized() }],
				...(args.serializedReasoning ? summaryReasoning(this.#model, this.#baseUrl) : {}),
			});
			return { result, path: "serialized" };
		}
	}

	/** A2 — one in-run summary: in-band first, the serialised form once on
	 *  a rejection; null when neither produced a valid checkpoint. The
	 *  summary call's usage and path ride the trace ledger, as /compact's do. */
	async #summarizeInRun(
		events: readonly Event[],
		messages: readonly Message[],
		tail: number,
		reason: string,
		run: Parameters<AgentSession["compactionPoint"]>[0],
		onDiscard?: (info: { readonly reason: string; readonly pre: number; readonly post: number; readonly summary: number }) => void,
	): Promise<EventInput | null> {
		const boundary = checkpointBoundarySeq(events, { keepTokens: tail });
		if (boundary === undefined) return null;
		let path: "in-band" | "serialized";
		let result: Awaited<ReturnType<typeof summarizeConversation>>;
		try {
			({ result, path } = await this.#checkpointCall({
				messages,
				inBand: { ...(run.systemPrompt !== undefined ? { systemPrompt: run.systemPrompt } : {}), tools: run.tools() },
				...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
				serialized: () => serializeCovered({ events, prevPoint: lastSummaryPoint(events), boundary }),
				serializedReasoning: true,
				budget: MANUAL_SUMMARY_BUDGET,
				...(run.signal !== undefined ? { signal: run.signal } : {}),
			}));
		} catch {
			if (run.signal?.aborted !== true) this.#summaryFailures += 1;
			return null;
		}
		// ADR-0055 Amendment 2 (the shrink invariant): a fire is kept only if
		// it removes at least what it writes — post ≤ pre − summary, all by
		// the chars/4 estimate over the SAME projection (never the bill
		// against an estimate). A checkpoint that fails it is discarded:
		// nothing is appended, the run goes on as before, and the failure
		// counts toward the breaker.
		const fire: EventInput = { type: "summarized", coversToSeq: boundary, summary: result.text };
		const pre = estimateTokens(projectMessages(events));
		const post = estimateTokens(projectMessages([...events, { ...fire, seq: (events.at(-1)?.seq ?? -1) + 1 } as Event]));
		const written = estimateTokens([{ role: "user", content: `${SUMMARY_FRAMING}\n\n${result.text}` }]);
		const shrinks = pre - post >= written;
		// Every in-run fire is recorded — its reason and path are what the
		// measurement counts — and its usage when the provider reported one;
		// a discarded one too (it was paid for), marked so.
		{
			try {
				const canonical = result.usage === null ? null : canonicalizeUsageForModel(this.#model, this.#baseUrl, this.#provider ?? "adapter", result.usage);
				mkdirSync(join(this.#store.root, "traces"), { recursive: true, mode: 0o700 });
				appendFileSync(join(this.#store.root, "traces", `${this.id}.jsonl`), `${JSON.stringify({ kind: "summary", canonical, reason, path, ...(shrinks ? {} : { discarded: "no-shrink" }) })}\n`, { mode: 0o600 });
			} catch (err) {
				console.error(`[kiso] summary usage ledger degraded (${err instanceof Error ? err.message : String(err)}); the summary call's cost is not recorded`);
			}
		}
		if (!shrinks) {
			this.#summaryFailures += 1;
			// sizes only — the checkpoint's text is the owner's work
			try {
				onDiscard?.({ reason, pre, post, summary: written });
			} catch {
				// observation only — a notice that cannot be shown changes nothing
			}
			return null;
		}
		this.#summaryFailures = 0;
		return fire;
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

	/**
	 * PH-1a (finding PH-F8, P0): the ATOMIC model switch — adapter, model
	 * id, and provider route replace together, effective at the next run.
	 * setAdapter alone is for a same-binding adapter swap (the faux
	 * re-arm); a switch that changes WHAT model answers must come through
	 * here, or the UI claims one model while requests carry another.
	 * Omitting `provider` clears the route — an unknown binding is
	 * canonicalized under the honest "adapter" route (null-priced), never
	 * the stale one. (The context window joins the binding when per-model
	 * metadata exists — the PH-1c registry.)
	 */
	setModelBinding(binding: {
		readonly adapter: Adapter;
		readonly model: string;
		readonly provider?: "anthropic" | "openai-compat" | "openai-responses";
		/** OR-1: the endpoint moves with the adapter too — the cost path
		 *  and the window lookup key on (model, endpoint); absent = an
		 *  endpoint-less lookup (the first row for the id). */
		readonly baseUrl?: string;
		/** MG-1 (A5): the run's continuation scope — moves atomically with
		 *  the adapter (absent = unscoped: the kernel strips envelopes). */
		readonly scope?: ContinuationScope;
		/** XP-1: the reasoning axes travel with the binding too; absent =
		 *  fresh defaults (a new binding never inherits stale effort). */
		readonly reasoning?: ReasoningSetting;
		/** 0.40.0: the config profile that named this binding; absent = none
		 *  (a direct provider/model, or an SDK caller) — recorded as null. */
		readonly profileName?: string | null;
		/** CTX-1: the compaction threshold follows the live model's window.
		 *  Absent KEEPS the current one — a caller that does not know the new
		 *  model's window must not silently reset the policy to nothing. */
		readonly microcompact?: { readonly thresholdTokens: number };
		/** A1b: the new model's window, for the in-run tiers. Absent keeps the
		 *  current one, as `microcompact` does. */
		readonly contextWindow?: number;
	}): void {
		// 0.40.0: another model counts tokens differently — the last bill
		// stops describing the context until the new model sends one.
		if (binding.model !== this.#model || binding.provider !== this.#provider || binding.baseUrl !== this.#baseUrl) {
			this.#anchorFloorSeq = this.log.all.at(-1)?.seq ?? -1;
		}
		this.#adapter = binding.adapter;
		this.#model = binding.model;
		this.#provider = binding.provider;
		this.#baseUrl = binding.baseUrl;
		this.#continuationScope = binding.scope;
		this.#reasoning = binding.reasoning ?? { thinking: "default", effort: "default" };
		this.#profileName = binding.profileName ?? null;
		if (binding.microcompact !== undefined) this.#microcompact = binding.microcompact;
		if (binding.contextWindow !== undefined) this.#tiersWindow = binding.contextWindow;
		// XP-1: an explicit selection is DURABLE — the setting survives
		// /resume because a revision records it now, not at some later flush.
		this.#recordProfile();
	}

	/**
	 * CTX-1: the compaction threshold alone, with NO profile revision.
	 *
	 * `setModelBinding` is the atomic switch — the adapter and everything
	 * that must travel with it, recorded durably. This is the other door:
	 * a session OPENED onto a model the process was not configured for.
	 * `/resume` restores the recorded model, which can be any model the
	 * session ever used, while the threshold came from whatever model this
	 * process started on. Resuming a 1M session from a 200k start left it
	 * clearing tool results at 100,000.
	 *
	 * It writes no revision because nothing was selected: the caller is
	 * bringing the policy into line with a model already in force, not
	 * choosing one. Recording a revision here would write a new profile on
	 * every open.
	 */
	setMicrocompactThreshold(thresholdTokens: number): void {
		this.#microcompact = { thresholdTokens };
	}

	/** CW-1 batch 2: the adapter as a run or a summary uses it — a refusal
	 *  that states a cap is learned for the binding in force NOW, the one
	 *  this adapter belongs to (a /model mid-run must not receive it). */
	#learning(adapter: Adapter): Adapter {
		const at = { model: this.#model, baseUrl: this.#baseUrl };
		return windowLearner(adapter, (tokens) => this.#learnWindow(tokens, at));
	}

	/** CW-1 batch 2: a route stated its cap. The in-run tiers take it at once
	 *  — the kernel's one overflow compaction runs next and must aim at the
	 *  real window, not past it — and only ever DOWN; the caller is told, to
	 *  keep it for the next session and to say so. */
	#learnWindow(tokens: number, at: { readonly model: string; readonly baseUrl: string | undefined }): void {
		const tiers = this.#config.contextPolicy?.tiers;
		if (at.model === this.#model && at.baseUrl === this.#baseUrl) {
			const current = this.#tiersWindow ?? tiers?.windowTokens;
			if (current === undefined || tokens < current) this.#tiersWindow = tokens;
		}
		tiers?.onWindowLearned?.({ tokens, model: at.model, ...(at.baseUrl !== undefined ? { baseUrl: at.baseUrl } : {}) });
	}

	/** ADR-0055 Amendment 2 (decision 3): the overflow belt's measure at send
	 *  time — null unless a window is STATED and a bill anchors the context. */
	overflowMeasure(): OverflowMeasure | null {
		const tiers = this.#config.contextPolicy?.tiers;
		if (tiers === undefined) return null;
		const window = tiers.statedWindow !== undefined ? tiers.statedWindow() : (this.#tiersWindow ?? tiers.windowTokens);
		const used = this.contextAnchor();
		return window === null || used === undefined ? null : { used, window, reserve: this.#outputReserve() };
	}

	/** ADR-0055 Amendment 2 (decision 4): the emergency reserve — what the
	 *  endpoint may grant for this binding (compaction-policy.ts). */
	#outputReserve(): number {
		return outputReserve(this.#config.maxTokens, lookupModelMetadata(this.#model, this.#baseUrl)?.capabilities.maxOutputTokens, MANUAL_SUMMARY_BUDGET);
	}

	/** The raw tail a manual cut at a settled round keeps: the tiers' tail
	 *  when a window is known, else the policy's keep floor. */
	#manualTailTokens(): number {
		const window = this.#tiersWindow ?? this.#config.contextPolicy?.tiers?.windowTokens;
		return window === undefined ? KEEP_TOKENS_DEFAULT : tiersFor(window, MANUAL_SUMMARY_BUDGET).tail;
	}

	/** A1b: the window the in-run tiers are drawn from, for a restored or
	 *  re-bound session (the CLI's one binding step calls both). */
	setContextWindow(windowTokens: number): void {
		this.#tiersWindow = windowTokens;
	}

	/** E2: the adapter identity (anthropic / openai-compat / openai-responses) — the route
	 *  key the canonical consumer (CLI usage, the trace block) keys on. The
	 *  per-run tracer reads the SAME live binding; one source, one
	 *  route — the CLI and the trace can never disagree. */
	get provider(): "anthropic" | "openai-compat" | "openai-responses" | undefined {
		return this.#provider;
	}

	/** OR-1: the live binding's endpoint — what the CLI hands the cost
	 *  path next to `provider` and `model`, so the status row's dollar
	 *  figure and the ledger's can never key on different registry rows. */
	get baseUrl(): string | undefined {
		return this.#baseUrl;
	}

	/** XP-1: the model that will answer the NEXT request — the live
	 *  binding, restored from the durable profile on open. The status row
	 *  reads THIS, so the row and the request can never disagree. */
	get model(): string {
		return this.#model;
	}

	/** A1a: the parts of the NEXT request as the kernel would assemble them —
	 *  the system prompt, the tool table (the same snapshot the loop sends:
	 *  live extension tools included), the projected messages with their
	 *  continuation envelopes, and the request's max_tokens (absent when
	 *  the provider sends none). For `requestBudget` — accounting, no policy. */
	requestParts(): { readonly systemPrompt?: string; readonly toolSpecs: readonly import("@vincemakes/kiso-core").ToolSpec[]; readonly messages: readonly Message[]; readonly maxTokens?: number } {
		return {
			...(this.#config.systemPrompt !== undefined ? { systemPrompt: this.#config.systemPrompt } : {}),
			toolSpecs: this.#config.registry.snapshot().specs,
			messages: this.projected(),
			...(this.#config.maxTokens !== undefined ? { maxTokens: this.#config.maxTokens } : {}),
		};
	}

	/** XP-1: the selected reasoning axes (resolution happens per request). */
	get reasoning(): ReasoningSetting {
		return this.#reasoning;
	}

	/**
	 * The 0.40.0 dogfood (item 2): the session list's row, written into the
	 * sidecar's `summary` tenant at a run's start (`open`) and at its end.
	 * Computed from the IN-MEMORY log — never a re-read of the file — and
	 * best-effort: a summary that cannot be written leaves the list saying
	 * less, and never fails the run. Observation only: nothing that decides
	 * recovery, projection or a request reads it.
	 */
	recordSummary(open: boolean): void {
		// DC-60: a session with no durable event has no row — writing one made
		// a session that never began appear in the list.
		if (this.log.all.length === 0) return;
		try {
			const prior = readProfile(this.#store.root, this.id);
			writeSummary(
				this.#store.root,
				this.id,
				summarizeEvents(this.log.all, {
					open,
					updatedAt: Date.now(),
					asks: open ? 0 : this.pendingApprovals().length,
					workspaceUnknown: !(prior.kind === "ok" && prior.profile.workspace !== null),
					source: "run",
				}),
			);
		} catch {
			// observation only — the row says less; the run is untouched
		}
	}

	/** XP-1: record the live binding as the next durable profile revision
	 *  (read-modify-write under the session's single-writer ownership).
	 *  DC-60: a NEW session keeps the binding in memory until its first
	 *  durable event, which records it (persist). */
	#recordProfile(): void {
		if (this.#newSession !== undefined) return;
		this.#writeProfileRevision(null);
	}

	/** The next profile revision from the live binding. `startWorkspace` is
	 *  the workspace a NEW session opened in; with no prior revision and no
	 *  start (a legacy session's first revision) the start is unknown: null. */
	#writeProfileRevision(startWorkspace: string | null): void {
		const prior = readProfile(this.#store.root, this.id);
		const revision = prior.kind === "ok" ? prior.profile.revision + 1 : 1;
		writeProfile(
			this.#store.root,
			this.id,
			buildProfile({
				revision,
				modelId: this.#model,
				provider: this.#continuationScope ?? null,
				profileName: this.#profileName,
				// 0.40.0: history is CARRIED from the prior revision, never
				// re-derived from this process. With no prior, a NEW session's
				// start is the workspace it opened in; a legacy one's is unknown.
				workspace: prior.kind === "ok" ? prior.profile.workspace : startWorkspace,
				reasoning: this.#reasoning,
				...(this.#config.systemPrompt !== undefined ? { systemPrompt: this.#config.systemPrompt } : {}),
				registry: this.#config.registry,
			}),
		);
		this.#profilePending = false;
	}

	/**
	 * TUI2-R3v2 ③ — ONE model request that belongs to no run (the
	 * safer-options seam, adjudicated 2026-08-18).
	 *
	 * A side query exists for the case where the human, staring at a
	 * paused approval, presses a button and wants an answer NOW. It is
	 * not a turn, not a run, and not part of the trajectory.
	 *
	 * IT WRITES NOTHING DURABLE. No session-log lines, no receipts, no
	 * execution records — nothing. This is the design, not an omission,
	 * and it is what makes the method safe to call while a run sits
	 * paused: it cannot interleave with that run's own event sequence
	 * because it produces no events to interleave. The ONLY durable
	 * consequence a side query can have is what the human does with the
	 * answer, and that lands through an existing channel — for the
	 * safer-options flow, the amend channel, exactly as a typed denial
	 * would. Nothing here touches the durable approval contract.
	 *
	 * IT IS VISIBLE. It rides the same traceGuard every run request
	 * rides, so it lands one request line in the trace ledger, carrying
	 * a FRESH runId (it is not the paused run's work) and the `purpose`
	 * marker (schemaVersion 4) that lets a rent audit separate on-demand
	 * requests from a run's own without heuristics. A request the ledger
	 * cannot see is rent nobody can audit, and the entire argument for
	 * an on-demand feature is that its rent is countable.
	 *
	 * IT PAYS ITS OWN, SMALLER RENT. It sends its own short system
	 * prompt and ONE user message, and NO TOOLS AT ALL — it cannot call
	 * anything, it can only answer. Its declared prediction arm is
	 * predictSideQueryRentLedger (scripts/request-surface.mjs), gated
	 * against a real call in rent-ledger-gate.test.ts.
	 *
	 * The returned string is the model's text, concatenated. The caller
	 * parses it and must treat a failure to parse as a failure — see the
	 * CLI's honest degradation.
	 */
	async sideQuery(options: SideQueryOptions): Promise<string> {
		this.ensureHealthy();
		// a fresh id: this request is not the paused run's work, and giving
		// it the run's id would put on-demand rent inside a run's total.
		const runId = crypto.randomUUID();
		const tracer = new RequestTracer({
			root: this.#store.root,
			sessionId: this.id,
			runId,
			provider: this.#provider ?? "adapter",
			model: this.#model,
			// OR-1: the side query is priced by the same live endpoint as a run.
			...(this.#baseUrl !== undefined ? { endpoint: this.#baseUrl } : {}),
			adapterVersion: runtimeVersion(),
			purpose: options.purpose,
			// the manifest's seqRange pointers derive from the log, and a side
			// query's messages come from NO events — an empty log is the
			// honest input, and it keeps the manifest from pointing at events
			// this request never sent.
			log: [],
			// the declared rent arm: its own prompt, no appends, no tools
			rentParts: { base: options.systemPrompt, appends: [] },
		});
		tracer.init();
		// LT-1: the summary request is a model stream too — the same watchdog
		const guarded = traceGuard(tracer, idleGuard(this.#adapter, this.#config.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS));
		let text = "";
		try {
			for await (const ev of guarded.stream({
				model: this.#model,
				messages: [{ role: "user", content: options.prompt }],
				systemPrompt: options.systemPrompt,
				...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			})) {
				if (ev.type === "text_delta") text += ev.text;
			}
		} finally {
			tracer.finishRun();
		}
		return text;
	}

	/** Run one user turn. Iterate to consume; `run.abort()` cancels. */
	/** REL-0152-D11: `input` is text, or the content blocks a turn with an
	 *  attachment carries. The durable event, the projection and both
	 *  provider adapters have accepted both shapes since the protocol was
	 *  written — an image block reaches Anthropic as `image` and the
	 *  OpenAI-compatible family as `image_url` with a data URI. Only this
	 *  signature narrowed it to text, which is why no caller could ever
	 *  send one. */
	run(input: string | readonly import("@vincemakes/kiso-core").ContentBlock[], options?: { signal?: AbortSignalLike; source?: import("@vincemakes/kiso-core").MessageSource; via?: import("@vincemakes/kiso-core").UserInputVia }): Run {
		this.ensureHealthy();
		if (this.#profilePending) this.#recordProfile(); // XP-1: legacy revision 1, before the first request
		return new Run(this.#store, this.#learning(this.#adapter), this.#effectiveConfig(), this, input, options?.signal, false, options?.source, options?.via);
	}

	/**
	 * Continue the interrupted run (Area 2): apply durable decisions,
	 * fill missing receipts, resume the pause, and drive the original
	 * trajectory to its terminal — WITHOUT inventing a new user turn.
	 * Yields nothing when the session already completed.
	 */
	resume(): Run {
		this.ensureHealthy();
		return new Run(this.#store, this.#learning(this.#adapter), this.#effectiveConfig(), this, undefined, undefined, true);
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
	async summarize(
		// R3a: `focus` — an optional steer for the summary call ("keep the
		// auth details"). Rides the serialized input as ONE instruction
		// line; absent = byte-identical to the pre-round call.
		// 0.39.2: `manualBudget` — the MANUAL `/compact` gesture's summary
		// call: the measured output budget, and thinking off where the
		// registry says the model can turn it off. Absent — the auto
		// policy — the call is byte-identical to before; see
		// `MANUAL_SUMMARY_BUDGET` for the measurement and for why.
		options: { keepRounds?: number; keepTokens?: number; signal?: AbortSignalLike; onStart?: (info: CompactInfo) => void; drop?: boolean; focus?: string; manualBudget?: boolean; onProgress?: (progress: import("./summarize.js").SummaryProgress) => void } = {},
	): Promise<SummarizeResult | null> {
		this.ensureHealthy();
		const keepRounds = options.keepRounds ?? KEEP_RECENT_ROUNDS;
		// W18: the signal is observed at EVERY phase boundary — the cancel
		// affordance works for the whole call (local work included), never
		// just the adapter's wait. The abort error is the honest "nothing
		// happened" outcome (ADR-0044 crash semantics).
		const cancelled = (): Error => new Error("the compaction was cancelled");
		if (options.signal !== undefined && options.signal.aborted) throw cancelled();
		await this.repairAbortedCalls(this.#store.load(this.id));
		const events = this.log.all;
		// ADR-0055 (the owner's dogfood): a long autonomous session has few
		// user turns and many tool rounds, and the user-turn cut found nothing
		// in it ("fewer than 5 rounds") while the context was hundreds of
		// thousands of tokens. When there is no user-turn cut, the manual
		// gesture cuts where the in-run tiers do: at a settled round, the raw
		// tail kept by tokens (the tiers' `min(0.1·window, 100K)` when the
		// window is known, else the policy floor).
		const tailTokens = Math.max(options.keepTokens ?? 0, this.#manualTailTokens());
		const boundary = summaryBoundarySeq(events, keepRounds, options.keepTokens) ?? (options.manualBudget === true ? checkpointBoundarySeq(events, { keepTokens: tailTokens }) : undefined);
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
		const serialized0 = serializeCovered({ events, prevPoint, boundary });
		const serializedInput =
			options.focus === undefined ? serialized0 : `Focus the summary on: ${options.focus}\n\n${serialized0}`;
		// W18: the indicator's pre-call data — rounds + the token estimate
		// are knowable BEFORE the adapter call; the summary itself is ONE
		// call with no fraction (kiso never invents a percentage here).
		if (options.signal !== undefined && options.signal.aborted) throw cancelled();
		const coveredTokens = estimateTokens(covered);
		options.onStart?.({
			coversToSeq: boundary,
			rounds: events.filter((e) => e.type === "user_input" && e.seq > prevPoint && e.seq <= boundary).length,
			tokens: coveredTokens,
		});
		let summary: string;
		let usage: import("./usage/canonical.js").RawUsage | null = null;
		let summaryPath: "in-band" | "serialized" | null = null;
		// OR-1 (the second review): the summary is priced by the binding that
		// MADE the request. A /model switch during this call — the session's
		// longest single request — moves #model/#baseUrl/#provider under it;
		// reading them after the await priced a subscription summary at the
		// first-party rate. ONE snapshot serves the request and the ledger
		// line, the PH-F8 law (adapter, model, provider move together)
		// applied to the one off-loop call.
		const binding = { adapter: this.#adapter, model: this.#model, baseUrl: this.#baseUrl, provider: this.#provider };
		if (options.drop === true) {
			// E6 — the crux drop arm: mechanical, no model call, the fixed
			// placeholder replaces the covered range (experiment-only).
			summary = DROP_PLACEHOLDER;
		} else {
			// ADR-0055 A2 (the lead's ruling on the /compact gap): the checkpoint
			// is asked IN-BAND on the prefix a run sends — the session's base
			// prompt, the tool table, the extension appends, the registry's
			// tools, the session's reasoning — so a /compact on a warm session
			// reads its context at the cache-hit price; the serialised form is
			// the one fallback. The budget is unchanged: measured for the
			// manual gesture, fixed for the policy (0.39.2).
			const cfg = this.#effectiveConfig();
			const systemPrompt = composeSystemPrompt(runBasePrompt(cfg.systemPrompt, cfg.registry, cfg.toolRules ?? [], cfg.toolTable ?? "on"), cfg.extensions ?? []);
			const wire = cfg.reasoning === undefined ? undefined : resolveReasoning(binding.model, cfg.reasoning, binding.baseUrl);
			const { result: call, path } = await this.#checkpointCall({
				messages: this.projected(),
				inBand: {
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
					tools: cfg.registry.snapshot().specs,
					...(options.focus !== undefined ? { focus: options.focus } : {}),
				},
				...(wire !== undefined && wire.ok && Object.keys(wire.wire).length > 0 ? { reasoning: wire.wire } : {}),
				serialized: () => serializedInput,
				serializedReasoning: options.manualBudget === true,
				budget: options.manualBudget === true ? MANUAL_SUMMARY_BUDGET : SUMMARY_MAX_OUTPUT,
				...(options.signal !== undefined ? { signal: options.signal } : {}),
				...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
			});
			summaryPath = path;
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
				const canonical = canonicalizeUsageForModel(binding.model, binding.baseUrl, binding.provider ?? "adapter", usage);
				const line = JSON.stringify({ kind: "summary", canonical, ...(summaryPath !== null ? { path: summaryPath } : {}) }) + "\n";
				mkdirSync(join(this.#store.root, "traces"), { recursive: true, mode: 0o700 }); // DF-0322-F1
				appendFileSync(join(this.#store.root, "traces", `${this.id}.jsonl`), line, { mode: 0o600 });
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
		// A1b: with the in-run tiers armed, the kernel's compaction point
		// decides before every request, the first one included.
		if (policy.tiers !== undefined) return;
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
		if (this.contextUsed() <= triggerTokens) return;
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
	 * TV-1A — assess the task claims and their evidence freshness over THIS
	 * session's durable log. The non-mutating set comes from the live tools'
	 * own `effects.precommitSafe` certificates (one direction of truth,
	 * never a second declaration) — the read-only+free+local contract, the
	 * only certificate that proves the world untouched. `concurrency:
	 * "shared"` is a SCHEDULING promise and never feeds this set (TV-1C —
	 * slow_touch is shared and writes). The evidence policy defaults to
	 * {"shell"} — the convention the task extension's own "make the LAST
	 * item a verification step" guidance produces.
	 */
	assessTasks(opts?: { readonly evidenceTools?: ReadonlySet<string> }): TaskAssessment {
		const nonMutatingTools = new Set<string>();
		for (const tool of this.#config.registry.list()) {
			if (tool.effects?.precommitSafe === true) nonMutatingTools.add(tool.name);
		}
		return assessTasks(this.log.all, {
			nonMutatingTools,
			evidenceTools: opts?.evidenceTools ?? DEFAULT_EVIDENCE_TOOLS,
		});
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
		if (record.status !== "uncertain") return; // idempotent + irreversible (the append below is synchronous, so a same-tick second call sees it)
		// CT-1 (ADR-0051 Amendment 6): the verdict is persisted directly — there
		// is no live resolver to hand it to (the loop never read one since
		// ADR-0038; the round-7 live branch that waited for it was unreachable).
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

	// ── internal: the resolver registry ──────────────────────────────────

	registerResolver(decisionId: string, resolve: (decision: PermissionDecision) => void): void {
		this.#pendingResolvers.set(decisionId, resolve);
	}

	/** round 4 (adversarial): a verdict the human already gave for a live decision. */
	approvalVerdict(decisionId: string): boolean | undefined {
		return this.#approvalVerdicts.get(decisionId);
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
	/**
	 * ADR-0055 Amendment 1 (A1b) — the IN-RUN tiers, drawn from the window:
	 * soft `min(0.5·w, 400K)` waits for a phase end, hard `min(0.8·w, 700K)`
	 * and emergency `w − reserve` fire at the next request, an overflow once.
	 * Present, the kernel asks before every request; the run-start summary
	 * and the standing microcompact above do not apply. `isCheck` is the
	 * phase detector's rule 1 (default: the runner table).
	 */
	readonly tiers?: {
		readonly windowTokens: number;
		readonly isCheck?: (command: string) => boolean;
		readonly maxFailures?: number;
		/** ADR-0055 Amendment 2: told when a checkpoint is discarded because it
		 *  did not shrink the context — chars/4 estimates only, never text. */
		readonly onDiscard?: (info: { readonly reason: string; readonly pre: number; readonly post: number; readonly summary: number }) => void;

		/** ADR-0055 Amendment 2 (decision 3): the window someone STATED for the
		 *  live binding, or null when the tiers run on a fallback. Absent, the
		 *  caller's own windowTokens counts as stated. Only a stated window
		 *  arms the overflow belt. */
		readonly statedWindow?: () => number | null;

		/** CW-1 batch 2: told when an endpoint's refusal states its cap — the
		 *  binding it was learned for rides along. The tiers have already
		 *  taken it (only ever down); the caller keeps it for later sessions. */
		readonly onWindowLearned?: (learned: { readonly tokens: number; readonly model: string; readonly baseUrl?: string }) => void;
	};
}

export interface SessionConfig {
	readonly model: string;
	/** E1: the adapter identity (anthropic / openai-compat / openai-responses) — trace
	 *  provenance, additive (S1 surface untouched: type-only, optional). */
	readonly provider?: "anthropic" | "openai-compat" | "openai-responses";
	/** OR-1: the adapter's endpoint. The registry row for one model id can
	 *  differ per endpoint (gpt-5.5 is priced at the first-party API and
	 *  unpriced at the ChatGPT backend), so the cost path and the window
	 *  lookup key on (model, endpoint). Travels with the live binding,
	 *  exactly as `provider` does. Type-only, optional. */
	readonly baseUrl?: string;
	/** MG-1 (A5): the run's continuation scope — the kernel stamps it on
	 *  committed envelopes; absent = unscoped (envelopes stripped). */
	readonly continuationScope?: import("@vincemakes/kiso-core").ContinuationScope;
	/** XP-1: the selected reasoning axes (native-only resolution per request). */
	readonly reasoning?: import("./provider/metadata.js").ReasoningSetting;
	/** XP-1 internal: a legacy session's deferred revision-1 write. */
	readonly profilePending?: true;
	/** DC-60 internal: a NEW session — nothing is on disk yet; its revision 1
	 *  (with the workspace it opened in) lands with its first durable event. */
	readonly newSession?: { readonly workspace: string | null };
	/** 0.40.0: the config profile name in force — recorded per revision. */
	readonly profileName?: string;
	/** 0.40.0: set when this open acknowledged material drift. */
	readonly driftAcknowledgement?: import("./agent.js").DriftAcknowledgement;
	readonly systemPrompt?: string;
	readonly tools?: readonly Tool<any>[];
	readonly registry: import("@vincemakes/kiso-core").ToolRegistry;
	readonly hooks?: import("@vincemakes/kiso-core").HookHost;
	readonly maxTurns?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	/** C area: microcompact threshold — passed through to the loop verbatim. */
	readonly microcompact?: { readonly thresholdTokens: number };
	/** E6: the session context policy (run-start actions, injection-side only). */
	readonly contextPolicy?: ContextPolicy;
	readonly maxRetries?: number;
	/** LT-1: the stream watchdog's idle bound (ms); default 120 s, 0 off. */
	readonly streamIdleMs?: number;
	/** R1: the tool table's vocabulary rows, the product's (see AgentDefinition). */
	readonly toolRules?: ReadonlyArray<{ readonly tool: string; readonly line: string }>;
	/** 0.42.0: "off" withholds the generated tool table entirely (see AgentDefinition). */
	readonly toolTable?: "on" | "off";
	/**
	 * E1: loaded extensions — their tools join the registry (idempotently;
	 * a collision with a built-in name was already rejected at agent
	 * creation), their hooks compose AFTER the existing ones (the existing come first),
	 * their approval policies enter the loop's policy chain.
	 */
	readonly extensions?: readonly KisoExtension[];
}
