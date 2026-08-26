/**
 * L2 — the ReAct loop. The kernel's only loop; everything else is harness.
 *
 * An async generator that yields every event as it happens (never buffers a
 * turn into a list — the reference implementation's failure), and converges
 * on exactly one `terminal` event per run (ADR-0004).
 *
 * SINGLE TRUTH (Phase B): the loop holds ONE EventLog. Messages are never
 * stored alongside it — every adapter call derives them via
 * `projectMessages(log.all)` (kernel/project.ts). A fresh log encodes the
 * seed `messages` into events first, so even a one-shot call replays
 * exactly. Compaction is recorded as a `microcompacted` boundary (old
 * sessions: a `compacted` event) and re-applied by the projection, keeping
 * the replay identical to the live run.
 *
 * Per iteration:
 *   assemble (onUserMessage / onPreLlm)
 *     → adapter.stream(): events yielded straight through; every validated
 *       and policy-allowed tool call LAUNCHES its execution immediately
 *       (streaming execution) — the executions run concurrently under a window of 4
 *       (0.1.26, ADR-0024 Amd), their events queued and drained between
 *       stream events (completion order; the projection re-orders the
 *       results by call order — the byte discipline)
 *     → the turn settles: the launched executions finish (receipts land
 *       before any terminal), the ask-gated successors follow the human's
 *       verdict (the conservative order)
 *   no tool calls / maxTurns / abort / max_tokens → terminal event, return
 *
 * Retry lives HERE and only here (ADR-0005): a retryable StructuredError
 * from the adapter is retried with backoff inside the generator frame — and
 * ONLY before anything streamed (Phase B): once a text delta or tool call
 * left the adapter, a failure is an `error` terminal, never a silent
 * re-stream that duplicates output or tool calls.
 */

