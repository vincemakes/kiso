/**
 * the ergonomics batch B4 (pure move) — the Run class (a single turn: write-ahead
 * persistence, the loop drive, the durable recovery state machine), moved
 * verbatim from session.ts.
 */

import { denialResult, loop, type AbortSignalLike, type Adapter, type ApprovalChain, type ChainVerdict, type Event, type EventLog, type HookHost, type PermissionDecision, type ToolCallPayload, type ToolResult } from "@vincemakes/kiso-core";
import type { SessionStore } from "./store.js";
import { ABORTED, MergedSignal, abortable, openRunId } from "./recovery.js";
import { deriveRecoveryPlan, invocationSeqOf } from "./recovery-plan.js";
import { composeApprovalChain, composeSystemPrompt, composeToolTable, microcompactFor } from "./compose.js";
import { truncationGuard } from "./truncation-guard.js";
import { RequestTracer, traceGuard } from "./trace/guard.js";
import { runtimeVersion } from "./trace/writer.js";
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
		let tracer: RequestTracer | null = null;
		try {
			// round 4: health is re-checked when the iterator ACTUALLY starts —
			// a run constructed before the session was poisoned must fail
			// here, before any log or disk mutation.
			this.#session.ensureHealthy();
			this.#session.beginRun(this);
			const log = this.#session.log;
			// E1 (1.2.0): the request tracer — the observation ledger. It
			// sits at the adapter boundary; the model-visible byte stream is
			// untouched (I6, trace-bytes.test.ts). Soft-fail: a degraded
			// writer costs one stderr line and the run goes on.
			tracer = new RequestTracer({
				root: this.#store.root,
				sessionId: this.#session.id,
				runId: this.runId,
				provider: this.#config.provider ?? "adapter",
				model: this.#config.model,
				adapterVersion: runtimeVersion(),
				log: log.all,
			});
			tracer.init();
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
					adapter: traceGuard(tracer!, truncationGuard(this.#adapter)), // tracer assigned above, before loopConfig
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

				// Uncertain executions block until a human decides — the
				// recovery plan derives RESOLVE_UNCERTAIN and the driver
				// throws below (same list, same order; R-F 0.1.46).

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
			// E1: the run's ledger story — the run_end lands synchronously
			// (a killed run leaves no run_end, and the next init marks it).
			tracer?.finishRun();
			this.#session.endRun(this);
		}
	}

	// ── Area 2: the recovery — a thin driver over the recovery plan ───────
	// R-F 0.1.46: recovery is a PURE PROJECTION (recovery-plan.ts) consumed
	// by this driver. The durable prefix derives THE one safe next step;
	// the driver executes it and re-derives. The old state machine's phases
	// are now action cases — the prefix-table gate and the healing fixtures
	// run unchanged (the zero-behavior proof), and each phase's semantics
	// live in the plan's derivation or in the step below.

	/**
	 * Consume the recovery plan one action at a time: execute the derived
	 * step, re-derive, stop when nothing is left (CONTINUE_MODEL — the
	 * resume's continuation drives the loop from there). The steps write
	 * only what the plan derived; the NEXT derive applies it (EXECUTE /
	 * REPAIR_RESULT), so the recovery is a loop over the projection, never
	 * a second state machine. An abort that lands mid-step ends the
	 * recovery: re-deriving would re-present the same action forever (the
	 * steps' pre-execution abort guards rely on this).
	 */
	async *#recover(
		log: EventLog,
		signal: AbortSignalLike,
		scope: readonly Event[],
		approvalChain: ApprovalChain | undefined,
		hooks: HookHost | undefined,
	): AsyncGenerator<Event> {
		for (;;) {
			const action = deriveRecoveryPlan(log.all, scope);
			switch (action.kind) {
				case "COMPLETED":
				case "TERMINAL":
					return;
				case "CONTINUE_MODEL":
					// Upgrade-path housekeeping (the old requests pass did it
					// at the first resume): a request voided by an EARLIER
					// marker whose expiry never landed — the pre-0.1.44 logs,
					// where the marker existed but the expiry did not — is
					// expired here. Idempotent: only the missing expiry is
					// written; the re-derive then skips the expired request.
					if (yield* this.#expireStaleVoidedRequests(scope, log)) break;
					return;
				case "RESOLVE_UNCERTAIN": {
					// The crash window: uncertain executions block until a
					// human decides (never auto-rerun). The full list goes to
					// the throw, in log order — the first in the plan's
					// derivation is the first in this list (the ledger's
					// insertion order).
					const uncertain = this.#session.uncertainExecutions();
					throw new ResumeBlockedError(
						uncertain.map((u) => ({ executionId: u.executionId, callId: u.callId, name: u.name })),
					);
				}
				case "ABANDON_DRAFT":
					yield* this.#abandonDraft(action.voidFromSeq, scope, log);
					break;
				case "DECIDE_PERMISSION":
					yield* this.#decidePermission(action.invocationSeq, scope, log, signal, approvalChain, hooks);
					break;
				case "WAIT_PERMISSION":
					yield* this.#waitPermission(action.invocationSeq, scope, log, signal);
					break;
				case "EXECUTE":
					yield* this.#executeInvocation(action.invocationSeq, scope, log, signal);
					break;
				case "REPAIR_RESULT":
					if (action.executionId !== undefined) yield* this.#repairReceipt(action.executionId, scope, log);
					else yield* this.#repairDenial(action.invocationSeq!, scope, log);
					break;
				case "FILL_RESOLUTION":
					yield* this.#fillResolution(action.executionId, scope, log);
					break;
			}
			if (signal.aborted) return;
		}
	}

	/** The open run's stored requests PLUS this recovery's own asks — the
	 *  same list the plan's request pass derives over (scope order, then
	 *  the log tail in append order). */
	#storedRequests(scope: readonly Event[], log: EventLog): (Event & { type: "permission_requested" })[] {
		const lastScopeSeq = scope.length > 0 ? scope[scope.length - 1]!.seq : -1;
		return [
			...scope.filter((e): e is Event & { type: "permission_requested" } => e.type === "permission_requested"),
			...log.all.filter(
				(e): e is Event & { type: "permission_requested" } =>
					e.type === "permission_requested" && e.seq > lastScopeSeq,
			),
		];
	}

	/** The invocation the plan keyed by seq — a committed call in the scope,
	 *  or a stored request (the old-log identity fallback included). */
	#invocationFor(
		invocationSeq: number,
		scope: readonly Event[],
		log: EventLog,
	): (Event & { type: "tool_call_end" }) | (Event & { type: "permission_requested" }) | undefined {
		const call = scope.find(
			(e): e is Event & { type: "tool_call_end" } => e.type === "tool_call_end" && e.seq === invocationSeq,
		);
		if (call !== undefined) return call;
		return this.#storedRequests(scope, log).find((e) => (invocationSeqOf(e, scope) ?? e.seq) === invocationSeq);
	}

	/**
	 * The ABANDON_DRAFT step (Gap B): the marker voids the draft's range —
	 * model output only, the audit bytes stay, a call inside the range is
	 * never executed (the kernel's type filter keeps the framework's
	 * facts). The SAME step expires every stored request whose invocation
	 * falls in the voided range (sentence 3: never re-presented, never
	 * executed) — the old requests pass appended these later; the fold
	 * makes the void and its expiry ONE deterministic step. Idempotent: an
	 * already-expired request is never re-expired, and an already-voided
	 * draft derives no ABANDON_DRAFT (the marker is the last boundary).
	 */
	async *#abandonDraft(voidFromSeq: number, scope: readonly Event[], log: EventLog): AsyncGenerator<Event> {
		const marker = log.append({
			type: "model_output_abandoned",
			voidFromSeq,
			reason: "a model output suffix without a committed stop — abandoned on resume",
		});
		yield marker;
		for (const pending of scope) {
			if (pending.type !== "permission_requested") continue;
			const invocationSeq = pending.invocationSeq ?? invocationSeqOf(pending, scope);
			if (invocationSeq === undefined) continue;
			if (!(invocationSeq > voidFromSeq && invocationSeq <= marker.seq)) continue;
			if (log.all.some((e) => e.type === "permission_expired" && e.decisionId === pending.decisionId)) continue;
			yield log.append({
				type: "permission_expired",
				decisionId: pending.decisionId,
				reason: "the invocation was abandoned with an incomplete draft — never re-presented, never executed",
			});
		}
	}

	/**
	 * The DECIDE_PERMISSION step (Gap A, undecided): the committed call
	 * re-enters the approval pipeline with the LIVE decision order
	 * (loop.ts decideCall) — the composed chain first; only when no chain
	 * exists do the hooks' onPreTool speak (defer → ask, deny → deny,
	 * allow → allow); no policies at all → the kernel's default allow. A
	 * throwing chain counts as ask: it speaks, never silently (the live
	 * parity). Only the DECISION is written here — the EXECUTE /
	 * REPAIR_RESULT steps apply it on the next derive. The ask's request
	 * is announced immediately (the consumer may answer; the
	 * WAIT_PERMISSION step re-announces and pauses when it did not).
	 */
	async *#decidePermission(
		invocationSeq: number,
		scope: readonly Event[],
		log: EventLog,
		signal: AbortSignalLike,
		approvalChain: ApprovalChain | undefined,
		hooks: HookHost | undefined,
	): AsyncGenerator<Event> {
		const call = scope.find(
			(e): e is Event & { type: "tool_call_end" } => e.type === "tool_call_end" && e.seq === invocationSeq,
		);
		if (call === undefined) throw new Error(`the recovery plan derived a call outside the scope (seq ${invocationSeq})`);
		// The chain's PolicyCall carries name+input only — callId is the
		// framework's, the hook's is the provider-facing ToolCallPayload.
		const payload: ToolCallPayload = { callId: call.callId, name: call.name, input: call.input ?? {} };
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
		// The recovery's own decision is a POLICY verdict (the plan's E1
		// rule: only a decidedBy-carrying decision binds the call — a human
		// verdict binds its request, never the call). The driver's write
		// must satisfy its own plan: no decidedBy → the re-derive would
		// derive DECIDE_PERMISSION again forever (the plan cannot tell the
		// driver's write from a human's). Stamped "mode:default" when the
		// verdict carries none — the gates' seeded convention.
		const decisionId = `d-${log.all.length + 1}`;
		if (verdict.action === "allow") {
			yield log.append({
				type: "permission_decided",
				decisionId,
				callId: call.callId,
				invocationSeq: call.seq,
				decision: "approved",
				decidedBy: "decidedBy" in verdict ? verdict.decidedBy : "mode:default",
			});
		} else if (verdict.action === "deny") {
			yield log.append({
				type: "permission_decided",
				decisionId,
				callId: call.callId,
				invocationSeq: call.seq,
				decision: "denied",
				...("reason" in verdict && verdict.reason !== undefined ? { reason: verdict.reason } : {}),
				decidedBy: "decidedBy" in verdict ? verdict.decidedBy : "mode:default",
			});
		} else {
			// ask / all-abstain — the WAIT_PERMISSION step announces the
			// stored request and awaits the human.
			yield log.append({
				type: "permission_requested",
				decisionId,
				callId: call.callId,
				invocationSeq: call.seq,
				name: call.name,
				input: call.input ?? {},
			});
		}
	}

	/**
	 * The WAIT_PERMISSION step (a stored request, undecided): the resolver
	 * is registered, the stored request announced, and the human's decision
	 * awaited. An abort during the wait ends the run — the request stays
	 * durable and pending, and a verdict given in the same instant as the
	 * abort is recorded exactly once (the round-4 adversarial path). Only
	 * the DECISION is written here — the EXECUTE / REPAIR_RESULT steps
	 * apply it on the next derive.
	 */
	async *#waitPermission(
		invocationSeq: number,
		scope: readonly Event[],
		log: EventLog,
		signal: AbortSignalLike,
	): AsyncGenerator<Event> {
		const pending = this.#storedRequests(scope, log).find((e) => (invocationSeqOf(e, scope) ?? e.seq) === invocationSeq);
		if (pending === undefined) throw new Error(`the recovery plan derived a request outside the log (seq ${invocationSeq})`);
		const pendingDecision = new Promise<PermissionDecision>((resolve) => {
			this.#decisionIds.push(pending.decisionId);
			this.#session.registerResolver(pending.decisionId, resolve);
		});
		yield pending;
		// Area 4: an abort during the resumed approval wait ends the run;
		// the request stays durable and pending.
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
			// round 4 (adversarial): a verdict given in the same instant as
			// the abort is recorded (exactly once), never lost.
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
	}

	/**
	 * The EXECUTE step: a durable approval authorizes the persisted call —
	 * the original name/input/callId (never re-asked of the model, never
	 * re-approved), the full ledgered lifecycle, and the ruling-#12
	 * receipt-as-outcome semantics.
	 */
	async *#executeInvocation(
		invocationSeq: number,
		scope: readonly Event[],
		log: EventLog,
		signal: AbortSignalLike,
	): AsyncGenerator<Event> {
		const invocation = this.#invocationFor(invocationSeq, scope, log);
		if (invocation === undefined) throw new Error(`the recovery plan derived an invocation outside the log (seq ${invocationSeq})`);
		yield* this.#executePersisted(invocation.callId, invocation.name, invocation.input ?? {}, invocationSeq, signal);
	}

	/**
	 * The REPAIR_RESULT step for a receipt (executionId): an execution that
	 * reached a terminal state but whose model-facing result never landed
	 * is completed FROM THE RECEIPT — never re-executed. Pairing is by
	 * executionId (round 4) — a same-callId result from a different
	 * execution never suppresses the repair.
	 */
	async *#repairReceipt(executionId: string, scope: readonly Event[], log: EventLog): AsyncGenerator<Event> {
		const ev = scope.find(
			(e): e is Event & { type: "tool_execution_succeeded" | "tool_execution_failed" } =>
				(e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") && e.executionId === executionId,
		);
		if (ev === undefined) throw new Error(`the recovery plan derived a receipt outside the scope (${executionId})`);
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

	/**
	 * The REPAIR_RESULT step for a durable denial (invocationSeq): the
	 * model-facing result of the denied invocation is completed from its
	 * durable permission_decided — no execution happened. The REQUEST is
	 * looked up first (its decision binds by decisionId — the human's
	 * verdict carries no decidedBy); the call fallback covers the Gap-A
	 * policy-verdict shape, which can only derive when NO request exists
	 * (Gap A never re-decides over a stored request).
	 */
	async *#repairDenial(invocationSeq: number, scope: readonly Event[], log: EventLog): AsyncGenerator<Event> {
		const request = this.#storedRequests(scope, log).find((e) => (invocationSeqOf(e, scope) ?? e.seq) === invocationSeq);
		const call = scope.find(
			(e): e is Event & { type: "tool_call_end" } => e.type === "tool_call_end" && e.seq === invocationSeq,
		);
		const decided = log.all.find(
			(e): e is Event & { type: "permission_decided" } =>
				e.type === "permission_decided" &&
				(request !== undefined
					? e.decisionId === request.decisionId
					: call !== undefined && e.callId === call.callId && e.seq > call.seq && e.decidedBy !== undefined),
		);
		if (decided === undefined || (request?.callId ?? call?.callId) === undefined) {
			throw new Error(`the recovery plan derived a denial without its decision (seq ${invocationSeq})`);
		}
		yield* this.#denialResult(request?.callId ?? call!.callId, decided.reason ?? "denied by user", invocationSeq);
	}

	/**
	 * The FILL_RESOLUTION step: a resolution was persisted but its
	 * model-facing fill never landed — complete it so the model is never
	 * left staring at a dangling tool_use. Keyed by executionId; the fill
	 * carries it, so a same-callId result from another execution is never
	 * confused with this one (round 4).
	 */
	async *#fillResolution(executionId: string, scope: readonly Event[], log: EventLog): AsyncGenerator<Event> {
		const ev = scope.find(
			(e): e is Event & { type: "tool_execution_resolved" } => e.type === "tool_execution_resolved" && e.executionId === executionId,
		);
		if (ev === undefined) throw new Error(`the recovery plan derived a resolution outside the scope (${executionId})`);
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

	/**
	 * The CONTINUE_MODEL housekeeping (called by the driver before the
	 * continuation): a request voided by an EARLIER marker whose expiry
	 * never landed — the pre-0.1.44 upgrade path, where the marker existed
	 * but the expiry did not — is expired here, exactly as the old requests
	 * pass did at the first resume. Returns whether anything was appended
	 * (the driver re-derives once; the plan then skips the expired
	 * request).
	 */
	async *#expireStaleVoidedRequests(scope: readonly Event[], log: EventLog): AsyncGenerator<Event, boolean> {
		let expired = false;
		for (const pending of this.#storedRequests(scope, log)) {
			const invocationSeq = invocationSeqOf(pending, scope);
			if (invocationSeq === undefined) continue;
			const voided = log.all.some(
				(e) => e.type === "model_output_abandoned" && invocationSeq > e.voidFromSeq && invocationSeq <= e.seq,
			);
			if (!voided) continue;
			if (log.all.some((e) => e.type === "permission_expired" && e.decisionId === pending.decisionId)) continue;
			yield log.append({
				type: "permission_expired",
				decisionId: pending.decisionId,
				reason: "the invocation was abandoned with an incomplete draft — never re-presented, never executed",
			});
			expired = true;
		}
		return expired;
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
