/**
 * Area 3 + 4 — execution identity and cancellation.
 *
 * IDENTITY: every execution carries a framework-generated `executionId`
 * (persistent, unique per log); the provider's callId is correlation only.
 * A new logical call with identical (name, input) is a NEW execution and
 * runs normally — exactly-once is enforced by receipt repair and human
 * decisions on uncertain executions, never by swallowing repeats. A failed
 * non-idempotent execution is UNCERTAIN (side effects may have happened);
 * only a tool that proved safe-to-retry gets a clean failure.
 *
 * CANCELLATION: the one signal reaches the retry backoff, the approval
 * wait, every pending tool, and the SDK; an abort during the approval wait
 * ends the run and a later approve() never executes; an abort after the
 * first tool never starts a sibling.
 */

import { describe, expect, it } from "vitest";
import { EventLog, loop, defineTool, ToolRegistry, type Adapter, type AbortSignalLike, type Event, type TerminalEvent, type Message, type Tool } from "@vincemakes/kiso-core";
import { executionForCallId, executionLedger } from "../src/ledger.js";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";

const USER: Message = { role: "user", content: "go" };

function searchTool(opts: { executed?: () => void; idempotent?: boolean } = {}): Tool<{ query: string }> {
	return defineTool({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } } },
		...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
		execute: async (input: { query: string }) => {
			opts.executed?.();
			return { content: `results for ${input.query}`, isError: false };
		},
	});
}

async function runWithLog(
	script: FauxScript,
	registry: ToolRegistry,
	log: EventLog,
	opts: Partial<Parameters<typeof loop>[0]> = {},
): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux",
		registry,
		log,
		messages: [USER],
		...opts,
	})) {
		events.push(ev);
	}
	return events;
}

const terminalOf = (events: readonly Event[]) =>
	events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