import { isAdapterEvent, type Adapter, type AbortSignalLike } from "../protocol/adapter.js";
import type { Continuation, ContinuationEntry, ContinuationScope, Event, StopReason, StructuredError, Terminal, ToolCallEnd } from "../protocol/events.js";
import type { ApprovalChain, ChainVerdict } from "../protocol/extension.js";
import { estimateTokens } from "./compaction.js";
import { EventLog } from "./event-log.js";
import type { EventInput } from "./event-log.js";
import type {
	AssistantBlock,
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "../protocol/messages.js";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { validateArgs } from "../tools/validate.js";
import type { HookHost, ToolCallPayload } from "./hooks.js";
import { NoOpHooks } from "./hooks.js";
import type { ModeProfile } from "./mode.js";
import { resolveModeProfile } from "./mode.js";
import { denialResult, type PermissionDecision } from "./permission.js";
import { messagesToEvents, MICROCOMPACTABLE, DO_NOT_COMPACT, projectMessages } from "./project.js";

/** Zero-dependency sleep: the kernel must not import host globals (ADR-0001). */
declare function setTimeout(cb: () => void, ms: number): unknown;

export interface LoopConfig {
	readonly adapter: Adapter;
	readonly model: string;
	readonly systemPrompt?: string;
	readonly registry: ToolRegistry;
	readonly hooks?: HookHost;
	readonly modes?: readonly ModeProfile[];
	/** Active mode name; applies visibleToolNames structurally. */
	readonly mode?: string;
	readonly maxTurns?: number;
	readonly maxRetries?: number;
	/**
	 * MG-1 (ADR-0051 Amendment 5): the run's continuation scope — the
	 * kernel stamps it onto a committed stop's envelope (adapters cannot
	 * forge scope). Absent = an unscoped run (SDK-injected or faux
	 * adapters): adapter-emitted continuation is STRIPPED at the commit.
	 */
	readonly continuationScope?: ContinuationScope;
	/** XP-1: the RESOLVED reasoning wire values — passed to the adapter
	 *  verbatim; absent = provider defaults (the byte anchor). */
	readonly reasoning?: { readonly thinking?: "adaptive" | "enabled" | "disabled"; readonly effort?: string };
	/**
	 * Seed history. When a `log` is provided, the log IS the truth and this
	 * is only used if the log is empty. See ADR-0002 / kernel/project.ts.
	 */
	readonly messages?: readonly Message[];
	/** The run's event log. Pass the session's log to make this run durable. */
	readonly log?: EventLog;
	/**
	 * DEPRECATED (ADR-0044): the classic auto-compaction path is retired —
	 * the loop no longer produces `compacted` events; the microcompact
	 * boundary (below) absorbed the responsibility. Kept so old configs
	 * type-check; IGNORED. Old sessions' `compacted` events still replay
	 * verbatim (the projection). Removed at 1.0.
	 */
	readonly compaction?: { readonly thresholdTokens: number };
	/**
	 * C area: MICROCOMPACT — when the projected context exceeds the threshold,
	 * append ONE durable `microcompacted` boundary (clearing compactable tool
	 * results older than the recent turns). The decision is a persisted fact:
	 * the projection derives the same cleared view from the same events,
	 * byte for byte, across crash/resume. Never a per-turn progressive
	 * clearing.
	 */
	readonly microcompact?: { readonly thresholdTokens: number; readonly keepResults?: number };
	readonly signal?: AbortSignalLike;
	readonly temperature?: number;
	readonly maxTokens?: number;
	/**
	 * Phase D: the channel that resolves a `defer` permission. When the
	 * onPreTool hook defers, the loop persists a `permission_requested`
	 * event, yields it, and AWAITS this promise — the same run resumes when
	 * a human decides. Absent, a defer degrades to an honest denial.
	 */
	readonly resolveApproval?: (decisionId: string) => Promise<PermissionDecision>;
	/**
	 * round 4 (adversarial): a verdict the human ALREADY gave before an abort landed.
	 * The abort path consults this BEFORE yielding the aborted terminal: a
	 * consumed verdict must be recorded (exactly once), never lost — the
	 * human's decision outranks the abort.
	 */
	readonly approvalVerdict?: (decisionId: string) => boolean | undefined;
	/**
	 * DEAD — accepted by the type, never read by this loop.
	 *
	 * It was the C group channel for the failed-receipt pause: the loop
	 * persisted `uncertain_pending` and awaited a human verdict. ADR-0038
	 * removed that pause (a complete receipt IS the outcome), and with it
	 * every read of this field — a failure is now simply recorded failed and
	 * the siblings run on. The runtime still passes both callbacks
	 * (runtime/run.ts), so supplying them is harmless and changes nothing.
	 *
	 * The crash window — started, no receipt — is the ONLY uncertainty left,
	 * and the runtime's recovery driver owns it (RESOLVE_UNCERTAIN in
	 * runtime/recovery-plan.ts), not the loop. Both fields are kept because
	 * the surface is frozen (ADR-0051); do not read them as live wiring.
	 */
	readonly resolveUncertainty?: (executionId: string) => Promise<"rerun" | "abandoned">;
	/** DEAD, as above — the uncertainty twin of `approvalVerdict`
	 *  (round 4, adversarial). Never read by the loop since ADR-0038. */
	readonly uncertaintyVerdict?: (executionId: string) => "rerun" | "abandoned" | undefined;
	/**
	 * E1: the COMPOSED approval chain — the runtime composes the
	 * extensions' policies (deny > allow > ask, the R3 ruling) into ONE
	 * decide; the kernel's gate calls it BEFORE the human flow. Allow/deny
	 * are recorded durably with decidedBy = the deciding extension, never
	 * pausing for a human; an ask falls into the human flow (its speaker
	 * names the first non-abstain — the panel's why-asked line). A
	 * throwing chain counts as ask. Absent, no chain runs. A durable
	 * decision already recorded (resume) takes effect and the chain never
	 * re-runs.
	 */
	readonly approvalPolicy?: ApprovalChain;
	/** P3: the session's id — carried to tools via ToolContext.sessionId. */
	readonly sessionId?: string;
}

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_RETRIES = 2;

export async function* loop(config: LoopConfig): AsyncGenerator<Event> {
	const log = config.log ?? new EventLog();
	const hooks: HookHost = config.hooks ?? NoOpHooks;
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
	const signal = config.signal;
	const mode = resolveModeProfile(config.modes, config.mode);
	const registry =
		mode?.visibleToolNames !== undefined
			? config.registry.subset(mode.visibleToolNames)
			: config.registry;

	// Seed: a fresh log encodes the seed history as events so the projection
	// (and any later replay) contains it. A non-empty log (session resume)
	// is never re-seeded — the log already holds everything.
	if (log.all.length === 0) {
		for (const ev of messagesToEvents(config.messages ?? [])) log.append(ev);
	}

	const derive = (): readonly Message[] => projectMessages(log.all);

	/** Yield a terminal: onStop (lifecycle) → event → onEvent (observer). */
	const terminal = async (outcome: Terminal): Promise<Event> => {
		if (hooks.onStop) await hooks.onStop(outcome.kind, {}).catch(() => {});
		const full = log.append({ type: "terminal", outcome });
		if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
		return full;
	};
	const aborted = (): boolean => signal?.aborted === true;

	// Assemble: the incoming user message may be rewritten or vetoed.
	// C group: the outcome is PERSISTED as a user_input_replaced event — the
	// projection renders the final replacement AT THE INPUT'S POSITION (or
	// nothing, for a true veto), so the rewritten fact is the ONLY fact
	// every later turn of the run sees.
	let messages = derive();
	let vetoed = false;
	if (hooks.onUserMessage && messages.length > 0) {
		const last = messages.at(-1);
		if (last?.role === "user") {
			const inputEvent = [...log.all].reverse().find((e): e is Event & { type: "user_input" } => e.type === "user_input");
			// round 6: the hook runs AT MOST ONCE per input. A replacement that
			// ALREADY exists (persisted before a crash, or before a resume)
			// means the hook already spoke for this input — it must never
			// run again, and the run continues from the durable fact.
			const replacement = log.all.find(
				(e): e is Event & { type: "user_input_replaced" } =>
					e.type === "user_input_replaced" && e.replaces === inputEvent?.seq,
			);
			if (replacement !== undefined) {
				// round 6/round 5 (P1-7): the hook ALREADY spoke for this input — a
				// durable null content is a TRUE veto: restore the vetoed
				// flag so the provider is NEVER called, even when earlier
				// history exists (previously only an empty history happened
				// to stop).
				if (replacement.content === null) vetoed = true;
			}
			if (replacement === undefined && inputEvent) {
				const rewritten = await hooks.onUserMessage(last, {});
				// round 1: the rewrite/veto is a NORMAL stream event — persisted by
				// the harness and visible to consumers, never a hidden append.
				const replaced = log.append({
					type: "user_input_replaced",
					replaces: inputEvent.seq,
					content: rewritten?.content ?? null,
					...(rewritten !== null && rewritten.source !== undefined ? { source: rewritten.source } : {}),
				});
				messages = derive();
				yield replaced;
				if (rewritten === null) vetoed = true; // round 3: a true veto ends the run
			}
		}
	}
	// round 3: a true veto ends the run — the provider is NEVER called, even
	// when earlier history exists.
	if (vetoed || messages.length === 0) {
		yield await terminal({ kind: "completed" });
		return;
	}

	// 0.1.26 (ADR-0024 Amd — the trigger condition is met: a real workload
	// showed the sequential ledger is the bottleneck): the windowed parallel
	// batching returns, this time with the ledger events emitted per call in
	// deterministic order. The model stream and the tool executions run
	// CONCURRENTLY (streaming execution): a tool_call_end validated and allowed by the
	// policy chain launches its execution immediately; the events land
	// through a queue the stream loop drains on every stream event — their
	// seq order is the COMPLETION order (started/receipt/result land when
	// each execution finishes; seq stays monotonic by construction). The
	// byte discipline is preserved by the projection, which re-orders the
	// turn's results by CALL order (project.ts flushResults) — the
	// completion order only affects the landing moment, never the derived
	// messages. The window caps concurrent executions; the ask gate holds
	// an ask AND the calls after it until the human decides (the conservative order — the
	// context may have changed when the human approves); the STARTED event
	// is acked by the drain so the handler never runs before its receipt is
	// persisted (write-ahead preserved). A voided turn (forged event,
	// post-stop violation, a non-compatible stop reason) fires the violated
	// signal: started executions finish and their receipts land (already-started executions still land their
	// receipt), not-started ones bail without a started event (abort semantics —
	// clean, never uncertain).
	const WINDOW_SIZE = 4;
	// The execution event queue. The drain (below) appends + yields each
	// queued event; the ack of the STARTED event gates the handler (the
	// write-ahead: the receipt is persisted before the side effect).
	const execQueue: { ev: EventInput; ack: (executionId?: string) => void }[] = [];
	const pushExec = (ev: EventInput, ack?: (executionId?: string) => void): void => {
		execQueue.push({ ev, ack: ack ?? (() => {}) });
	};
	const drainExec = async function* (): AsyncGenerator<Event> {
		while (execQueue.length > 0) {
			const { ev, ack } = execQueue.shift()!;
			// The STARTED event's executionId is allocated HERE, atomically
			// with the append: `ex-<seq>` — the id equals the event's seq, so
			// the SAME logical execution derives the SAME id on a replay or a
			// resume (the execution-identity contract). Under the parallel
			// execution a pre-append prediction raced; the drain is the only
			// place the next seq is known without a gap. The ack carries the
			// id back to the launch (the receipts reference it).
			const full =
				ev.type === "tool_execution_started"
					? log.append({ ...ev, executionId: `ex-${log.lastSeq + 1}` })
					: log.append(ev);
			if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
			yield full;
			ack(full.type === "tool_execution_started" ? full.executionId : undefined);
		}
	};
	// The window: at most WINDOW_SIZE executions run concurrently.
	let freeSlots = WINDOW_SIZE;
	const windowWaiters: (() => void)[] = [];
	const acquireWindow = (): Promise<void> => {
		if (freeSlots > 0) {
			freeSlots -= 1;
			return Promise.resolve();
		}
		return new Promise<void>((res) => {
			windowWaiters.push(res);
		});
	};
	const releaseWindow = (): void => {
		const w = windowWaiters.shift();
		if (w !== undefined) w();
		else freeSlots += 1;
	};
	// The turn's launches: one async task per tool_call_end, in call order.
	const launches: Promise<void>[] = [];
	let execActive = 0;
	// A launch failure (a throwing onPostTool, a real error) fails the RUN —
	// the launch records it and the loop re-throws it after the settle
	// (same propagation the sequential execute had).
	let launchError: unknown = null;
	/** Drain until every launch settles: the receipts land (the write-ahead
	 *  acks resolve during the pump); the 10ms poll covers mid-handler gaps
	 *  and the ask pause — never a busy spin, never a deadlock on an ack.
	 *  One settle semantics, two callers: the turn settle and F4's abandon. */
	const drainSettled = async function* (): AsyncGenerator<Event> {
		while (execActive > 0) {
			yield* drainExec();
			await sleep(10);
		}
		yield* drainExec();
	};
	let violated = false;
	// The violated signal: rejects when the turn is voided — the paused
	// ask-branches bail (abort semantics for not-started executions). Typed
	// `never` so the ask race resolves to the human decision alone.
	// F4: PER-ATTEMPT state now — a mid-stream retry voids one attempt and
	// continues, so the signal re-arms after each abandon (pre-F4 a void
	// always ended the run and one signal per run sufficed).
	let violatedReject: () => void = () => {};
	let violatedP!: Promise<never>;
	const armVoidSignal = (): void => {
		violated = false;
		violatedP = new Promise<never>((_, reject) => {
			violatedReject = () => reject();
		});
		// The turn's ask-branches race it; a turn with NO ask leaves the
		// rejection un-consumed — the no-op keeps it from surfacing as an
		// unhandled rejection while the race consumers still receive it.
		void violatedP.catch(() => {});
	};
	armVoidSignal();
	// ── EC-1 ① — the DURABLE TURN COMMIT gate ──────────────────────────────
	// Invariant 3 (COMMIT GATING): a commit-required handler never starts
	// before this turn's stop is DURABLE. The gate RESOLVES exactly once per
	// turn — at the commit, or at the void — and the waiter then reads
	// `committed`. It deliberately does not reuse `violatedP`: that one
	// REJECTS, and a rejection awaited here would be caught by the launch's
	// catch and recorded as a launchError, failing the whole run for what is
	// an ordinary void. A gate that resolves keeps the void path quiet.
	// Both are reset per turn (below): turn N+1's calls wait for turn N+1's
	// commit. Safe because the settle drains every launch before the turn
	// advances, so no launch ever waits on a stale gate.
	let committed = false;
	let settleTurn: () => void = () => {};
	let turnSettled: Promise<void> = new Promise<void>((res) => {
		settleTurn = res;
	});
	// The ask gate: an ask's human resolution blocks the calls after it.
	// The DECIDE chain serializes the decisions in CALL order, so the gate
	// an ask installs is structurally in place before the successors decide.
	// EC-1 ③: it must be installed THERE and not at the ask itself, even
	// though the ask now happens later (post-commit): the gate is what a
	// precommit-eligible sibling consults to know an ask was accepted ahead
	// of it, and that has to be knowable BEFORE the commit. Each call
	// captures the gate ahead of it and its own release (below) — one shared
	// `askRelease` used to mean the first ask's resolution opened the SECOND
	// ask's gate.
	let askGate: Promise<void> = Promise.resolve();
	// The decision chain: each launch's decide is chained onto the previous
	// one's — the decides run in CALL order and the chain resolves to the
	// call's verdict.
	let decideChain: Promise<ExecVerdict> = Promise.resolve({ action: "allow" });
	// The decisionId allocator: monotonic per log (seeded past the existing
	// log), unique under the parallel decides — the ids are correlation
	// keys (the executionId comes from the drain, seq-stable).
	let idSeq = log.all.length + 1;
	const nextDecisionId = (): string => `d-${idSeq++}`;
	// ── EC-1 ② / ③ — the FIFO EXCLUSIVE BARRIER ────────────────────────────
	// Absence is the conservative truth: a tool that declares nothing is
	// EXCLUSIVE, and the kernel serializes it. `concurrency: "shared"` is the
	// only way to overlap, and it is a per-TOOL certificate the kernel
	// enforces — never a per-call claim it could not police.
	//
	// The fence is installed at ACCEPTANCE (in `launch`, i.e. CALL order),
	// not when a handler starts: that is what makes it FIFO. A later sibling
	// — including a precommit-safe read — never overtakes an exclusive
	// invocation accepted before it, so a read can never observe a
	// half-written file. A read after a write therefore loses its latency
	// win; safe overtaking and snapshot semantics stay future work.
	let fence: Promise<void> = Promise.resolve();
	const sharedRunning: Promise<void>[] = [];
	/** Reserve this call's place in the FIFO: what it must await before
	 *  running, and the release to call once its handler is done. */
	const reserve = (tool: Tool | undefined): { wait: Promise<void>; release: () => void } => {
		const shared = tool?.effects?.concurrency === "shared";
		let release!: () => void;
		const done = new Promise<void>((res) => {
			release = res;
		});
		// An exclusive invocation waits for the fence AND every shared call
		// already accepted ahead of it — while it runs, it runs alone.
		const wait = shared ? fence : Promise.all([fence, ...sharedRunning]).then(() => undefined);
		if (shared) sharedRunning.push(done);
		else {
			fence = done;
			sharedRunning.length = 0;
		}
		return { wait, release };
	};
	const launch = (call: ToolCallEnd): void => {
		execActive += 1;
		const tool = registry.get(call.name);
		const slot = reserve(tool);
		// EC-1 ③ — this call's place in the ASK order, filled in by the
		// decide chain (call order). `ahead` is the gate of an ask ACCEPTED
		// BEFORE this call; `release` opens this call's own gate for its
		// successors and stays a no-op unless this call asks. Per-call, so
		// two asks in one turn queue honestly instead of sharing one release.
		const askOrder: { ahead: Promise<void>; release: () => void } = { ahead: Promise.resolve(), release: () => {} };
		launches.push(
			(async () => {
				try {
					decideChain = decideChain.then(async () => {
						const v = await decideCall(
							call,
							registry,
							hooks,
							{ signal: signal ?? NEVER_ABORT, ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}) },
							log,
							config.resolveApproval,
							config.approvalVerdict,
							signal,
							config.approvalPolicy,
							nextDecisionId,
							pushExec,
						);
						askOrder.ahead = askGate;
						if (v.action === "ask") {
							askGate = new Promise<void>((res) => {
								askOrder.release = res;
							});
						}
						return v;
					});
					const verdict = await decideChain;
					if (violated) return; // the turn was voided before this call started
					if (verdict.action === "deny") {
						pushExec(verdict.result);
						return;
					}
					// the conservative order: the calls AFTER an ask wait for its
					// human resolution. The context may have changed when the
					// human approves — which is why even a precommit-safe read
					// accepted after an ask waits here rather than racing ahead.
					await askOrder.ahead;
					if (violated) return;
					if (verdict.action === "ask") {
						try {
							// EC-1 ③ — THE POST-COMMIT ASK. A human must never
							// be asked to approve a call whose turn then proves
							// invalid, so the pause waits for this turn's OWN
							// commit exactly like a handler does. On an
							// uncommitted turn the call bails here having asked
							// NOTHING and started nothing. (Before EC-1 the
							// question was put to a person mid-stream, and a
							// provider that violated the protocol after its stop
							// made that person's "yes" authorize a turn the
							// kernel then voided.)
							await turnSettled;
							if (!committed) return;
							// The human pause — abortable by a user abort OR a
							// turn void (the violated promise). Post-commit a
							// void can no longer reach this branch; the race
							// stays as the cheap structural guarantee that it
							// never could.
							const decision = await Promise.race([
								humanPause(call, verdict.decisionId, hooks, log, config.resolveApproval, config.approvalVerdict, signal, pushExec, verdict.speaker),
								violatedP,
							]);
							if (violated) return;
							if (decision.action !== "allow") {
								// the reason rides the denial — the human's words,
								// or the honest "no approval flow configured".
								pushExec(resultEvent(call, denialResult(decision.reason ?? "denied")));
								return;
							}
						} finally {
							// The gate opens the moment the human's part is over
							// — whatever the outcome, and on every bail path:
							// successors wait for the VERDICT, never for this
							// call's handler, and a turn that voids before the
							// ask must not strand them.
							askOrder.release();
						}
					} else if (tool?.effects?.precommitSafe !== true) {
						// EC-1 ① (invariant 3, COMMIT GATING): the handler waits
						// for this turn's OWN commit. An uncommitted turn never
						// reaches a handler — the call bails here having emitted
						// NO started event, so it is clean, never uncertain
						// (abort semantics). This is the whole of "an invalid
						// turn never starts a commit-required tool handler".
						//
						// EC-1 ③(b) — THE PRECOMMIT LAUNCH RULE is the `else`
						// this branch is guarded by: a call skips the commit
						// gate iff its tool declares `precommitSafe` AND its
						// authorization is ALREADY satisfied — an `allow`
						// verdict, no human in the loop. Both halves are
						// necessary: the certificate says the EXECUTION is
						// harmless (read-only, free, local, universally), never
						// that the authorization is unnecessary. Such a call may
						// run on a turn that later voids; invariant 7 owns that
						// outcome — the receipt is an honest fact and the turn
						// stays uncommitted.
						await turnSettled;
						if (!committed) return;
					}
					// EC-1 ③ (invariants 5 + 6): wait behind the FIFO barrier,
					// and only THEN take a window slot. Waiting — for the
					// commit, for a human, or for the barrier — consumes no
					// slot: the window is an EXECUTION window, not a
					// pending-invocation window, so four held writes can never
					// starve a runnable sibling.
					await slot.wait;
					if (violated) return;
					await acquireWindow();
					try {
						await runLedgered(
							call,
							registry,
							hooks,
							{ signal: signal ?? NEVER_ABORT, ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}) },
							signal,
							pushExec,
						);
					} finally {
						releaseWindow();
					}
				} catch (err) {
					// The abort sentinel (a user cancel during the decide or
					// the pause) is swallowed — the loop's aborted() check
					// ends the run honestly; anything else is recorded and
					// re-thrown after the settle (the consumer sees it).
					if (err !== ABORTED) launchError ??= err;
				} finally {
					// The barrier and the ask gate are released on EVERY exit —
					// a denial, an uncommitted turn, an abort — or the siblings
					// queued behind this call would wait forever. (Releasing an
					// already-open gate is a no-op: a promise resolves once.)
					askOrder.release();
					slot.release();
					execActive -= 1;
				}
			})(),
		);
	};

	let turns = 0;
	while (true) {
		if (aborted()) {
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}
		if (turns >= maxTurns) {
			yield await terminal({ kind: "max_turns", turns });
			return;
		}
		turns += 1;

		// ── C area: one-shot microcompact boundary when over the threshold ──
		if (config.microcompact !== undefined && estimateTokens(messages) > config.microcompact.thresholdTokens) {
			const beforeSeq = microcompactBoundarySeq(log.all, config.microcompact.keepResults ?? KEEP_COMPACTABLE_RESULTS);
			if (beforeSeq !== undefined) {
				const full = log.append({ type: "microcompacted", beforeSeq });
				if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
				yield full;
				messages = derive();
			}
		}

		if (hooks.onPreLlm) await hooks.onPreLlm({ model: config.model, turns }, {});
		if (aborted()) {
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}

		// ── Model turn: stream events through, collect tool calls ──────────
		const pending: ToolCallEnd[] = [];
		let lastStop: StopReason | undefined;
		let stopCount = 0;
		let streamed = false;
		let attempts = 0;
		// round 5: the turn is a strict protocol — once the provider stops, ANY
		// further event (delta, tool call, usage, thinking) is a violation.
		let sawStop = false;
		let postStopViolation = false;
		// round 5: the adapter may only produce its OWN event kinds — a
		// kernel-owned event (terminal, tool_execution_*, permission_*,
		// user_input, …) from the stream is a FORGERY and must never reach
		// the log.
		let forgedEvent = false;
		// EC-1 ①: a SECOND stop voids the turn — and unlike the pre-EC-1 path
		// (which appended both, leaving two stops in the log forever), NEITHER
		// stop is persisted now. A deliberate improvement of that class.
		let duplicateStop = false;
		// EC-1 ①: the turn's stop, HELD in memory until the stream proves
		// clean. It is neither appended NOR yielded here — yield order must
		// equal append order (persistence-ownership.test.ts), so the hold
		// covers both, and the commit below performs both together.
		let heldStop: EventInput | null = null;
		// EC-1 ⑤ (the live void): the last durable event BEFORE this turn's
		// model output — the previous turn's stop, the user input, or a
		// microcompact boundary. Everything after it is this turn's draft,
		// which is exactly the range a void must abandon. F4: `let` — a
		// mid-stream retry moves the boundary to its abandonment marker.
		let turnStart = log.lastSeq;
		// EC-1 ①: this turn's commit gate — reset BEFORE any call can launch.
		committed = false;
		turnSettled = new Promise<void>((res) => {
			settleTurn = res;
		});
		// F4b: the ONE abandon sequence, for EVERY uncommitted exit — the
		// mid-stream error (retryable or not), the user abort, and the
		// voided turn. Settle (parked launches bail on the un-committed
		// gate), drain (started executions land their receipts), then
		// durably void the draft. The defensive check stands: a started
		// commit-required execution in the draft (impossible under
		// invariant 3) suppresses the marker — no void over a started
		// fact, the pre-F4 abandon exactly.
		const unsafeStartedInDraft = (): boolean =>
			log.all.some((e) => e.type === "tool_execution_started" && e.seq > turnStart && registry.get(e.name)?.effects?.precommitSafe !== true);
		const abandonDraft = async function* (reason: string): AsyncGenerator<Event> {
			settleTurn();
			violated = true;
			violatedReject();
			yield* drainSettled();
			if (launchError !== null) throw launchError;
			if (log.lastSeq > turnStart && !unsafeStartedInDraft()) {
				const marker = log.append({ type: "model_output_abandoned", voidFromSeq: turnStart, reason });
				if (hooks.onEvent) await hooks.onEvent(marker, {}).catch(() => {});
				yield marker;
			}
		};

		while (true) {
			// Area 4: the backoff is abortable — a cancel landing during a
			// retry wait ends the run now, not after the backoff.
			if (aborted()) {
				yield await terminal({ kind: "aborted", by: "user" });
				return;
			}
			try {
				const stream = config.adapter.stream({
					model: config.model,
					messages,
					...(config.reasoning !== undefined ? { reasoning: config.reasoning } : {}),
					...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
					tools: registry.toSpecs(),
					...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
					...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
					...(signal !== undefined ? { signal } : {}),
				});
				for await (const ev of stream) {
					streamed = true;
					// 0.1.26: the launched executions' events land first —
					// the completion order; the projection re-orders the
					// results by call order (the byte discipline).
					for await (const q of drainExec()) yield q;
					// round 5: the trust gate — a kernel-owned event from the
					// adapter is a forgery: it is never appended (never
					// persisted), and the turn ends with a unique
					// invalid_request terminal below.
					if (!isAdapterEvent(ev)) {
						forgedEvent = true;
						violated = true;
						violatedReject();
						break;
					}
					// round 5: a delta/tool call/usage arriving AFTER the provider's
					// stop is a protocol error — the violating event is never
					// appended, and the turn ends with an error terminal (the
					// pending tools must NOT execute).
					if (sawStop && ev.type !== "stop") {
						postStopViolation = true;
						violated = true;
						violatedReject();
						break;
					}
					if (ev.type === "stop") {
						// EC-1 ① — DURABLE TURN COMMIT. The stop is HELD, not
						// persisted: before EC-1 it was appended the instant it
						// arrived, so a stop could be durable while the stream
						// was still running — and the recovery keyed "this turn
						// committed" on exactly that durable stop. The two
						// truths are now one: a durable compatible stop means
						// THIS producer observed clean stream exhaustion.
						if (sawStop) {
							duplicateStop = true;
							violated = true;
							violatedReject();
							break;
						}
						sawStop = true;
						lastStop = ev.reason;
						stopCount += 1;
						heldStop = ev;
						continue;
					}
					// R-E 0.1.43: the append precedes the launch — the call's
					// framework seq is assigned here; invocationSeq must never
					// be the adapter's stream-local hint (ADR-0002).
					const full = log.append(ev);
					if (full.type === "tool_call_end") {
						pending.push(full);
						// streaming execution: the call launches immediately — the decide
						// and the ledgered run proceed in parallel with the
						// model stream.
						launch(full);
					}
					if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
					yield full;
				}
				break;
			} catch (err) {
				// Area 4: a user cancel surfaced by the SDK (APIUserAbortError
				// or any error while the signal is set) is an honest `aborted`
				// terminal, never a generic error. F4b: the aborted draft is
				// voided LIVE — pre-F4b only a resume voided it, so the same
				// durable prefix projected differently depending on whether
				// the process crashed first.
				if (aborted()) {
					yield* abandonDraft("the run was aborted before this turn committed");
					yield await terminal({ kind: "aborted", by: "user" });
					return;
				}
				const structured = toStructuredError(err);
				// Phase B: never SILENTLY re-stream a turn that already emitted
				// content — duplicates are worse than failures. Nothing streamed
				// yet: the cheap in-place retry (no draft exists to void).
				if (structured.retryable && !streamed && attempts < maxRetries) {
					attempts += 1;
					await sleep(attempts * 250, signal); // abortable backoff
					continue;
				}
				// F4 — ABANDON HYGIENE, every streamed exit: settle, drain,
				// durably void (the loop's third `model_output_abandoned`
				// producer; text-only drafts included), and only THEN a retry
				// or the terminal. Pre-F4 this path returned with the draft
				// un-voided under the terminal — the next request projected it
				// as committed history (ADR-0047 Gap B, live), and a dangling
				// tool_call_end fed the provider-400 class (EC1-F1).
				yield* abandonDraft("the provider stream failed before this turn committed");
				// F4 — the mid-stream retry: same classification, same per-turn
				// budget (ADR-0005 Amendment 1: frame state, per-process).
				if (structured.retryable && attempts < maxRetries && !unsafeStartedInDraft()) {
					attempts += 1;
					await sleep(attempts * 250, signal); // the same abortable backoff
					// Fresh per-attempt state — the marker is the boundary now.
					pending.length = 0;
					lastStop = undefined;
					stopCount = 0;
					sawStop = false;
					postStopViolation = false;
					forgedEvent = false;
					duplicateStop = false;
					heldStop = null;
					streamed = false;
					committed = false;
					turnSettled = new Promise<void>((res) => {
						settleTurn = res;
					});
					armVoidSignal();
					turnStart = log.lastSeq;
					continue;
				}
				yield await terminal({ kind: "error", error: structured });
				return;
			}
		}

		// ── The voided-terminal computation (round 5 / C group) ────────────────────
		// A forged kernel-owned event, a post-stop event, or a
		// non-compatible stop reason voids the turn: the launched
		// executions still finish and their receipts land (already-started executions still land their
		// receipt — the side effects happened), the not-started bail
		// (abort semantics), then the terminal.
		let voided: Terminal | null = null;
		if (forgedEvent) {
			voided = {
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: "provider emitted a kernel-owned event" },
			};
		} else if (postStopViolation) {
			voided = {
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: "provider emitted events after its stop event" },
			};
		} else if (duplicateStop) {
			// EC-1 ①: a second stop. The pre-EC-1 path appended BOTH and voided
			// afterwards, so a duplicate-stop turn left two stops in the log
			// forever; now neither is durable — the turn simply never commits.
			voided = {
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: `provider emitted ${stopCount + 1} stop events in one turn` },
			};
		} else if (stopCount === 0) {
			// Area 6: protocol anomalies are STRUCTURED ERRORS, never a default
			// `completed`. EC-1 ①: ONE arm now, not two — the pre-EC-1 code
			// duplicated this verdict across the pending/no-pending split, where
			// it never differed.
			voided = {
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: "provider stream ended without a stop event" },
			};
		} else if (pending.length > 0) {
			// C group: STRUCTURAL COMPATIBILITY — a stop reason that cannot
			// carry tool calls voids the turn. EC-1 ①: this is now the second
			// half of the commit condition and runs BEFORE the commit, so an
			// incompatible turn never persists its stop; combined with the
			// commit gate its calls never became effects either (pre-EC-1 they
			// had already launched, and the void could only let their receipts
			// land after the fact).
			switch (lastStop) {
				case "tool_use":
				case "function_call":
					break; // compatible with complete calls — the executions proceed
				case "max_tokens":
					voided = { kind: "max_tokens" };
					break;
				case "abort":
					voided = { kind: "aborted", by: "user" };
					break;
				case "error":
					voided = {
						kind: "error",
						error: { code: "unknown", retryable: false, message: "provider stopped with an error" },
					};
					break;
				default:
					voided = {
						kind: "error",
						error: {
							code: "invalid_request",
							retryable: false,
							message: `provider stopped with '${String(lastStop)}' with ${pending.length} tool call(s) launched`,
						},
					};
					break;
			}
		}

		// ── MG-1 (A5): the trust boundary's half of the envelope ─────────
		// Stamp, strip, cap — BEFORE the commit decision, so a hard-cap
		// violation voids the turn (no durable stop persists that is known
		// unable to continue correctly; the F4b abandon voids its draft).
		if (voided === null && heldStop !== null && (heldStop as { continuation?: Continuation }).continuation !== undefined) {
			const prepared = prepareContinuation(heldStop as EventInput & { continuation?: Continuation }, config.continuationScope);
			if (prepared === "hard-cap") {
				voided = {
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: "the turn's required continuation metadata exceeds the hard cap" },
				};
			} else {
				heldStop = prepared;
			}
		}

		// ── EC-1 ① — TURN COMMIT ──────────────────────────────────────────
		// The held stop is persisted HERE and only here: iterator done (the
		// stream loop broke cleanly) AND structurally compatible (above). The
		// append and the yield happen together, in the loop's ordinary order,
		// so the durable log gains no event and loses none — only the MOMENT
		// moves, and the projection is byte-identical. What it buys:
		//
		//   a durable compatible stop ⇔ this producer observed clean stream
		//   exhaustion.
		//
		// The gate is released either way: a committed turn frees its
		// handlers, a voided turn frees them to bail with no started event.
		// An abort with calls in flight abandons the turn BEFORE it commits:
		// the aborted turn leaves NO durable stop, so its calls stay an
		// UNCOMMITTED DRAFT the resume voids (⑤) rather than a committed batch
		// no one will ever execute — which would strand the model's tool_use
		// blocks with no results (the EC1-F1 dangling-pair class). A turn with
		// NO calls has nothing to abandon and still ends on its own stop
		// reason, the pre-EC-1 order.
		if (voided === null && pending.length > 0 && aborted()) {
			// F4b: the abandoned calls are voided LIVE — the resume derives
			// the same void from the same prefix, so live and post-crash
			// projections agree, and no dangling tool_use reaches the next
			// request in either world.
			yield* abandonDraft("the run was aborted before this turn committed");
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}
		if (voided === null && heldStop !== null) {
			const full = log.append(heldStop);
			if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
			committed = true;
			yield full;
		}
		settleTurn();

		// A turn with no tool calls ends on its OWN stop reason (Phase B,
		// Area 6) — never a blanket `completed`. Reached only once committed.
		if (voided === null && pending.length === 0) {
			yield await terminal(terminalForStop(lastStop));
			return;
		}

		// ── The turn settles: a void fires the violated signal — the
		//    not-started executions bail (abort semantics — no started, no
		//    receipt, never uncertain); the started ones finish and their
		//    receipts land BEFORE the terminal or the next turn (already-started executions still land their
		//    receipt). The drain yields every queued event; the STARTED
		//    ack resolves as the consumer persists (write-ahead), so the
		//    launches advance DURING the drain — a 10ms settle poll covers
		//    the in-between gaps (mid-handler launches, the ask pause:
		//    never a busy spin, never a deadlock on a pending ack).
		if (voided !== null) {
			// EC-1 ⑤ — THE LIVE VOID, F4b: the shared abandon sequence. ①
			// means a voided turn's commit-required call never ran, so nothing
			// answers the `tool_use` its tool_call_end already persisted; the
			// run ends on its terminal and the recovery driver never sees it
			// (its first rule is "the open run reached its terminal") — the
			// provider-400 class, live rather than after a crash. The marker
			// is the instrument the resume already uses, produced here (an
			// existing variant — no new protocol surface). F4b broadened the
			// condition from dangling-calls-only to ANY draft: a text-only
			// voided draft glued onto the next request exactly the way the
			// mid-stream cut's did. A started commit-required call (a FACT)
			// still suppresses the marker — abandonDraft's standing check,
			// the same rule as recovery-plan.ts's `unexecuted`. Idempotent by
			// construction: the marker becomes the last boundary, so no later
			// resume derives a second draft over the same range.
			yield* abandonDraft("the turn was voided before it committed");
			yield await terminal(voided);
			return;
		}
		yield* drainSettled();
		if (launchError !== null) throw launchError;

		// ── Advance history: the log grew; re-derive for the next turn ─────
		messages = derive();
	}
}

