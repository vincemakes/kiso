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

import type { Adapter, AbortSignalLike } from "../protocol/adapter.js";
import type { Event, StopReason, StructuredError, Terminal, ToolCallEnd } from "../protocol/events.js";
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
import { denialResult } from "./permission.js";
import { messagesToEvents, projectMessages } from "./project.js";

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
	readonly signal?: AbortSignalLike;
	readonly temperature?: number;
	readonly maxTokens?: number;
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
	// This is a live per-run transform, not part of the projection — the log
	// keeps the original input; session-level rewrite policy (Phase C) writes
	// the rewritten input into the log instead.
	let messages = derive();
	if (hooks.onUserMessage && messages.length > 0) {
		const last = messages.at(-1);
		if (last?.role === "user") {
			const rewritten = await hooks.onUserMessage(last, {});
			if (rewritten !== null) {
				messages = [...messages.slice(0, -1), rewritten];
			}
		}
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

		// ── Auto-compaction: recorded as an event, applied by the projection ─
		if (config.compaction && estimateTokens(messages) > config.compaction.thresholdTokens) {
			if (hooks.onPreCompact) await hooks.onPreCompact(messages, {}).catch(() => {});
			const cleared = microcompact(messages).clearedCallIds;
			if (cleared.length > 0) {
				const full = log.append({ type: "compacted", clearedCallIds: cleared });
				if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
				yield full;
				messages = derive();
				if (hooks.onPostCompact) await hooks.onPostCompact(messages, {}).catch(() => {});
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
		let streamed = false;
		let attempts = 0;

		while (true) {
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
					if (ev.type === "stop") lastStop = ev.reason;
					if (ev.type === "tool_call_end") pending.push(ev);
					const full = log.append(ev);
					if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
					yield full;
				}
				break;
			} catch (err) {
				const structured = toStructuredError(err);
				// Phase B: never silently re-stream a turn that already
				// emitted content — duplicates are worse than failures.
				if (structured.retryable && !streamed && attempts < maxRetries) {
					attempts += 1;
					await sleep(attempts * 250); // backoff lives in the frame
					continue;
				}
				yield await terminal({ kind: "error", error: structured });
				return;
			}
		}

		// ── Terminal check: no tool call this turn → done, honestly ────────
		if (pending.length === 0) {
			yield await terminal(terminalForStop(lastStop));
			return;
		}

		// ── Abort check before side effects: a stop landing during the
		//    model turn must never let the pending tools run ────────────────
		if (aborted()) {
			yield await terminal({ kind: "aborted", by: "user" });
			return;
		}

		// ── Execute: validate + permission + handler, batched by safety ────
		const results = await executeCalls(pending, registry, hooks, {
			signal: signal ?? NEVER_ABORT,
		});

		for (const { callId, result } of results) {
			const full = log.append({
				type: "tool_result",
				callId,
				content: result.content,
				isError: result.isError,
				...(result.errorKind ? { errorKind: result.errorKind } : {}),
			});
			if (hooks.onEvent) await hooks.onEvent(full, {}).catch(() => {});
			yield full;
		}

		// ── Advance history: the log grew; re-derive for the next turn ─────
		messages = derive();
	}
}

/**
 * The terminal for a turn that stopped without tool calls — mapped from the
 * provider's OWN stop reason, never blanket `completed` (Phase B).
 */
function terminalForStop(reason: StopReason | undefined): Terminal {
	switch (reason) {
		case "max_tokens":
			return { kind: "max_tokens" };
		case "abort":
			return { kind: "aborted", by: "user" };
		case "error":
			return { kind: "error", error: { code: "unknown", retryable: false, message: "provider stopped with an error" } };
		default:
			return { kind: "completed" };
	}
}

// ── Execution ──────────────────────────────────────────────────────────

interface ExecutedCall {
	readonly callId: string;
	readonly result: ToolResult;
}

/**
 * Batch execution with CC's per-call concurrency predicate: `concurrencySafe`
 * is decided on INPUT, not per tool — the same tool may be parallel-safe for
 * one call and serial for another (visual generation with a chain reference).
 * Safe calls within a window run concurrently; a serial call drains the
 * window first. Results always come back in call order.
 */
async function executeCalls(
	calls: readonly ToolCallEnd[],
	registry: ToolRegistry,
	hooks: HookHost,
	ctx: ToolContext,
): Promise<ExecutedCall[]> {
	const run = (call: ToolCallEnd) => executeOne(call, registry, hooks, ctx);
	const results: ExecutedCall[] = [];
	let window: ToolCallEnd[] = [];

	for (const call of calls) {
		const tool = registry.get(call.name);
		const safe = tool?.concurrencySafe ? tool.concurrencySafe(call.input ?? {}) : true;
		if (safe) {
			window.push(call);
			continue;
		}
		results.push(...(await Promise.all(window.map(run))));
		results.push(await run(call));
		window = [];
	}
	if (window.length > 0) {
		results.push(...(await Promise.all(window.map(run))));
	}
	return results;
}

async function executeOne(
	call: ToolCallEnd,
	registry: ToolRegistry,
	hooks: HookHost,
	ctx: ToolContext,
): Promise<ExecutedCall> {
	const payload: ToolCallPayload = {
		callId: call.callId,
		name: call.name,
		input: call.input ?? {},
	};

	// Unknown tool or unparseable args — refuse before anything runs.
	const tool: Tool | undefined = registry.get(call.name);
	if (!tool) {
		return {
			callId: call.callId,
			result: {
				content: `Unknown tool: ${call.name}`,
				isError: true,
				errorKind: "invalid_input",
			},
		};
	}
	if (call.input === null) {
		return {
			callId: call.callId,
			result: {
				content: "Arguments failed to parse as JSON",
				isError: true,
				errorKind: "invalid_input",
			},
		};
	}

	// Phase B: real JSON Schema validation — the handler never sees garbage.
	const schemaError = validateArgs(tool.parameters, call.input);
	if (schemaError !== null) {
		return {
			callId: call.callId,
			result: {
				content: `Arguments failed schema validation:${schemaError}`,
				isError: true,
				errorKind: "invalid_input",
			},
		};
	}

	// Permission negotiation.
	if (hooks.onPreTool) {
		const decision = await hooks.onPreTool(payload, ctx);
		if (decision.action !== "allow") {
			const reason = decision.reason ?? (decision.action === "defer" ? "awaiting user approval" : "denied");
			return { callId: call.callId, result: denialResult(reason) };
		}
	}

	// The handler. A thrown error is a fatal classification, never a crash.
	let result: ToolResult;
	try {
		result = await tool.execute(call.input, ctx);
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
	return { callId: call.callId, result };
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A signal that never aborts — for executions outside any abort scope. */
const NEVER_ABORT = {
	aborted: false,
	addEventListener: () => {},
	removeEventListener: () => {},
} satisfies AbortSignalLike;

export type { EventInput, AssistantBlock, AssistantMessage, Message, ToolResultMessage };
