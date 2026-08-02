/**
 * L2 — the ReAct loop. The kernel's only loop; everything else is harness.
 *
 * An async generator that yields every event as it happens (never buffers a
 * turn into a list — the agno failure), and converges on exactly one
 * `terminal` event per run (ADR-0004).
 *
 * Per iteration:
 *   assemble (onUserMessage / onPreLlm)
 *     → adapter.stream(): events yielded straight through, tool calls collected
 *     → execute: permission (onPreTool) → handler → rewrite (onPostTool),
 *       concurrency-safe calls batched parallel, the rest serial
 *     → tool_result events appended, messages advanced
 *   no tool calls / maxTurns / abort → terminal event, return
 *
 * Retry lives HERE and only here (ADR-0005): a retryable StructuredError
 * from the adapter is retried with backoff inside the generator frame — no
 * promise handed to a side channel that can leak or desync. All mutable
 * state (attempts, turns, messages) is local to the frame.
 */

import type { Adapter } from "../protocol/adapter";
import type { Event, StructuredError, Terminal, ToolCallEnd } from "../protocol/events";
import type { EventInput } from "./event-log";

/** Zero-dependency sleep: the kernel must not import host globals (ADR-0001). */
declare function setTimeout(cb: () => void, ms: number): unknown;
import type {
	AssistantBlock,
	AssistantMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "../protocol/messages";
import type { Tool, ToolContext, ToolResult } from "../tools/tool";
import { ToolRegistry } from "../tools/registry";
import { EventLog } from "./event-log";
import type { HookHost, ToolCallPayload } from "./hooks";
import { NoOpHooks } from "./hooks";
import type { ModeProfile } from "./mode";
import { resolveModeProfile } from "./mode";
import { denialResult } from "./permission";

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
	readonly messages?: readonly Message[];
	readonly signal?: import("../protocol/adapter").AbortSignalLike;
	readonly temperature?: number;
	readonly maxTokens?: number;
}

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_RETRIES = 2;

export async function* loop(config: LoopConfig): AsyncGenerator<Event> {
	const log = new EventLog();
	const hooks: HookHost = config.hooks ?? NoOpHooks;
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
	const signal = config.signal;
	const mode = resolveModeProfile(config.modes, config.mode);
	const registry =
		mode?.visibleToolNames !== undefined
			? config.registry.subset(mode.visibleToolNames)
			: config.registry;

	let messages: readonly Message[] = [...(config.messages ?? [])];

	const terminal = (outcome: Terminal): Event => log.append({ type: "terminal", outcome });
	const aborted = (): boolean => signal?.aborted === true;

	// Assemble: the incoming user message may be rewritten or vetoed.
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
			yield terminal({ kind: "aborted", by: "user" });
			return;
		}
		if (turns >= maxTurns) {
			yield terminal({ kind: "max_turns", turns });
			return;
		}
		turns += 1;

		if (hooks.onPreLlm) await hooks.onPreLlm({ model: config.model, turns }, {});
		if (aborted()) {
			yield terminal({ kind: "aborted", by: "user" });
			return;
		}

		// ── Model turn: stream events through, collect tool calls ──────────
		const pending: ToolCallEnd[] = [];
		let textBuffer = "";
		let attempts = 0;
		let streamed = false;

		while (true) {
			try {
				const stream = config.adapter.stream({
					model: config.model,
					messages,
					tools: registry.toSpecs(),
					...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
					...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
					...(signal !== undefined ? { signal } : {}),
				});
				for await (const ev of stream) {
					streamed = true;
					if (hooks.onEvent) await hooks.onEvent(ev, {}).catch(() => {});
					const full = log.append(ev);
					yield full;
					if (ev.type === "text_delta") textBuffer += ev.text;
					if (ev.type === "tool_call_end") pending.push(ev);
				}
				break;
			} catch (err) {
				const structured = toStructuredError(err);
				if (structured.retryable && attempts < maxRetries) {
					attempts += 1;
					await sleep(attempts * 250); // backoff lives in the frame
					continue;
				}
				yield terminal({ kind: "error", error: structured });
				return;
			}
		}

		// ── Terminal check: no tool call this turn → done ──────────────────
		if (pending.length === 0) {
			yield terminal({ kind: "completed" });
			return;
		}

		// ── Execute: concurrency-safe calls batched parallel, rest serial ──
		const results = await executeCalls(pending, registry, hooks, {
			signal: signal ?? NEVER_ABORT,
		});

		for (const { callId, result } of results) {
			yield log.append({
				type: "tool_result",
				callId,
				content: result.content,
				isError: result.isError,
				...(result.errorKind ? { errorKind: result.errorKind } : {}),
			});
		}

		// ── Advance history: assistant turn + tool results ─────────────────
		messages = appendTurn(messages, textBuffer, pending, results);
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

// ── History advancement ─────────────────────────────────────────────────

function appendTurn(
	messages: readonly Message[],
	text: string,
	calls: readonly ToolCallEnd[],
	results: readonly ExecutedCall[],
): readonly Message[] {
	const blocks: AssistantBlock[] = [];
	if (text !== "") {
		blocks.push({ type: "text", text });
	}
	for (const call of calls) {
		blocks.push({
			type: "tool_use",
			callId: call.callId,
			name: call.name,
			input: call.input ?? {},
		});
	}
	const assistant: AssistantMessage = { role: "assistant", blocks };
	const toolMessages: ToolResultMessage[] = results.map((r) => ({
		role: "tool",
		callId: r.callId,
		content: r.result.content,
		isError: r.result.isError,
	}));
	return [...messages, assistant, ...toolMessages];
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
} satisfies import("../protocol/adapter").AbortSignalLike;