/**
 * The terminal for a turn that stopped without tool calls — mapped from the
 * provider's OWN stop reason, never blanket `completed` (Phase B, Area 6).
 * `refusal`, `pause_turn`, `content_filter`, `context_window`, and a
 * tool_use/function_call that produced no complete call are all explicit
 * non-completions.
 */
function terminalForStop(reason: StopReason | undefined): Terminal {
	switch (reason) {
		case "max_tokens":
			return { kind: "max_tokens" };
		case "abort":
			return { kind: "aborted", by: "user" };
		case "error":
			return { kind: "error", error: { code: "unknown", retryable: false, message: "provider stopped with an error" } };
		case "refusal":
			return { kind: "error", error: { code: "invalid_request", retryable: false, message: "the model refused the request" } };
		case "pause_turn":
			return { kind: "error", error: { code: "unknown", retryable: false, message: "the provider paused the turn (pause_turn)" } };
		case "content_filter":
			return { kind: "error", error: { code: "invalid_request", retryable: false, message: "the provider's content filter triggered" } };
		case "context_window":
			return {
				kind: "error",
				error: { code: "context_overflow", retryable: false, message: "the model's context window was exceeded" },
			};
		case "tool_use":
		case "function_call":
			return {
				kind: "error",
				error: {
					code: "invalid_request",
					retryable: false,
					message: "provider stopped with a tool call that was never completed",
				},
			};
		case "end_turn":
		case "stop_sequence":
			return { kind: "completed" };
		default:
			// D3: an unknown stop reason is an error, never completed.
			return {
				kind: "error",
				error: { code: "unknown", retryable: false, message: `unrecognized stop reason: ${String(reason)}` },
			};
	}
}

