/**
 * the ergonomics batch B4 (pure move) — the Run class (a single turn: write-ahead
 * persistence, the loop drive, the durable recovery state machine), moved
 * verbatim from session.ts.
 */

import { denialResult, loop, type AbortSignalLike, type Adapter, type ApprovalChain, type ChainVerdict, type Event, type EventLog, type HookHost, type PermissionDecision, type ToolCallPayload, type ToolResult } from "@vincemakes/kiso-core";
import type { SessionStore } from "./store.js";
import { ABORTED, MergedSignal, abortable, openRunId } from "./recovery.js";
import { composeApprovalChain, composeSystemPrompt, composeToolTable, microcompactFor } from "./compose.js";
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
			const approvalChain = composeApprovalChain(this.#config.extensions ?? []);
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
					// E1: the composed approval chain — the extensions'
					// policies composed into ONE gate (deny > allow > ask).
					...(approvalChain !== undefined ? { approvalPolicy: approvalChain } : {}),
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
				for await (const ev of this.#recover(log, signal, lastOpen.events, approvalChain, this.#config.hooks)) {
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
	 *
	 * R-E 0.1.43 (Gap A): a committed turn's tool_call_end with no durable
	 * decision and no execution is UNDECIDED — recovery re-enters it into
	 * the approval pipeline before anything else (only a durable
	 * permission_decided authorizes an effect).
	 */
	async *#recover(
		log: EventLog,
		signal: AbortSignalLike,
		scope: readonly Event[],
		approvalChain: ApprovalChain | undefined,
		hooks: HookHost | undefined,
	): AsyncGenerator<Event> {
		// ── Gap B: the tail draft is abandoned — never committed history ──
		// "A model output suffix without a committed stop is an incomplete
		// draft and must never become committed provider history." The
		// resume appends the abandon marker FIRST: it voids the range after
		// the last committed boundary (stop / user_input / terminal /
		// compaction / summarized — or an earlier marker), so the projection
		// excludes the draft and a call inside it is never executed (the
		// boundary clause: the two Gaps divide at the stop). The audit bytes
		// stay; a marker is kernel-exclusive (the AdapterEvent whitelist).
		// Idempotent: an already-voided draft has a marker as its last
		// boundary — the detection finds no output after it, and the
		// recovered events (decided/started/result) are no draft.
		const boundary = [...scope].reverse().find(
			(e) =>
				e.type === "stop" ||
				e.type === "user_input" ||
				e.type === "terminal" ||
				e.type === "microcompacted" ||
				e.type === "compacted" ||
				e.type === "summarized" ||
				e.type === "model_output_abandoned",
		);
		if (boundary !== undefined) {
			// R-E 0.1.44 (verified against sentence 2): the draft detection
			// stays text-only — a bare tool-call suffix [tool_call_end,
			// permission_requested] with no text is the legal approval-panel
			// pause (the Area 2 contract: the pending request binds and
			// executes, pair-closed — the extensions-e2e gate). The finding's
			// shapes all carry text, and the VOID SCOPE (what the marker
			// covers) is the type filter at project.ts: model output dies
			// with the draft, the framework's facts never do.
			const draft = scope.some(
				(e) => (e.type === "text_delta" || e.type === "thinking") && e.seq > boundary.seq,
			);
			if (draft) {
				yield log.append({
					type: "model_output_abandoned",
					voidFromSeq: boundary.seq,
					reason: "a model output suffix without a committed stop — abandoned on resume",
				});
			}
		}
		// The invocation's framework identity (R-E 0.1.43): the
		// tool_call_end's seq — carried by new logs, derived by
		// callId+proximity for old ones (the last such call before the seq).
		const callSeqOf = (callId: string, before: number): number | undefined => {
			let seq: number | undefined;
			for (const e of scope) {
				if (e.type === "tool_call_end" && e.callId === callId && e.seq < before) seq = e.seq;
			}
			return seq;
		};
		// ── Gap A: a committed turn's UNDECIDED invocation ────────────────
		// A durable stop with a bare tool_call_end (no decision, no
		// execution) re-enters the approval pipeline: the composed chain
		// decides — allow → durable permission_decided (decidedBy
		// faithfully) + the persisted execution; deny → decided + the
		// denial result; ask/all-abstain → permission_requested (the
		// requests pass below announces it and waits for the human). No
		// guessing, no inheriting, no retro-authorization — re-decide.
		// A durable POLICY verdict (E1: decidedBy set) newer than the call
		// binds it — the chain never re-runs for a decided invocation.
		const gapAsks: (Event & { type: "permission_requested" })[] = [];
		for (const call of scope) {
			if (call.type !== "tool_call_end") continue;
			// The boundary clause (the directive): a call whose turn has no
			// legal stop is a DRAFT's call — Gap B voids it (never executed,
			// never in the provider projection); this stage never touches it.
			// The two Gaps divide at the stop; no mixing.
			const turnEnd = scope.find((e) => e.type === "user_input" && e.seq > call.seq)?.seq ?? Number.POSITIVE_INFINITY;
			const turnStop = scope.some((e) => e.type === "stop" && e.seq > call.seq && e.seq < turnEnd);
			if (!turnStop) continue;
			// The requests pass below owns request-tracked invocations (it
			// binds the stored request by decisionId, or pauses for the
			// human) — Gap A must never re-decide over a stored
			// permission_requested. "Only a durable permission_decided
			// authorizes an effect": a pending request is not a decision.
			const hasRequest = log.all.some(
				(e) => e.type === "permission_requested" && e.callId === call.callId && e.seq > call.seq,
			);
			if (hasRequest) continue;
			const decided = log.all.find(
				(e): e is Event & { type: "permission_decided" } =>
					e.type === "permission_decided" && e.callId === call.callId && e.seq > call.seq && e.decidedBy !== undefined,
			);
			const hasExecution = log.all.some(
				(e) => e.type === "tool_execution_started" && e.callId === call.callId && e.seq > call.seq,
			);
			const hasResult = log.all.some((e) => e.type === "tool_result" && e.callId === call.callId && e.seq > call.seq);
			if (hasResult) continue; // closed — nothing to fill
			if (decided !== undefined) {
				// E1: the durable verdict speaks for the call — apply it
				// without re-running the chain.
				if (signal.aborted) return;
				if (decided.decision === "approved" && !hasExecution) {
					yield* this.#executePersisted(call.callId, call.name, call.input ?? {}, call.seq, signal);
				} else if (!hasResult) {
					yield* this.#denialResult(call.callId, decided.reason ?? "denied by user", call.seq);
				}
				continue;
			}
			// UNDECIDED — re-enter the approval pipeline with the LIVE
			// decision order (loop.ts decideCall): the composed chain
			// first; only when no chain exists do the hooks' onPreTool
			// speak (defer → ask, deny → deny, allow → allow); no policies
			// at all → the kernel's default allow. Same semantics as the
			// live path — a defer policy must not collapse into an
			// auto-allow on resume. A throwing chain counts as ask: it
			// speaks, never silently (the live parity).
			const payload: ToolCallPayload = { callId: call.callId, name: call.name, input: call.input ?? {} };
			// The chain's PolicyCall carries name+input only — callId is the
			// framework's, the hook's is the provider-facing ToolCallPayload.
			const policyCall = { name: payload.name, input: payload.input };
			let verdict: ChainVerdict | PermissionDecision | undefined;
			try {
				if (approvalChain !== undefined) {
					const chainVerdict = await abortable(
						Promise.resolve(approvalChain.decide(policyCall, { signal, sessionId: this.#session.id })),
						signal,
					);
					if (chainVerdict === ABORTED) return;
					verdict = chainVerdict;
				}
			} catch {
				verdict = { action: "ask" };
			}
			if (verdict === undefined && hooks?.onPreTool !== undefined) {
				const decision = await abortable(Promise.resolve(hooks.onPreTool(payload, { sessionId: this.#session.id })), signal);
				if (decision === ABORTED) return;
				if (decision.action === "defer") verdict = { action: "ask" };
				else if (decision.action !== "allow") verdict = { action: "deny", reason: decision.reason ?? "denied" };
				else verdict = { action: "allow" };
			}
			if (verdict === undefined) verdict = { action: "allow" }; // no policies — the kernel's default allow
			const decisionId = `d-${log.all.length + 1}`;
			if (verdict.action === "allow") {
				yield log.append({
					type: "permission_decided",
					decisionId,
					callId: call.callId,
					invocationSeq: call.seq,
					decision: "approved",
					...("decidedBy" in verdict ? { decidedBy: verdict.decidedBy } : {}),
				});
				if (signal.aborted) return;
				yield* this.#executePersisted(call.callId, call.name, call.input ?? {}, call.seq, signal);
			} else if (verdict.action === "deny") {
				yield log.append({
					type: "permission_decided",
					decisionId,
					callId: call.callId,
					invocationSeq: call.seq,
					decision: "denied",
					...("reason" in verdict && verdict.reason !== undefined ? { reason: verdict.reason } : {}),
					...("decidedBy" in verdict ? { decidedBy: verdict.decidedBy } : {}),
				});
				yield* this.#denialResult(call.callId, ("reason" in verdict && verdict.reason) || "denied", call.seq);
			} else {
				// ask / all-abstain — the requests pass below announces the
				// stored request and waits for the human.
				const appended = log.append({
					type: "permission_requested",
					decisionId,
					callId: call.callId,
					invocationSeq: call.seq,
					name: call.name,
					input: call.input ?? {},
				}) as Event & { type: "permission_requested" };
				gapAsks.push(appended);
				yield appended;
			}
		}
		const requests = [...scope.filter((e): e is Event & { type: "permission_requested" } => e.type === "permission_requested"), ...gapAsks];
		for (const pending of requests) {
			// R-E 0.1.43: the writes below carry the invocation's framework
			// identity — the request's own, or the callId+proximity
			// fallback for old logs (the compat contract).
			const invocationSeq = pending.invocationSeq ?? callSeqOf(pending.callId, pending.seq);
			// R-E 0.1.44 (sentence 3): a stored request whose invocation is
			// VOIDED is expired — never re-presented, never executed (the
			// dead-run expiry precedent above). The void ranges come from
			// log.all — the marker THIS recovery appended is included. The
			// receipt stays in the audit; only the presentation is gone.
			// An identity-less request (an old log where neither the field nor
			// the callId+proximity fallback yields a seq) is never proven
			// voided — it keeps the pre-0.1.44 behavior.
			const voided =
				invocationSeq !== undefined &&
				log.all.some(
					(e) => e.type === "model_output_abandoned" && invocationSeq > e.voidFromSeq && invocationSeq <= e.seq,
				);
			if (voided) {
				yield log.append({
					type: "permission_expired",
					decisionId: pending.decisionId,
					reason: "the invocation was abandoned with an incomplete draft — never re-presented, never executed",
				});
				continue;
			}
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
					if (!hasExecution) yield* this.#executePersisted(pending.callId, pending.name, pending.input, invocationSeq, signal);
				} else if (!hasResult) {
					yield* this.#denialResult(pending.callId, final.reason ?? "denied by user", invocationSeq);
				}
			} else if (decided.decision === "approved") {
				// Decided while no process was running: apply without pausing.
				// An abort during recovery must stop the pending executions,
				// exactly like the live loop's sibling guard (finding 3).
				if (signal.aborted) return;
				if (!hasExecution) yield* this.#executePersisted(pending.callId, pending.name, pending.input, invocationSeq, signal);
			} else if (!hasResult) {
				yield* this.#denialResult(pending.callId, decided.reason ?? "denied by user", invocationSeq);
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
		invocationSeq: number | undefined,
		signal: AbortSignalLike,
	): AsyncGenerator<Event> {
		const log = this.#session.log;
		const tool = this.#config.registry.get(name);
		const executionId = `ex-${log.lastSeq + 1}`;

		// An abort that landed while the decision was being applied must
		// not start the side effect (finding 3).
		if (signal.aborted) return;
		yield log.append({
			type: "tool_execution_started",
			executionId,
			callId,
			...(invocationSeq !== undefined ? { invocationSeq } : {}),
			name,
			input,
		});

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
				...(invocationSeq !== undefined ? { invocationSeq } : {}),
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
				...(invocationSeq !== undefined ? { invocationSeq } : {}),
				result: { content: result.content, isError: false },
				...(result.tags !== undefined ? { tags: result.tags } : {}),
			});
		}
		yield log.append({
			type: "tool_result",
			callId,
			...(invocationSeq !== undefined ? { invocationSeq } : {}),
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
	async *#denialResult(callId: string, reason: string, invocationSeq: number | undefined): AsyncGenerator<Event> {
		const denial = denialResult(reason);
		yield this.#session.log.append({
			type: "tool_result",
			callId,
			...(invocationSeq !== undefined ? { invocationSeq } : {}),
			content: denial.content,
			isError: true,
			errorKind: denial.errorKind,
		});
	}
}
