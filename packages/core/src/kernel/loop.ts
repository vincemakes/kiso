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
 * exactly. Compaction is recorded as a `compacted` event and re-applied by
 * the projection, keeping the replay identical to the live run.
 *
 * Per iteration:
 *   assemble (onUserMessage / onPreLlm)
 *     → adapter.stream(): events yielded straight through, tool calls collected
 *     → execute: validation → permission (onPreTool) → handler → rewrite
 *       (onPostTool), concurrency-safe calls batched parallel, the rest serial
 *     → tool_result events appended
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
import { estimateTokens, microcompact } from "./compaction.js";
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
import { messagesToEvents, MICROCOMPACTABLE, projectMessages } from "./project.js";

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
	/** Auto-compaction: when the estimated context exceeds the threshold,
	 *  microcompact old tool results before the next model call. */
	readonly compaction?: { readonly thresholdTokens: number };
	/**
	 * C 区: MICROCOMPACT — when the projected context exceeds the threshold,
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
	 * 第四轮(对抗): a verdict the human ALREADY gave before an abort landed.
	 * The abort path consults this BEFORE yielding the aborted terminal: a
	 * consumed verdict must be recorded (exactly once), never lost — the
	 * human's decision outranks the abort.
	 */
	readonly approvalVerdict?: (decisionId: string) => boolean | undefined;
	/**
	 * C 组: the channel that resolves a failed NON-idempotent execution.
	 * The loop persists `uncertain_pending`, yields it, and AWAITS the
	 * human verdict — no next model turn, no sibling tool, no auto-retry.
	 * Absent, the failure is recorded `abandoned` (never retried).
	 */
	readonly resolveUncertainty?: (executionId: string) => Promise<"rerun" | "abandoned">;
	/** 第四轮(对抗): the uncertainty twin of `approvalVerdict`. */
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
	// C 组: the outcome is PERSISTED as a user_input_replaced event — the
	// projection renders the final replacement AT THE INPUT'S POSITION (or
	// nothing, for a true veto), so the rewritten fact is the ONLY fact
	// every later turn of the run sees.
	let messages = derive();
	let vetoed = false;
	if (hooks.onUserMessage && messages.length > 0) {
		const last = messages.at(-1);
		if (last?.role === "user") {
			const inputEvent = [...log.all].reverse().find((e): e is Event & { type: "user_input" } => e.type === "user_input");
			// 六: the hook runs AT MOST ONCE per input. A replacement that
			// ALREADY exists (persisted before a crash, or before a resume)
			// means the hook already spoke for this input — it must never
			// run again, and the run continues from the durable fact.
			const replacement = log.all.find(
				(e): e is Event & { type: "user_input_replaced" } =>
					e.type === "user_input_replaced" && e.replaces === inputEvent?.seq,
			);
			if (replacement !== undefined) {
				// 六/第五轮(P1-7): the hook ALREADY spoke for this input — a
				// durable null content is a TRUE veto: restore the vetoed
				// flag so the provider is NEVER called, even when earlier
				// history exists (previously only an empty history happened
				// to stop).
				if (replacement.content === null) vetoed = true;
			}
			if (replacement === undefined && inputEvent) {
				const rewritten = await hooks.onUserMessage(last, {});
				// 一: the rewrite/veto is a NORMAL stream event — persisted by
				// the harness and visible to consumers, never a hidden append.
				const replaced = log.append({
					type: "user_input_replaced",
					replaces: inputEvent.seq,
					content: rewritten?.content ?? null,
					...(rewritten !== null && rewritten.source !== undefined ? { source: rewritten.source } : {}),
				});
				messages = derive();
				yield replaced;
				if (rewritten === null) vetoed = true; // 三: a true veto ends the run
			}
		}
	}
	// 三: a true veto ends the run — the provider is NEVER called, even
	// when earlier history exists.
	if (vetoed || messages.length === 0) {
		yield await terminal({ kind: "completed" });
		return;
	}

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

		// ── Auto-compaction: ONLY this turn's NEWLY cleared results are
		//    persisted, keyed by the replaced tool-result event's seq; the
		//    projection applies them verbatim (A 组/D 组/五).
		if (config.compaction && estimateTokens(messages) > config.compaction.thresholdTokens) {
			if (hooks.onPreCompact) await hooks.onPreCompact(messages, {}).catch(() => {});
			const result = microcompact(messages);
			// 五: the delta only — messages already carrying the clear marker
			// are never re-cleared (microcompact's idempotence gate), so the
			// same replacement is never recorded twice across turns.
			const cleared = result.cleared.map((c) => ({
				eventSeq: c.eventSeq!,
				callId: c.callId,
				content: c.content,
			}));
			if (cleared.length > 0) {
				const full = log.append({ type: "compacted", cleared });
				if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
				yield full;
				messages = derive();
				if (hooks.onPostCompact) await hooks.onPostCompact(messages, {}).catch(() => {});
			}
		}

		// ── C 区: one-shot microcompact boundary when over the threshold ──
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
		// 五: the turn is a strict protocol — once the provider stops, ANY
		// further event (delta, tool call, usage, thinking) is a violation.
		let sawStop = false;
		let postStopViolation = false;
		// 五: the adapter may only produce its OWN event kinds — a
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
					// 五: the trust gate — a kernel-owned event from the
					// adapter is a forgery: it is never appended (never
					// persisted), and the turn ends with a unique
					// invalid_request terminal below.
					if (!isAdapterEvent(ev)) {
						forgedEvent = true;
						break;
					}
					// 五: a delta/tool call/usage arriving AFTER the provider's
					// stop is a protocol error — the violating event is never
					// appended, and the turn ends with an error terminal (the
					// pending tools must NOT execute).
					if (sawStop && ev.type !== "stop") {
						postStopViolation = true;
						break;
					}
					if (ev.type === "stop") {
						sawStop = true;
						lastStop = ev.reason;
						stopCount += 1;
					}
					if (ev.type === "tool_call_end") pending.push(ev);
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

		// ── 五: a forged kernel-owned event is a protocol error ──────────────
		if (forgedEvent) {
			yield await terminal({
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: "provider emitted a kernel-owned event" },
			});
			return;
		}

		// ── 五: events after the stop are a protocol error ───────────────────
		if (postStopViolation) {
			yield await terminal({
				kind: "error",
				error: { code: "invalid_request", retryable: false, message: "provider emitted events after its stop event" },
			});
			return;
		}

		// ── Terminal check: no tool call this turn → done, honestly ────────
		if (pending.length === 0) {
			// Area 6: protocol anomalies are STRUCTURED ERRORS, never a
			// default `completed` — a stream with no stop, a duplicate stop,
			// or a tool_use that never produced a complete call.
			if (stopCount === 0) {
				yield await terminal({
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: "provider stream ended without a stop event" },
				});
				return;
			}
			if (stopCount > 1) {
				yield await terminal({
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: `provider emitted ${stopCount} stop events in one turn` },
				});
				return;
			}
			yield await terminal(terminalForStop(lastStop));
			return;
		}

		// ── Abort check before side effects: a stop landing during the
		//    model turn must never let the pending tools run ────────────────
		if (aborted()) {
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}

		// ── C 组: the turn is verified BEFORE any tool runs ────────────────
		// A tool may only execute when the provider turn is well-formed:
		// exactly one stop, whose reason is compatible with complete calls.
		// Missing/duplicate stops, max_tokens, refusal, content_filter,
		// pause_turn, context_window, abort, and the contradictory
		// end_turn-with-pending-calls all terminate WITHOUT executing.
		if (pending.length > 0) {
			if (stopCount === 0) {
				yield await terminal({
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: "provider stream ended without a stop event" },
				});
				return;
			}
			if (stopCount > 1) {
				yield await terminal({
					kind: "error",
					error: { code: "invalid_request", retryable: false, message: `provider emitted ${stopCount} stop events in one turn` },
				});
				return;
			}
			switch (lastStop) {
				case "tool_use":
				case "function_call":
					break; // compatible with complete calls — execute
				case "max_tokens":
					yield await terminal({ kind: "max_tokens" });
					return;
				case "abort":
					yield await terminal({ kind: "aborted", by: "user" });
					return;
				case "error":
					yield await terminal({
						kind: "error",
						error: { code: "unknown", retryable: false, message: "provider stopped with an error" },
					});
					return;
				case "refusal":
				case "pause_turn":
				case "content_filter":
				case "context_window":
				case "end_turn":
				case "stop_sequence":
				default:
					yield await terminal({
						kind: "error",
						error: {
							code: "invalid_request",
							retryable: false,
							message: `provider stopped with '${String(lastStop)}' but left ${pending.length} tool call(s) unexecuted`,
						},
					});
					return;
			}
		}

		// ── Execute: sequential, ledgered, pause-capable (Phase D) ──────────
		// Sequential on purpose: the ledger (started → succeeded/failed) and
		// the approval pause need deterministic, write-ahead ordering; the
		// windowed parallel batching (ADR-0015) returns as an optimization
		// once the ledger contract is stable.
		for (const call of pending) {
			// Area 4: an abort after the first tool must never start a
			// sibling tool — each pending call checks the signal first.
			if (aborted()) {
				yield await terminal({ kind: "aborted", by: "user" });
				return;
			}
			let currentExecutionId: string | undefined;
			try {
				for await (const ev of executeOne(call, registry, hooks, { signal: signal ?? NEVER_ABORT }, log, config.resolveApproval, config.approvalVerdict, signal, config.approvalPolicies)) {
					// 四: the identity of THIS execution comes from the stream —
					// a historical same-callId execution must never be mistaken
					// for this call's (the provider callId may repeat across runs).
					if (ev.type === "tool_execution_started") currentExecutionId = ev.executionId;
					if (hooks.onEvent) await hooks.onEvent(ev, {}).catch(() => {});
					yield ev;
				}
			} catch (err) {
				// An abort during the approval pause propagates here as the
				// sentinel — end the run honestly; the request stays durable.
				if (err === ABORTED || aborted()) {
					yield await terminal({ kind: "aborted", by: "user" });
					return;
				}
				throw err;
			}

			// C 组: a failed NON-idempotent execution is a persistent
			// uncertain PAUSE — no sibling tool, no auto-retry, and the next
			// model turn waits for the human verdict. 四: the failed event is
			// found by THIS execution's id — never by the repeatable callId,
			// which would let a historical same-callId failure pollute a fresh
			// successful execution with a stale uncertain pause.
			const failed =
				currentExecutionId === undefined
					? undefined
					: [...log.all]
							.reverse()
							.find(
								(e): e is Event & { type: "tool_execution_failed" } =>
									e.type === "tool_execution_failed" && e.executionId === currentExecutionId,
							);
			if (failed !== undefined && !failed.safeToRetry) {
				// Register the human channel BEFORE announcing the pause —
				// a consumer that answers the moment it sees the event must
				// find the resolver already waiting (no deadlock between
				// yield and await, mirroring the approval pause).
				const pendingResolution =
					config.resolveUncertainty !== undefined ? config.resolveUncertainty(failed.executionId) : undefined;
				const pendingUncertain = log.append({
					type: "uncertain_pending",
					executionId: failed.executionId,
					callId: call.callId,
					name: call.name,
					error: failed.error,
				});
				if (hooks.onEvent) await hooks.onEvent(pendingUncertain, {}).catch(() => {});
				yield pendingUncertain;

				let resolution: "rerun" | "abandoned";
				if (pendingResolution !== undefined) {
					try {
						resolution = await raceAbort(pendingResolution, signal);
					} catch (err) {
						if (err === ABORTED) {
							// 第四轮(对抗): the human may have answered in the
							// same instant the abort landed — a CONSUMED verdict
							// must be recorded (exactly once), never lost. It is
							// appended here, then the run ends with its honest
							// aborted terminal; the execution is resolved, not
							// bricked.
							const verdict = config.uncertaintyVerdict?.(failed.executionId);
							if (verdict !== undefined) {
								const verdictEvent = log.append({
									type: "tool_execution_resolved",
									executionId: failed.executionId,
									callId: call.callId,
									resolution: verdict,
								});
								if (hooks.onEvent) await hooks.onEvent(verdictEvent, {}).catch(() => {});
								yield verdictEvent;
							}
							yield await terminal({ kind: "aborted", by: "user" });
							return;
						}
						throw err;
					}
				} else {
					// No channel: record the conservative verdict — the
					// failure is NEVER auto-retried, and the ledger stays
					// consistent for future resumes.
					resolution = "abandoned";
				}
				// 七: the LOOP owns the resolution event — appended and
				// yielded on EVERY verdict path (channel or not), so the Run
				// persists it and the consumer's stream has no hidden gap.
				// A live resolveUncertain() only passed the verdict; the
				// event itself is created here, exactly once.
				const resolvedEvent = log.append({
					type: "tool_execution_resolved",
					executionId: failed.executionId,
					callId: call.callId,
					resolution,
				});
				if (hooks.onEvent) await hooks.onEvent(resolvedEvent, {}).catch(() => {});
				yield resolvedEvent;
				// Either verdict ends the pending list: siblings never run.
				break;
			}
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

/**
 * Execute one tool call as a ledgered sequence of events:
 *
 *   [guards] → permission (allow / deny / DEFER→pause+resume)
 *   → tool_execution_started (durable BEFORE the side effect)
 *   → handler → tool_execution_succeeded|failed
 *   → tool_result (the model's view)
 *
 * Exactly-once (Phase D): before anything runs, the guard asks the ledger
 * whether this tool+input reached a terminal state before. A confirmed
 * success is replayed, an interrupted (uncertain) or abandoned attempt
 * blocks with a precondition result — the handler never auto-runs a
 * possibly-executed side effect.
 */
async function* executeOne(
	call: ToolCallEnd,
	registry: ToolRegistry,
	hooks: HookHost,
	ctx: ToolContext,
	log: EventLog,
	resolveApproval: ((decisionId: string) => Promise<PermissionDecision>) | undefined,
	resolveApprovalVerdict: ((decisionId: string) => boolean | undefined) | undefined,
	signal: AbortSignalLike | undefined,
	approvalPolicies: readonly { readonly extension: string; readonly policy: ApprovalPolicy }[] | undefined,
): AsyncGenerator<Event> {
	const payload: ToolCallPayload = {
		callId: call.callId,
		name: call.name,
		input: call.input ?? {},
	};

	const emitResult = (result: ToolResult, executionId?: string): Event =>
		log.append({
			type: "tool_result",
			callId: call.callId,
			content: result.content,
			isError: result.isError,
			// P1-9: errorKind only exists on errors (the type now enforces it;
			// the runtime guard keeps a JS tool's illegal combination out of
			// the persisted event too).
			...(result.isError && result.errorKind ? { errorKind: result.errorKind } : {}),
			// 五: a live tool's tags are preserved losslessly (do-not-compact,
			// billing receipts, trace anchors) — never dropped at the loop.
			...(result.tags !== undefined ? { tags: result.tags } : {}),
			...(executionId !== undefined ? { executionId } : {}),
		});

	// Unknown tool or unparseable args — refuse before anything runs.
	const tool: Tool | undefined = registry.get(call.name);
	if (!tool) {
		yield emitResult({
			content: `Unknown tool: ${call.name}`,
			isError: true,
			errorKind: "invalid_input",
		});
		return;
	}
	if (call.input === null) {
		yield emitResult({
			content: "Arguments failed to parse as JSON",
			isError: true,
			errorKind: "invalid_input",
		});
		return;
	}

	// Phase B: real JSON Schema validation — the handler never sees garbage.
	const schemaError = validateArgs(tool.parameters, call.input);
	if (schemaError !== null) {
		yield emitResult({
			content: `Arguments failed schema validation:${schemaError}`,
			isError: true,
			errorKind: "invalid_input",
		});
		return;
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
	// chain never re-runs when its verdict is already in the log (同构
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
	if (durable === undefined && approvalPolicies !== undefined && approvalPolicies.length > 0) {
		for (const { extension, policy } of approvalPolicies) {
			let v: PolicyVerdict;
			try {
				v = await raceAbort(Promise.resolve(policy.decide(payload, ctx)), signal);
			} catch {
				v = { action: "ask" }; // 抛错 = 该扩展计为 ask
			}
			if (v.action === "deny") {
				deniedBy ??= extension;
				deniedReason ??= v.reason; // the FIRST denial's reason
			} else if (v.action === "ask") {
				chainVerdict = { action: "ask" };
			}
		}
		if (deniedBy !== undefined) {
			chainVerdict = { action: "deny", reason: deniedReason ?? "denied" };
		} else if (chainVerdict === undefined) {
			chainVerdict = { action: "allow" };
		}
		if (chainVerdict.action !== "ask") {
			// allow/deny are PERSISTED FACTS (decidedBy = the extension) —
			// never a human pause.
			yield log.append({
				type: "permission_decided",
				decisionId: `d-${log.lastSeq + 1}`,
				callId: call.callId,
				decision: chainVerdict.action === "allow" ? "approved" : "denied",
				...(chainVerdict.action === "deny" ? { reason: chainVerdict.reason } : {}),
				decidedBy: deniedBy ?? approvalPolicies[0]!.extension,
			});
		}
	}
	if (chainVerdict?.action === "deny") {
		yield emitResult(denialResult(chainVerdict.reason));
		return;
	}
	if (durable !== undefined && durable.decision === "denied") {
		yield emitResult(denialResult(durable.reason ?? "denied"));
		return;
	}
	if (chainVerdict?.action === "ask" && hooks.onPreTool === undefined) {
		// No human flow exists — the ask degrades to an honest denial, never
		// an unasked execution (mirrors the defer-without-channel path).
		yield emitResult(denialResult("a policy asked for a human decision, but no approval flow is configured"));
		return;
	}

	// Permission negotiation — defer is a REAL pause (Phase D). C 组: the
	// hook itself is cancelable (a slow policy query must not outlive an
	// abort), and the signal is re-checked after it returns. Skipped when
	// the policy chain already decided (durable or all-allow).
	if (durable === undefined && chainVerdict?.action !== "allow" && hooks.onPreTool) {
		const decision = await raceAbort(hooks.onPreTool(payload, ctx), signal);
		if (signal?.aborted) throw ABORTED;
		if (decision.action === "defer") {
			const decisionId = `d-${log.lastSeq + 1}`;
			// Register the resolver BEFORE announcing the pause: a consumer
			// that answers the request the moment it sees it must find the
			// resolver already waiting (no deadlock between yield and await).
			const pendingDecision =
				resolveApproval !== undefined
					? resolveApproval(decisionId)
					: Promise.resolve({ action: "deny", reason: "no approval channel configured" } as const);
			const requested = log.append({
				type: "permission_requested",
				decisionId,
				callId: call.callId,
				name: call.name,
				input: payload.input,
			});
			if (hooks.onPause) await hooks.onPause("awaiting approval", {}).catch(() => {});
			yield requested;

			// Area 4: the pause is abortable — a cancel during the human's
			// wait ends the run now; the request stays durable and pending.
			let finalDecision: PermissionDecision;
			try {
				finalDecision = await raceAbort(pendingDecision, signal);
			} catch (err) {
				if (err === ABORTED) {
					// 第四轮(对抗): the human may have answered in the same
					// instant the abort landed — a CONSUMED verdict must be
					// recorded (exactly once), never lost; the abort then
					// ends the run with its honest aborted terminal.
					const verdict = resolveApprovalVerdict?.(decisionId);
					if (verdict !== undefined) {
						yield log.append({
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
			const decided =
				log.all.find((e) => e.type === "permission_decided" && e.decisionId === decisionId) ??
				log.append({
					type: "permission_decided",
					decisionId,
					callId: call.callId, // binds the decision to the invocation (B 组)
					decision: finalDecision.action === "allow" ? "approved" : "denied",
					...(finalDecision.action === "deny" && finalDecision.reason !== undefined
						? { reason: finalDecision.reason }
						: {}),
				});
			yield decided;

			if (finalDecision.action !== "allow") {
				yield emitResult(denialResult(finalDecision.reason ?? "denied"));
				return;
			}
		} else if (decision.action !== "allow") {
			yield emitResult(denialResult(decision.reason ?? "denied"));
			return;
		}
	}

	// The ledgered execution. The started event is durable BEFORE the side
	// effect; a crash between it and the result leaves "uncertain". The
	// executionId is the persistent identity of THIS logical execution
	// (Area 3): generated from the log's next seq, so it is unique per log
	// and survives restarts.
	const executionId = `ex-${log.lastSeq + 1}`;
	// C 组: the signal is re-checked immediately before the started event —
	// an abort that landed in any permission path must not let the side
	// effect begin.
	if (signal?.aborted) throw ABORTED;
	const started = log.append({
		type: "tool_execution_started",
		executionId,
		callId: call.callId,
		name: call.name,
		input: call.input,
	});
	yield started;

	let result: ToolResult;
	try {
		// C 组: re-checked again right before the handler — the handler also
		// observes ctx.signal, but the gate itself must not invoke it after
		// a cancel.
		result = signal?.aborted
			? { content: "aborted before execution", isError: true, errorKind: "fatal" }
			: await tool.execute(call.input, ctx);
	} catch (err) {
		result = {
			content: err instanceof Error ? err.message : String(err),
			isError: true,
			errorKind: "fatal",
		};
	}

	if (hooks.onPostTool) {
		result = await hooks.onPostTool(payload, result, ctx);
	}

	if (result.isError) {
		// Area 3: only a tool that PROVED safe-to-retry (idempotent) gets a
		// clean failure; a non-idempotent failure may have produced a side
		// effect and is uncertain until a human decides.
		// 八: the tags ride on the RECEIPT too — a crash-window repair of the
		// tool_result reproduces the normal path losslessly.
		yield log.append({
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
		yield log.append({
			type: "tool_execution_succeeded",
			executionId,
			callId: call.callId,
			result: { content: result.content, isError: false },
			...(result.tags !== undefined ? { tags: result.tags } : {}),
		});
	}

	yield emitResult(result, executionId);
}

/** Thrown when an abort lands while the loop awaits a human decision. */
const ABORTED = Symbol("kiso-aborted-during-approval");

/**
 * Wait for a human decision (approval or uncertain verdict), but WAKE on
 * abort (Area 4 / C 组): a cancel during the wait must end the run, not
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
 * C 区 (自举 #3): the DEFAULT for how many of the NEWEST compactable tool
 * results survive a microcompact boundary (overridable per config via
 * microcompact.keepResults) — the model must keep reasoning over the
 * recent results, whatever turn they belong to.
 */
const KEEP_COMPACTABLE_RESULTS = 4;

/**
 * C 区: the boundary seq for a microcompact — drawn by COMPACTABLE-RESULT
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
		if (name !== undefined && MICROCOMPACTABLE.has(name)) visible.push(ev.seq);
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