// ── Execution ──────────────────────────────────────────────────────────

/** The verdict of ONE call's front — validation + the policy chain. An
 *  ask carries the decisionId the human pause will bind to, and the
 *  speaker (W21: the first non-abstain extension's name — the panel's
 *  why-asked line; a static-hook ask has none). */
type ExecVerdict =
	| { action: "deny"; result: EventInput }
	| { action: "ask"; decisionId: string; speaker?: string }
	| { action: "allow" };

/** The tool_result event for a call — the shared shape (executionId rides
 *  it as the durable correlation, round 5; invocationSeq = the framework
 *  identity, R-E 0.1.43). */
function resultEvent(call: ToolCallEnd, result: ToolResult, executionId?: string): EventInput {
	return {
		type: "tool_result",
		callId: call.callId,
		invocationSeq: call.seq,
		content: result.content,
		isError: result.isError,
		// P1-9: errorKind only exists on errors (the type now enforces it;
		// the runtime guard keeps a JS tool's illegal combination out of
		// the persisted event too).
		...(result.isError && result.errorKind ? { errorKind: result.errorKind } : {}),
		// round 5: a live tool's tags are preserved losslessly (do-not-compact,
		// billing receipts, trace anchors) — never dropped at the loop.
		...(result.tags !== undefined ? { tags: result.tags } : {}),
		...(executionId !== undefined ? { executionId } : {}),
	};
}

