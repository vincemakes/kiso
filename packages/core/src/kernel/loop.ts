/**
 * L2 — the ReAct loop. The kernel's only loop; everything else is harness.
 *
 * An async generator that yields every event as it happens (never buffers a
 * turn into a list — the agno failure), and converges on exactly one
 * `terminal` event per run (ADR-0004).
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
import type { Event, StopReason, StructuredError, Terminal, ToolCallEnd } from "../protocol/events.js";
import type { ApprovalPolicy, PolicyVerdict } from "../protocol/extension.js";
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
	 * C group: the channel that resolves a failed NON-idempotent execution.
	 * The loop persists `uncertain_pending`, yields it, and AWAITS the
	 * human verdict — no next model turn, no sibling tool, no auto-retry.
	 * Absent, the failure is recorded `abandoned` (never retried).
	 */
	readonly resolveUncertainty?: (executionId: string) => Promise<"rerun" | "abandoned">;
	/** round 4 (adversarial): the uncertainty twin of `approvalVerdict`. */
	readonly uncertaintyVerdict?: (executionId: string) => "rerun" | "abandoned" | undefined;
	/**
	 * E1: extension approval policies, tagged by their owning extension —
	 * decided BEFORE the human flow. Any deny wins (the FIRST denial's
	 * reason); else any ask falls into the existing flow; all allow
	 * auto-approves. A policy that throws counts as ask. Allow/deny are
	 * recorded durably with decidedBy = the extension's name, never pausing
	 * for a human; a durable decision already recorded (resume) takes
	 * effect and the chain never re-runs.
	 */
	readonly approvalPolicies?: readonly { readonly extension: string; readonly policy: ApprovalPolicy }[];
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
	let violated = false;
	// The violated signal: rejects when the turn is voided — the paused
	// ask-branches bail (abort semantics for not-started executions). Typed
	// `never` so the ask race resolves to the human decision alone.
	let violatedReject: () => void = () => {};
	const violatedP = new Promise<never>((_, reject) => {
		violatedReject = () => reject();
	});
	// The turn's ask-branches race it; a turn with NO ask leaves the
	// rejection un-consumed — the no-op keeps it from surfacing as an
	// unhandled rejection while the race consumers still receive it.
	void violatedP.catch(() => {});
	// The ask gate: an ask's human resolution blocks the calls after it.
	// The DECIDE chain serializes the decisions in CALL order, so the gate
	// an ask installs is structurally in place before the successors decide.
	let askGate: Promise<void> = Promise.resolve();
	let askRelease: (() => void) | null = null;
	// The decision chain: each launch's decide is chained onto the previous
	// one's — the decides run in CALL order and the chain resolves to the
	// call's verdict.
	let decideChain: Promise<ExecVerdict> = Promise.resolve({ action: "allow" });
	// The decisionId allocator: monotonic per log (seeded past the existing
	// log), unique under the parallel decides — the ids are correlation
	// keys (the executionId comes from the drain, seq-stable).
	let idSeq = log.all.length + 1;
	const nextDecisionId = (): string => `d-${idSeq++}`;
	const launch = (call: ToolCallEnd): void => {
		execActive += 1;
		launches.push(
			(async () => {
				try {
					await acquireWindow();
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
							config.approvalPolicies,
							nextDecisionId,
							pushExec,
						);
						if (v.action === "ask") {
							askGate = new Promise<void>((res) => {
								askRelease = res;
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
					if (verdict.action === "ask") {
						// The human pause — abortable by a user abort OR a turn
						// void (the violated promise). The gate opens when the
						// human decides, whatever the outcome (conservative
						// ordering: the successors then proceed with their own
						// verdicts).
						const decision = await Promise.race([
							humanPause(call, verdict.decisionId, hooks, log, config.resolveApproval, config.approvalVerdict, signal, pushExec),
							violatedP,
						]);
						askRelease?.();
						askRelease = null;
						if (violated) return;
						if (decision.action !== "allow") {
							// the reason rides the denial — the human's words,
							// or the honest "no approval flow configured".
							pushExec(resultEvent(call, denialResult(decision.reason ?? "denied")));
							return;
						}
					}
					// the conservative order: the calls AFTER an ask wait for its human
					// resolution (the askGate is the ask's pause promise —
					// resolved by default, released by the ask branch above).
					// The context may have changed when the human approves.
					await askGate;
					await runLedgered(
						call,
						registry,
						hooks,
						{ signal: signal ?? NEVER_ABORT, ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}) },
						signal,
						pushExec,
					);
				} catch (err) {
					// The abort sentinel (a user cancel during the decide or
					// the pause) is swallowed — the loop's aborted() check
					// ends the run honestly; anything else is recorded and
					// re-thrown after the settle (the consumer sees it).
					if (err !== ABORTED) launchError ??= err;
				} finally {
					releaseWindow();
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
						sawStop = true;
						lastStop = ev.reason;
						stopCount += 1;
					}
					if (ev.type === "tool_call_end") {
						pending.push(ev);
						// streaming execution: the call launches immediately — the decide
						// and the ledgered run proceed in parallel with the
						// model stream.
						launch(ev);
					}
					const full = log.append(ev);
					if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
					yield full;
				}
				break;
			} catch (err) {
				// Area 4: a user cancel surfaced by the SDK (APIUserAbortError
				// or any error while the signal is set) is an honest `aborted`
				// terminal, never a generic error.
				if (aborted()) {
					yield await terminal({ kind: "aborted", by: "user" });
					return;
				}
				const structured = toStructuredError(err);
				// Phase B: never silently re-stream a turn that already
				// emitted content — duplicates are worse than failures.
				if (structured.retryable && !streamed && attempts < maxRetries) {
					attempts += 1;
					await sleep(attempts * 250, signal); // abortable backoff
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
		} else if (pending.length === 0) {
			// Area 6: protocol anomalies are STRUCTURED ERRORS, never a
			// default `completed` — a stream with no stop, a duplicate stop,
			// or a tool_use that never produced a complete call.
			if (stopCount === 0) {
				voided = {
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: "provider stream ended without a stop event" },
				};
			} else if (stopCount > 1) {
				voided = {
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: `provider emitted ${stopCount} stop events in one turn` },
				};
			} else {
				yield await terminal(terminalForStop(lastStop));
				return;
			}
		}

		// ── Abort check: an abort now abandons the launched executions
		//    (started without receipt → uncertain), exactly as before ──────
		if (voided === null && aborted()) {
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}

		// ── C group: the turn is verified. 0.1.26 (streaming execution): the calls were
		// ALREADY launched at tool_call_end, so a non-compatible stop reason
		// VOIDS the turn instead of preventing the execution.
		if (voided === null && pending.length > 0) {
			if (stopCount === 0) {
				voided = {
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: "provider stream ended without a stop event" },
				};
			} else if (stopCount > 1) {
				voided = {
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: `provider emitted ${stopCount} stop events in one turn` },
				};
			} else {
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
			violated = true;
			violatedReject();
		}
		while (execActive > 0) {
			for await (const q of drainExec()) yield q;
			await sleep(10);
		}
		for await (const q of drainExec()) yield q;
		if (launchError !== null) throw launchError;
		if (voided !== null) {
			yield await terminal(voided);
			return;
		}

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
 *  ask carries the decisionId the human pause will bind to. */