describe("execution identity (Area 3)", () => {
	it("every execution carries a unique executionId; callId is correlation only", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool());
		const log = new EventLog();
		await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		const started = log.all.filter((e) => e.type === "tool_execution_started");
		expect(started).toHaveLength(1);
		const exId = (started[0] as { executionId: string }).executionId;
		expect(exId).toMatch(/^ex-\d+$/);
		const succeeded = log.all.find((e) => e.type === "tool_execution_succeeded");
		expect((succeeded as { executionId: string } | undefined)?.executionId).toBe(exId);
	});

	it("the same tool+input issued TWICE is two logical calls — both execute", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		expect(executed).toBe(2);
		const ids = log.all.filter((e) => e.type === "tool_execution_started").map((e) => (e as { executionId: string }).executionId);
		expect(new Set(ids).size).toBe(2);
	});

	it("a duplicate provider callId is two executions, not one replayed", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		// Same callId twice — a provider glitch or a re-issued call reusing
		// an id. The ledger must not conflate them.
		await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "a" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "b" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		expect(executed).toBe(2);
		expect(executionForCallId(log.all, "c1")?.status).toBe("succeeded");
	});

	it("a failed NON-idempotent execution is a clean failure carrying the honest note — no uncertain pause (ruling #12; supersedes the C group pause, ADR-0038)", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "write_file",
				description: "Write",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				execute: async () => ({ content: "failed after writing", isError: true, errorKind: "fatal" as const }),
			}),
		);
		const log = new EventLog();
		const events = await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "write_file", input: { path: "x" } }, { type: "stop", reason: "tool_use" }] }],
			registry,
			log,
		);
		// No pause: the receipt IS the outcome — the model got the ✗ and may
		// retry (a retry is a NEW call: it passes the approval chain again).
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false);
		// The result carries the honest note about partial side effects.
		const result = events.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		expect(result).toBeDefined();
		expect(String(result!.content)).toContain(
			"[non-idempotent tool failed — its side effects may have partially applied; verify before retrying]",
		);
		// The ledger records a plain failure — never abandoned, never bricked.
		expect(executionForCallId(log.all, "c1")?.status).toBe("failed");
	});

	it("a failed IDEMPOTENT execution is a clean failure — safe to retry, and NO note (nothing may have applied)", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "read_file",
				description: "Read",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				idempotent: true,
				execute: async () => ({ content: "read failed", isError: true, errorKind: "fatal" as const }),
			}),
		);
		const log = new EventLog();
		const events = await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "x" } }, { type: "stop", reason: "tool_use" }] }],
			registry,
			log,
		);
		const record = executionForCallId(log.all, "c1");
		expect(record?.status).toBe("failed");
		const result = events.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		expect(result).toBeDefined();
		expect(String(result!.content)).not.toContain("non-idempotent tool failed");
	});

	it("a THROW from a non-idempotent handler is a clean failure with the note — never a pause (ruling #12)", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "shell",
				description: "Shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				execute: async () => {
					throw new Error("exited 137");
				},
			}),
		);
		const log = new EventLog();
		const events = await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "make" } }, { type: "stop", reason: "tool_use" }] }],
			registry,
			log,
		);
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false);
		const result = events.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		expect(String(result!.content)).toContain("non-idempotent tool failed");
		expect(executionForCallId(log.all, "c1")?.status).toBe("failed");
	});

	it("ledger helpers report statuses and resolutions by executionId", () => {
		const log = new EventLog();
		log.append({ type: "tool_execution_started", executionId: "ex-0", callId: "c1", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_execution_failed", executionId: "ex-0", callId: "c1", error: "boom", safeToRetry: false });
		// ruling #12: a complete receipt is the outcome — failed is failed,
		// never uncertain; uncertainty belongs to the crash window alone.
		expect(executionLedger(log.all).get("ex-0")?.status).toBe("failed");
		log.append({ type: "tool_execution_resolved", executionId: "ex-0", callId: "c1", resolution: "rerun" });
		expect(executionLedger(log.all).get("ex-0")?.status).toBe("rerun");
		log.append({ type: "tool_execution_started", executionId: "ex-1", callId: "c2", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_execution_resolved", executionId: "ex-1", callId: "c2", resolution: "abandoned" });
		expect(executionLedger(log.all).get("ex-1")?.status).toBe("abandoned");
	});
});

describe("abort boundaries (Area 4)", () => {
	it("an abort during retry backoff ends the run immediately, not after the wait", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool());
		const ac = new AbortController();
		const flaky: Adapter = {
			stream: async function* () {
				throw { code: "overloaded", status: 529, retryable: true, message: "overloaded" };
			},
		};
		const events: Event[] = [];
		const gen = loop({
			adapter: flaky,
			model: "faux",
			registry,
			messages: [USER],
			maxRetries: 5,
			signal: ac.signal,
		});
		const startedAt = Date.now();
		// Abort after the first retry wait begins (the first throw is instant).
		setTimeout(() => ac.abort(), 30);
		for await (const ev of gen) events.push(ev);
		expect(Date.now() - startedAt).toBeLessThan(1500); // far below 5 backoffs
		expect(terminalOf(events).outcome.kind).toBe("aborted");
	});

	it("an abort during the approval pause ends the run; a later approve never executes", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		const ac = new AbortController();
		let approveLater: (() => void) | undefined;
		const resolveApproval = async (_decisionId: string) =>
			new Promise<import("../src/kernel/permission.js").PermissionDecision>((resolve) => {
				approveLater = () => resolve({ action: "allow" });
			});
		const events: Event[] = [];
		const gen = loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [USER],
			signal: ac.signal,
			resolveApproval,
			hooks: { onPreTool: async () => ({ action: "defer" as const }) },
		});
		for await (const ev of gen) {
			events.push(ev);
			if (ev.type === "permission_requested") ac.abort();
		}
		expect(terminalOf(events).outcome).toEqual({ kind: "aborted", by: "user" });
		// The request is still durable and unanswered; a late approval must
		// NOT execute the tool in this run.
		approveLater?.();
		await new Promise((r) => setTimeout(r, 10));
		expect(executed).toBe(0);
		expect(log.all.some((e) => e.type === "permission_decided")).toBe(false);
	});

	it("an abort mid-run never lets a not-yet-started sibling begin (0.1.26: the signal gates the decide)", async () => {
		const registry = new ToolRegistry();
		const order: string[] = [];
		registry.register(
			defineTool({
				name: "first",
				description: "First",
				parameters: { type: "object" },
				execute: async (_input, ctx) => {
					order.push("first:start");
					await new Promise((r) => setTimeout(r, 30));
					order.push(`first:end aborted=${ctx.signal.aborted}`);
					return { content: "first", isError: false };
				},
			}),
		);
		registry.register(
			defineTool({
				name: "second",
				description: "Second",
				parameters: { type: "object" },
				execute: async () => {
					order.push("second:start");
					return { content: "second", isError: false };
				},
			}),
		);
		// 0.1.26 (streaming execution): BOTH calls launch at tool_call_end — the abort
		// cannot un-launch the sibling. The guarantee moved to the SIGNAL:
		// a sibling whose DECIDE is still in flight when the abort lands
		// (a slow policy here) bails before its started event — never a
		// side effect after the cancel.
		const ac = new AbortController();
		const events: Event[] = [];
		const gen = loop({
			adapter: createFauxProvider([
				{
					events: [
						{ type: "tool_call_end", callId: "a", name: "first", input: {} },
						{ type: "tool_call_end", callId: "b", name: "second", input: {} },

				{ type: "stop", reason: "tool_use" }],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [USER],
			signal: ac.signal,
			// The kernel sees the composed chain (the runtime's composition) —
			// here a single slow policy deciding per call.
			approvalPolicy: {
				decide: async (payload: { name: string }) => {
					if (payload.name === "second") await new Promise((r) => setTimeout(r, 50));
					return { action: "allow" as const, decidedBy: "slow-decide" };
				},
			},
		});
		// Abort WHILE the first handler is running (after it started) — the
		// sibling's decide (the slow policy) is still in flight: the abort
		// races it (raceAbort), the sibling bails before its started event.
		setTimeout(() => ac.abort(), 10);
		for await (const ev of gen) {
			events.push(ev);
		}
		expect(order).toContain("first:start");
		expect(order).toContain("first:end aborted=true"); // the handler SAW the signal
		expect(order).not.toContain("second:start"); // the sibling never began
		expect(terminalOf(events).outcome.kind).toBe("aborted");
	});

	it("an SDK user-cancel surfaces as an aborted terminal, not a generic error", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool());
		const ac = new AbortController();
		const canceling: Adapter = {
			stream: async function* () {
				// The SDK throws its user-abort error after the signal fires.
				await new Promise<void>((resolve) => {
					ac.signal.addEventListener("abort", () => resolve());
				});
				throw new Error("Request was aborted");
			},
		};
		const events: Event[] = [];
		const gen = loop({
			adapter: canceling,
			model: "faux",
			registry,
			messages: [USER],
			signal: ac.signal,
		});
		setTimeout(() => ac.abort(), 20);
		for await (const ev of gen) events.push(ev);
		expect(terminalOf(events).outcome).toEqual({ kind: "aborted", by: "user" });
	});
});

describe("defer is a real pause (regression)", () => {
	it("pauses, persists the request, resumes the SAME run on approval", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		const decisions = new Map<string, import("../src/kernel/permission.js").PermissionDecision>();
		const resolveApproval = async (decisionId: string) => {
			while (!decisions.has(decisionId)) await new Promise((r) => setTimeout(r, 5));
			return decisions.get(decisionId)!;
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [USER],
			resolveApproval,
			hooks: { onPreTool: async () => ({ action: "defer" as const }) },
		})) {
			events.push(ev);
			if (ev.type === "permission_requested") decisions.set(ev.decisionId, { action: "allow" });
		}
		expect(executed).toBe(1);
		expect(terminalOf(events).outcome.kind).toBe("completed");
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
	});
});