/**
 * 0.1.26: the front of ONE call's execution — unknown tool / unparseable
 * args / schema validation, the durable-policy check, the E1 extension
 * policy chain, and onPreTool → a verdict. The policy allow/deny facts are
 * pushed (durable, decidedBy = the speaking extension — never a human
 * pause). An ask verdict carries the decisionId for the human pause; the
 * caller runs it (conservative ordering: the calls after an ask wait for
 * its resolution).
 */
async function decideCall(
	call: ToolCallEnd,
	registry: ToolRegistry,
	hooks: HookHost,
	ctx: ToolContext,
	log: EventLog,
	resolveApproval: ((decisionId: string) => Promise<PermissionDecision>) | undefined,
	resolveApprovalVerdict: ((decisionId: string) => boolean | undefined) | undefined,
	signal: AbortSignalLike | undefined,
	approvalPolicy: ApprovalChain | undefined,
	nextDecisionId: () => string,
	push: (ev: EventInput) => void,
): Promise<ExecVerdict> {
	const payload: ToolCallPayload = {
		callId: call.callId,
		name: call.name,
		input: call.input ?? {},
	};

	// Unknown tool or unparseable args — refuse before anything runs.
	const tool: Tool | undefined = registry.get(call.name);
	if (!tool) {
		return { action: "deny", result: resultEvent(call, { content: `Unknown tool: ${call.name}`, isError: true, errorKind: "invalid_input" }) };
	}
	if (call.input === null) {
		return { action: "deny", result: resultEvent(call, { content: "Arguments failed to parse as JSON", isError: true, errorKind: "invalid_input" }) };
	}

	// Phase B: real JSON Schema validation — the handler never sees garbage.
	const schemaError = validateArgs(tool.parameters, call.input);
	if (schemaError !== null) {
		return { action: "deny", result: resultEvent(call, { content: `Arguments failed schema validation:${schemaError}`, isError: true, errorKind: "invalid_input" }) };
	}

	// Area 3: NO (name, input) dedup — a new logical call with identical
	// parameters is a new execution and runs normally. Exactly-once is
	// enforced by the receipt repair (Area 2) and the human decisions on
	// uncertain executions, not by swallowing repeats.

	// Area 4 hardening (review finding 5): an abort that landed while a
	// slow permission hook was answering must not let the tool run after
	// all. Checked again here, after any permission path.
	if (signal?.aborted) throw ABORTED;

	// ── E1: the composed approval chain, decided BEFORE the human flow ────
	// A durable POLICY decision for THIS call takes effect on resume — the
	// chain never re-runs when its verdict is already in the log (isomorphic
	// alreadyReplaced: the persisted fact speaks for the call). The match is
	// the same logical call: same callId, decidedBy set (a policy verdict,
	// never a human's), and input identical to the original tool_call_end —
	// a re-issued call with different arguments is a NEW call and re-decided.
	// The chain itself is COMPOSED by the runtime (composeApprovalChain —
	// the R3 ruling: deny > allow > ask, any deny wins, a LATER allow beats
	// an EARLIER ask, an all-abstain asks per ADR-0042); the kernel consumes
	// its verdict. A throwing chain counts as ask. Allow/deny are recorded
	// durably with decidedBy = the deciding extension, never pausing for a
	// human.
	const originalCall = [...log.all].reverse().find(
		(e): e is Event & { type: "tool_call_end" } => e.type === "tool_call_end" && e.callId === call.callId,
	);
	const durable =
		originalCall !== undefined && JSON.stringify(originalCall.input) === JSON.stringify(call.input)
			? log.all.find(
					(e): e is Event & { type: "permission_decided" } =>
						e.type === "permission_decided" && e.decidedBy !== undefined && e.callId === call.callId,
				)
			: undefined;
	let chainVerdict: ChainVerdict | undefined;
	if (durable === undefined && approvalPolicy !== undefined) {
		try {
			chainVerdict = await raceAbort(Promise.resolve(approvalPolicy.decide(payload, ctx)), signal);
		} catch {
			chainVerdict = { action: "ask" }; // a throwing chain counts as ask — it speaks, never silently
		}
		if (chainVerdict.action !== "ask") {
			// allow/deny are PERSISTED FACTS (decidedBy = a SPEAKING
			// extension — never the chain head on behalf of a non-speaker)
			// — never a human pause.
			push({
				type: "permission_decided",
				decisionId: nextDecisionId(),
				callId: call.callId,
				invocationSeq: call.seq,
				decision: chainVerdict.action === "allow" ? "approved" : "denied",
				...(chainVerdict.action === "deny" && chainVerdict.reason !== undefined
					? { reason: chainVerdict.reason }
					: {}),
				decidedBy: chainVerdict.decidedBy,
			});
		}
	}
	if (chainVerdict?.action === "deny") {
		return { action: "deny", result: resultEvent(call, denialResult(chainVerdict.reason ?? "denied")) };
	}
	if (durable !== undefined && durable.decision === "denied") {
		return { action: "deny", result: resultEvent(call, denialResult(durable.reason ?? "denied")) };
	}
	if (chainVerdict?.action === "ask") {
		// ruling A (the E1 ask semantics fix): an ask means "a HUMAN must decide" — it
		// routes DIRECTLY to the human approval pause, never through
		// onPreTool: a static automated policy (e.g. the CLI's default deny
		// for unknown tools) must not answer for the human. No approval
		// channel configured → an honest denial (judged by resolveApproval,
		// not by the hook's presence).
		if (resolveApproval === undefined) {
			return { action: "deny", result: resultEvent(call, denialResult("a policy asked for a human decision, but no approval flow is configured")) };
		}
		// W21: the speaker rides the ask verdict — the panel's why-asked
		// line names the extension that asked (the composed chain's first
		// non-abstain; exactOptionalPropertyTypes: omitted, never
		// `undefined`).
		return chainVerdict.speaker === undefined
			? { action: "ask", decisionId: nextDecisionId() }
			: { action: "ask", decisionId: nextDecisionId(), speaker: chainVerdict.speaker };
	}

	// Permission negotiation — defer is a REAL pause (Phase D). C group: the
	// hook itself is cancelable (a slow policy query must not outlive an
	// abort), and the signal is re-checked after it returns. Runs only when
	// the policy chain did not run at all (ruling A: an ask was already
	// resolved by the human pause above — the static hook never speaks for
	// it, and a durable decision already spoke for the call).
	if (durable === undefined && chainVerdict === undefined && hooks.onPreTool) {
		const decision = await raceAbort(hooks.onPreTool(payload, ctx), signal);
		if (signal?.aborted) throw ABORTED;
		if (decision.action === "defer") {
			return { action: "ask", decisionId: nextDecisionId() };
		}
		if (decision.action !== "allow") {
			return { action: "deny", result: resultEvent(call, denialResult(decision.reason ?? "denied")) };
		}
	}
	return { action: "allow" };
}

