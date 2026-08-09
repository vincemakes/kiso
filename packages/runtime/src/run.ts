/**
 * the ergonomics batch B4 (pure move) — the Run class (a single turn: write-ahead
 * persistence, the loop drive, the durable recovery state machine), moved
 * verbatim from session.ts.
 */

import { denialResult, loop, type AbortSignalLike, type Adapter, type Event, type EventLog, type PermissionDecision, type ToolResult } from "@vincemakes/kiso-core";
import type { SessionStore } from "./store.js";
import { ABORTED, MergedSignal, abortable, openRunId } from "./recovery.js";
import { composeSystemPrompt, composeToolTable, microcompactFor } from "./compose.js";
import { truncationGuard } from "./truncation-guard.js";
import { ResumeBlockedError, type AgentSession, type SessionConfig } from "./session.js";

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
			// round 4: health is re-checked when the iterator ACTUALLY starts —
			// a run constructed before the session was poisoned must fail
			// here, before any log or disk mutation.
			this.#session.ensureHealthy();
			this.#session.beginRun(this);
			const log = this.#session.log;
			const signal = this.#externalSignal ? new MergedSignal(this.#abort.signal, this.#externalSignal) : this.#abort.signal;
			// E2: the session's own microcompact wins; otherwise the FIRST
			// extension providing a compaction config supplies it.
			const microcompact = microcompactFor(this.#config);
			// 0.1.40 (R-C item 1): the tool substitution table — the ACTIVE tool
			// set's vocabulary, snippets, and guidelines — sits BETWEEN the
			// session's base prompt and the extension appends: generated
			// machinery never outranks the deliberate extension text (the E2
			// "append lands at the END" contract holds). "" when empty.
			const toolTable = composeToolTable(this.#config.registry);
			const basePrompt = toolTable === "" ? this.#config.systemPrompt
				: this.#config.systemPrompt === undefined ? toolTable
				: `${this.#config.systemPrompt}\n\n${toolTable}`;
			// E2: the session's own systemPrompt first, then every extension
			// append in LOAD order — deterministic (same extensions → same
			// prompt); no appends → byte-identical to the extension-less run.
			const systemPrompt = composeSystemPrompt(basePrompt, this.#config.extensions ?? []);
			const loopConfig = () =>
				({
					// 0.1.40 (R-C item 3): the truncation guard gates the model
					// stream — a truncated turn's tool batch never executes.
					adapter: truncationGuard(this.#adapter),
					model: this.#config.model,
					sessionId: this.#session.id, // P3: tools see their session (ToolContext.sessionId)
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
					// round 4 (adversarial): the abort paths consult these so a verdict
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
				// ── B group: recovery is PER-RUN, keyed by StoreRecord.runId ──
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
				//    terminal must not suppress it (B group).
				if (!lastOpen.events.some((e) => e.type === "terminal")) {
					for await (const ev of runLoop()) yield ev;
				}
				return;
			}

			// round 4: a session with an open run REFUSES new runs at the
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
			// round 5(P1-5): flush verdicts the consumer submitted before the
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
			// round 4: paired by events NEWER than the request — a historical
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
					// round 5(P1-6): a verdict given in the same instant as the
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
					// round 4 (adversarial): a verdict given in the same instant as the
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
					callId: pending.callId, // binds the decision to the invocation (B group)
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
		// re-visit them. round 4: pairing is by executionId — a same-callId result
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
							// round 8: the repaired result reproduces the normal path
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

		// B group crash window: a resolution was persisted but its tool_result
		// fill never landed — complete it so the model is never left staring
		// at a dangling tool_use. round 4: keyed by executionId, and the fill
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

		// ruling #12 correction one: the honest note rides the recovered failure too —
		// the receipt and the repaired tool_result reproduce the live path
		// losslessly.
		if (result.isError && tool?.idempotent !== true) {
			result = {
				...result,
				content: `${result.content}\n[non-idempotent tool failed — its side effects may have partially applied; verify before retrying]`,
			};
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
			// round 5: live tags survive the resumed path too.
			...(result.tags !== undefined ? { tags: result.tags } : {}),
			executionId,
		});
		// ruling #12 (ADR-0038): the failed-receipt uncertain PAUSE is REMOVED
		// here too (it mirrored the live loop's C group pause) — a complete
		// receipt IS the outcome; uncertainty belongs to the crash window
		// alone. A retry passes the approval chain again.
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