type ExecVerdict =
	| { action: "deny"; result: EventInput }
	| { action: "ask"; decisionId: string }
	| { action: "allow" };

/** The tool_result event for a call — the shared shape (executionId rides
 *  it as the durable correlation, round 5). */
function resultEvent(call: ToolCallEnd, result: ToolResult, executionId?: string): EventInput {
	return {
		type: "tool_result",
		callId: call.callId,
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
	approvalPolicies: readonly { readonly extension: string; readonly policy: ApprovalPolicy }[] | undefined,
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

	// ── E1: the extension policy chain, decided BEFORE the human flow ─────
	// A durable POLICY decision for THIS call takes effect on resume — the
	// chain never re-runs when its verdict is already in the log (isomorphic
	// alreadyReplaced: the persisted fact speaks for the call). The match is
	// the same logical call: same callId, decidedBy set (a policy verdict,
	// never a human's), and input identical to the original tool_call_end —
	// a re-issued call with different arguments is a NEW call and re-decided.
	// Composition: deny > ask > allow — any deny wins (the FIRST denial's
	// reason), else any ask falls into the existing human flow below, and
	// only an ALL-allow chain auto-approves: recorded durably with decidedBy
	// = the extension's name, never a human-visible pause. A policy that
	// throws counts as ask.
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
	let chainVerdict: PolicyVerdict | undefined;
	let deniedReason: string | undefined;
	let deniedBy: string | undefined;
	let firstSpeaker: string | undefined; // the first non-abstain verdict's extension
	let anySpoke = false;
	if (durable === undefined && approvalPolicies !== undefined && approvalPolicies.length > 0) {
		for (const { extension, policy } of approvalPolicies) {
			let v: PolicyVerdict;
			try {
				v = await raceAbort(Promise.resolve(policy.decide(payload, ctx)), signal);
			} catch {
				v = { action: "ask" }; // a throwing policy counts as ask — it speaks, never silently
			}
			if (v.action === "abstain") continue; // no opinion — not a verdict
			anySpoke = true;
			firstSpeaker ??= extension;
			if (v.action === "deny") {
				deniedBy ??= extension;
				deniedReason ??= v.reason; // the FIRST denial's reason
			} else if (v.action === "ask") {
				chainVerdict = { action: "ask" };
			}
		}
		if (deniedBy !== undefined) {
			chainVerdict = { action: "deny", reason: deniedReason ?? "denied" };
		} else if (chainVerdict === undefined && anySpoke) {
			chainVerdict = { action: "allow" }; // every speaker allows
		} else if (chainVerdict === undefined) {
			// an all-abstain (ADR-0042): NO policy speaks — the call falls to
			// the ask flow below, never to a silent auto-approve. The human
			// decides; absent a channel, humanPause's honest denial.
			chainVerdict = { action: "ask" };
		}
		if (chainVerdict.action !== "ask") {
			// allow/deny are PERSISTED FACTS (decidedBy = a SPEAKING
			// extension — never the chain head on behalf of a non-speaker)
			// — never a human pause.
			push({
				type: "permission_decided",
				decisionId: nextDecisionId(),
				callId: call.callId,
				decision: chainVerdict.action === "allow" ? "approved" : "denied",
				...(chainVerdict.action === "deny" ? { reason: chainVerdict.reason } : {}),
				decidedBy: deniedBy ?? (firstSpeaker as string),
			});
		}
	}
	if (chainVerdict?.action === "deny") {
		return { action: "deny", result: resultEvent(call, denialResult(chainVerdict.reason)) };
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
		return { action: "ask", decisionId: nextDecisionId() };
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
): Promise<PermissionDecision> {
	const pendingDecision =
		resolveApproval !== undefined
			? resolveApproval(decisionId)
			: Promise.resolve({ action: "deny", reason: "no approval channel configured" } as const);
	push({
		type: "permission_requested",
		decisionId,
		callId: call.callId,
		name: call.name,
		input: call.input ?? {},
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
			? { content: "aborted before execution", isError: true, errorKind: "fatal" }
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
	// idempotency = the note applies (honest).
	if (result.isError && tool.idempotent !== true) {
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