/**
 * The human approval pause (Phase D / ruling A): register the resolver
 * BEFORE announcing the request (a consumer that answers the moment it
 * sees the event must find the resolver already waiting — no deadlock
 * between push and await), persist the request (via push), await the
 * human's decision — abortable (an abort during the wait ends the run; a
 * verdict given in the same instant is still recorded exactly once) —
 * then persist the decision. Returns "approved" | "denied".
 */
async function humanPause(
	call: ToolCallEnd,
	decisionId: string,
	hooks: HookHost,
	log: EventLog,
	resolveApproval: ((decisionId: string) => Promise<PermissionDecision>) | undefined,
	resolveApprovalVerdict: ((decisionId: string) => boolean | undefined) | undefined,
	signal: AbortSignalLike | undefined,
	push: (ev: EventInput) => void,
	speaker?: string,
): Promise<PermissionDecision> {
	const pendingDecision =
		resolveApproval !== undefined
			? resolveApproval(decisionId)
			: Promise.resolve({ action: "deny", reason: "no approval channel configured" } as const);
	push({
		type: "permission_requested",
		decisionId,
		callId: call.callId,
		invocationSeq: call.seq,
		name: call.name,
		input: call.input ?? {},
		// W21: the ask verdict's speaker — the panel's why-asked line (a
		// static-hook ask has none).
		...(speaker !== undefined ? { speaker } : {}),
	});
	if (hooks.onPause) await hooks.onPause("awaiting approval", {}).catch(() => {});
	// Area 4: the pause is abortable — a cancel during the human's wait
	// ends the run now; the request stays durable and pending.
	let finalDecision: PermissionDecision;
	try {
		finalDecision = await raceAbort(pendingDecision, signal);
	} catch (err) {
		if (err === ABORTED) {
			// round 4 (adversarial): the human may have answered in the same instant
			// the abort landed — a CONSUMED verdict must be recorded
			// (exactly once), never lost; the abort then ends the run with
			// its honest aborted terminal.
			const verdict = resolveApprovalVerdict?.(decisionId);
			if (verdict !== undefined) {
				push({
					type: "permission_decided",
					decisionId,
					callId: call.callId,
					invocationSeq: call.seq,
					decision: verdict ? "approved" : "denied",
					...(verdict ? {} : { reason: "denied by user" }),
				});
			}
		}
		throw err;
	}
	// The approval channel (session.approve) persists the decision
	// write-ahead BEFORE waking the resolver (Area 2): if it already
	// landed in the log, this is the same decision, not a duplicate.
	if (log.all.find((e) => e.type === "permission_decided" && e.decisionId === decisionId) === undefined) {
		push({
			type: "permission_decided",
			decisionId,
			callId: call.callId, // binds the decision to the invocation (B group)
			invocationSeq: call.seq,
			decision: finalDecision.action === "allow" ? "approved" : "denied",
			...(finalDecision.action === "deny" && finalDecision.reason !== undefined
				? { reason: finalDecision.reason }
				: {}),
		});
	}
	return finalDecision;
}

/**
 * 0.1.26: the ledgered execution of an ALLOWED call — started (durable
 * BEFORE the side effect, write-ahead acked by the drain), handler,
 * receipt, result. The executionId comes from the loop's monotonic
 * allocator (under concurrency the old `lastSeq + 1` prediction raced).
 */
async function runLedgered(
	call: ToolCallEnd,
	registry: ToolRegistry,
	hooks: HookHost,
	ctx: ToolContext,
	signal: AbortSignalLike | undefined,
	push: (ev: EventInput, ack?: (executionId?: string) => void) => void,
): Promise<void> {
	const tool = registry.get(call.name)!; // validated + decided by decideCall
	// C group: the signal is re-checked immediately before the started event —
	// an abort that landed in any permission path must not let the side
	// effect begin.
	if (signal?.aborted) throw ABORTED;
	// The started event is durable BEFORE the side effect; a crash between
	// it and the result leaves "uncertain". The ack resolves when the
	// drain yields the event and the consumer persisted it — the handler
	// never runs before its receipt is on disk (write-ahead preserved
	// under the parallel execution). The executionId is allocated BY THE
	// DRAIN (ex-<seq> — atomic with the append, stable across replays) and
	// carried back through the ack.
	const executionId = await new Promise<string>((res) => {
		push(
			{
				type: "tool_execution_started",
				callId: call.callId,
				invocationSeq: call.seq,
				name: call.name,
				input: call.input!, // non-null: decideCall denied a null input before this ran
			} as EventInput,
			(id) => res(id ?? ""), // the drain always passes the allocated id for a started event
		);
	});

	let result: ToolResult;
	try {
		// C group: re-checked again right before the handler — the handler also
		// observes ctx.signal, but the gate itself must not invoke it after
		// a cancel.
		result = signal?.aborted
			? { content: "aborted before execution", isError: true, errorKind: "precondition" }
			: await tool.execute(call.input!, ctx);
	} catch (err) {
		result = {
			content: err instanceof Error ? err.message : String(err),
			isError: true,
			errorKind: "fatal",
		};
	}

	if (hooks.onPostTool) {
		result = await hooks.onPostTool({ callId: call.callId, name: call.name, input: call.input ?? {} }, result, ctx);
	}

	// ruling #12 correction one: a non-idempotent failure's side effects may have
	// partially applied — an honest note rides the RESULT (and the failed
	// receipt below, losslessly — a crash-window repair of the tool_result
	// reproduces the normal path). Idempotent failures carry no note; the
	// MCP bridge maps tools without declaring idempotency, so unknown
	// idempotency = the note applies (honest). WR-1-F1: a PRECONDITION
	// refusal is work refused BEFORE it starts — by the kind's own
	// contract nothing ran, so the note would be a false statement there.
	if (result.isError && result.errorKind !== "precondition" && tool.idempotent !== true) {
		result = {
			...result,
			content: `${result.content}\n[non-idempotent tool failed — its side effects may have partially applied; verify before retrying]`,
		};
	}

	if (result.isError) {
		// Area 3: only a tool that PROVED safe-to-retry (idempotent) gets a
		// clean failure; a non-idempotent failure may have produced a side
		// effect and is uncertain until a human decides.
		// round 8: the tags ride on the RECEIPT too — a crash-window repair of the
		// tool_result reproduces the normal path losslessly.
		push({
			type: "tool_execution_failed",
			executionId,
			callId: call.callId,
			invocationSeq: call.seq,
			error: result.content,
			// P1-9: errorKind only exists on errors (the type now enforces it;
			// the runtime guard keeps a JS tool's illegal combination out of
			// the persisted event too).
			...(result.isError && result.errorKind ? { errorKind: result.errorKind } : {}),
			safeToRetry: tool.idempotent === true,
			...(result.tags !== undefined ? { tags: result.tags } : {}),
		});
	} else {
		push({
			type: "tool_execution_succeeded",
			executionId,
			callId: call.callId,
			invocationSeq: call.seq,
			result: { content: result.content, isError: false },
			...(result.tags !== undefined ? { tags: result.tags } : {}),
		});
	}

	push(resultEvent(call, result, executionId));
}

/** Thrown when an abort lands while the loop awaits a human decision. */
const ABORTED = Symbol("kiso-aborted-during-approval");

/**
 * Wait for a human decision (approval or uncertain verdict), but WAKE on
 * abort (Area 4 / C group): a cancel during the wait must end the run, not
 * leave the iterator hung. Throws ABORTED; the loop converts it to an
 * `aborted` terminal.
 */
async function raceAbort<T>(
	pendingDecision: Promise<T>,
	signal: AbortSignalLike | undefined,
): Promise<T> {
	if (signal === undefined) return pendingDecision;
	if (signal.aborted) throw ABORTED;
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(ABORTED);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		pendingDecision.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

// ── Error structuring ───────────────────────────────────────────────────

/**
 * Adapter exceptions → StructuredError. Anything already shaped like one
 * passes through; everything else is `unknown` — never a regex over error
 * text (ADR-0005).
 */
export function toStructuredError(err: unknown): StructuredError {
	if (typeof err === "object" && err !== null) {
		const e = err as Partial<StructuredError>;
		if (typeof e.code === "string" && typeof e.retryable === "boolean") {
			return {
				code: e.code as StructuredError["code"],
				...(e.status !== undefined ? { status: e.status } : {}),
				retryable: e.retryable,
				message: typeof e.message === "string" ? e.message : String(err),
			};
		}
	}
	return {
		code: "unknown",
		retryable: false,
		message: err instanceof Error ? err.message : String(err),
	};
}

/** Abortable sleep: a cancel during backoff wakes the run immediately. */
function sleep(ms: number, signal?: AbortSignalLike): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms) as unknown as ReturnType<typeof globalThis.setTimeout>;
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * C area (bootstrap #3): the DEFAULT for how many of the NEWEST compactable tool
 * results survive a microcompact boundary (overridable per config via
 * microcompact.keepResults) — the model must keep reasoning over the
 * recent results, whatever turn they belong to.
 */
const KEEP_COMPACTABLE_RESULTS = 4;

/**
 * C area: the boundary seq for a microcompact — drawn by COMPACTABLE-RESULT
 * recentness, never user turns: a SINGLE user turn that reads several big
 * files (the coding agent's main overflow shape) crosses the threshold and
 * must trigger. The newest `keepResults` still-visible compactable tool
 * results stay intact; the boundary points AT the (K+1)th-newest of them,
 * so it and everything older is cleared. Results already cleared by an
 * earlier boundary do not count toward the kept window — each new boundary
 * makes progress. Undefined when fewer than keepResults+1 compactable
 * results remain (the kept window is the whole context).
 */
function microcompactBoundarySeq(events: readonly Event[], keepResults: number): number | undefined {
	const callName = new Map<string, string>();
	let lastCleared = -1;
	for (const ev of events) {
		if (ev.type === "tool_call_end") callName.set(ev.callId, ev.name);
		if (ev.type === "microcompacted" && ev.beforeSeq > lastCleared) lastCleared = ev.beforeSeq;
	}
	const visible: number[] = [];
	for (const ev of events) {
		if (ev.type !== "tool_result" || ev.seq <= lastCleared) continue;
		const name = callName.get(ev.callId);
		// the ergonomics batch C6 (P4): the do-not-compact tag makes a result UN-CLEARABLE
		// (the projection keeps it) — the count must EXCLUDE it, exactly like
		// the clearing side. A tagged result counted here would steal a keep
		// window slot forever and could anchor the boundary at a result the
		// projection refuses to clear (the count and the clearing share one rule).
		if (name !== undefined && MICROCOMPACTABLE.has(name) && !(ev.tags ?? []).includes(DO_NOT_COMPACT)) visible.push(ev.seq);
	}
	if (visible.length <= keepResults) return undefined;
	return visible[visible.length - keepResults - 1]!;
}

/** A signal that never aborts — for executions outside any abort scope. */
const NEVER_ABORT = {
	aborted: false,
	addEventListener: () => {},
	removeEventListener: () => {},
} satisfies AbortSignalLike;

export type { EventInput, AssistantBlock, AssistantMessage, Message, ToolResultMessage };

// ── MG-1 (ADR-0051 Amendment 5): the envelope preparation ────────────────
//
// Pure: stamp the run's scope over whatever the adapter claimed (adapters
// are not trusted), strip on an unscoped run, and enforce the two caps —
// optional entries drop WHOLE at the soft cap (earliest first, emission
// order) with a durable `truncated: true`; a required set over the hard
// cap is a provider-contract violation the caller turns into a voided
// turn. Sizes are UTF-8 bytes of the serialized entry.

const CONTINUATION_SOFT_CAP = 256 * 1024;
const CONTINUATION_HARD_CAP = 2 * 1024 * 1024;

function prepareContinuation<T extends { continuation?: Continuation }>(
	stop: T,
	scope: ContinuationScope | undefined,
): T | "hard-cap" {
	const c = stop.continuation;
	if (c === undefined) return stop;
	if (scope === undefined) {
		const { continuation: _stripped, ...rest } = stop;
		return rest as unknown as T;
	}
	const size = (e: ContinuationEntry): number => new TextEncoder().encode(e.data).length + new TextEncoder().encode(e.kind).length + 32;
	const requiredBytes = c.entries.filter((e) => e.required).reduce((n, e) => n + size(e), 0);
	if (requiredBytes > CONTINUATION_HARD_CAP) return "hard-cap";
	const kept = [...c.entries];
	let total = kept.reduce((n, e) => n + size(e), 0);
	let truncated = false;
	for (let i = 0; total > CONTINUATION_SOFT_CAP && i < kept.length; ) {
		if (kept[i]!.required) {
			i += 1;
			continue;
		}
		total -= size(kept[i]!);
		kept.splice(i, 1);
		truncated = true;
	}
	return { ...stop, continuation: { scope, entries: kept, ...(truncated ? { truncated: true as const } : {}) } };
}
