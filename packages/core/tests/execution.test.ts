/**
 * Phase D — durable approvals and exactly-once execution guards.
 *
 * The ledger lives in the event log (ADR-0002): every tool execution writes
 * `tool_execution_started` BEFORE the side effect and
 * `tool_execution_succeeded` / `tool_execution_failed` after. `defer` is a
 * REAL pause — the run yields `permission_requested`, waits for a human
 * decision, persists it, and resumes the same frame.
 *
 * Safety rules pinned here:
 * - a confirmed-successful execution is never repeated for the same tool
 *   and input (non-idempotent tools);
 * - an interrupted execution (started without a result) is UNCERTAIN: it
 *   blocks with a precondition result, never auto-runs;
 * - the abort signal reaches the running tool via ctx.signal.
 */

import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event, TerminalEvent } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { EventLog, loop } from "../src/index.js";
import { executionLedger, latestExecutionFor } from "../src/kernel/ledger.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider, type FauxScript } from "@kiso/evals";

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

describe("the execution ledger", () => {
	it("writes started → succeeded → tool_result, in that order, around the handler", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool());
		const log = new EventLog();
		const events = await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		const types = log.all.filter((e) => ["tool_execution_started", "tool_execution_succeeded", "tool_result"].includes(e.type)).map((e) => e.type);
		expect(types).toEqual(["tool_execution_started", "tool_execution_succeeded", "tool_result"]);
		// The consumer saw them too.
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(true);
	});

	it("writes tool_execution_failed for an error result", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "boom",
				description: "Boom",
				parameters: { type: "object" },
				execute: async () => ({ content: "exploded", isError: true, errorKind: "fatal" as const }),
			}),
		);
		const log = new EventLog();
		await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "boom", input: {} }] }],
			registry,
			log,
		);
		const ledger = executionLedger(log.all);
		expect(ledger.get("c1")?.status).toBe("failed");
	});

	it("a confirmed-successful execution is never repeated for the same tool+input", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		// Prior run: the tool succeeded with {query:"k"}.
		await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		expect(executed).toBe(1);

		// New run: the model re-issues the SAME call (e.g. after a crash the
		// tool_result never reached the model). The guard must replay the
		// recorded result, not run the side effect again.
		const events = await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c9", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		expect(executed).toBe(1); // NOT 2
		const result = events.find((e) => e.type === "tool_result" && e.callId === "c9");
		expect(result).toMatchObject({ isError: false, content: "results for k" });
	});

	it("idempotent tools may run the same input again", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1), idempotent: true }));
		const log = new EventLog();
		await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] }],
			registry,
			log,
		);
		await runWithLog(
			[{ events: [{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "k" } }] }],
			registry,
			log,
		);
		expect(executed).toBe(2);
	});

	it("an interrupted execution (started, no result) is UNCERTAIN: blocked, never auto-run", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		// A crashed run: the started event is durable, the result never came.
		log.append({ type: "tool_execution_started", callId: "c1", name: "web_search", input: { query: "k" } });

		const events = await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
		);
		expect(executed).toBe(0);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect((result as { content: string }).content).toMatch(/uncertain|interrupted|human/i);
	});

	it("latestExecutionFor reports the durable status of a tool+input", () => {
		const log = new EventLog();
		log.append({ type: "tool_execution_started", callId: "c1", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_execution_succeeded", callId: "c1", result: { content: "ok", isError: false } });
		const record = latestExecutionFor(log.all, "web_search", { query: "k" });
		expect(record?.status).toBe("succeeded");
		expect(record?.result?.content).toBe("ok");
	});
});

describe("defer is a real pause, not a disguised deny", () => {
	it("pauses the run, persists the request, resumes the SAME run on approval", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		const decisions = new Map<string, import("../src/kernel/permission.js").PermissionDecision>();
		// The real resolver waits for the human — like session.approve.
		const resolveApproval = async (decisionId: string) => {
			while (!decisions.has(decisionId)) await new Promise((r) => setTimeout(r, 5));
			return decisions.get(decisionId)!;
		};

		const events: Event[] = [];
		let seenRequest: { decisionId: string; callId: string; name: string } | undefined;
		const gen = loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [USER],
			resolveApproval,
			hooks: {
				onPreTool: async (call) => ({ action: "defer" as const }),
			},
		});
		for await (const ev of gen) {
			events.push(ev);
			if (ev.type === "permission_requested") {
				seenRequest = ev;
				decisions.set(ev.decisionId, { action: "allow" }); // the human approves
			}
		}

		expect(seenRequest).toBeDefined();
		expect(seenRequest?.callId).toBe("c1");
		expect(executed).toBe(1);
		// The decision was persisted between the request and the result.
		const types = log.all.map((e) => e.type);
		expect(types.indexOf("permission_requested")).toBeLessThan(types.indexOf("permission_decided"));
		expect(types.indexOf("permission_decided")).toBeLessThan(types.indexOf("tool_execution_started"));
		expect(terminalOf(events).outcome.kind).toBe("completed");
		// The generator that paused IS the generator that finished — one run.
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
	});

	it("a denied approval is an honest precondition result — no execution", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [USER],
			resolveApproval: async () => ({ action: "deny", reason: "user said no" }),
			hooks: {
				onPreTool: async () => ({ action: "defer" as const }),
			},
		})) {
			events.push(ev);
		}
		expect(executed).toBe(0);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect((result as { content: string }).content).toMatch(/user said no/);
		expect(log.all.some((e) => e.type === "permission_decided" && e.decision === "denied")).toBe(true);
	});

	it("defer without an approval channel degrades to an honest denial, not a crash", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(searchTool({ executed: () => (executed += 1) }));
		const log = new EventLog();
		const events = await runWithLog(
			[
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			log,
			{ hooks: { onPreTool: async () => ({ action: "defer" as const }) } },
		);
		expect(executed).toBe(0);
		expect(terminalOf(events).outcome.kind).toBe("completed");
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(true);
	});
});

describe("abort reaches the running tool", () => {
	it("ctx.signal is the run's signal — the tool can see the abort", async () => {
		const registry = new ToolRegistry();
		let sawAbort = false;
		registry.register(
			defineTool({
				name: "slow",
				description: "Slow",
				parameters: { type: "object" },
				execute: async (_input, ctx) => {
					// A long-running side effect that checks the signal as it
					// goes. The consumer aborts WHILE this is executing.
					await new Promise<void>((resolve) => setTimeout(resolve, 40));
					sawAbort = ctx.signal.aborted;
					return { content: "stopped", isError: true, errorKind: "fatal" as const };
				},
			}),
		);
		const ac = new AbortController();
		const events: Event[] = [];
		const gen = loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "slow", input: {} }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [USER],
			signal: ac.signal,
		});
		for await (const ev of gen) {
			events.push(ev);
			if (ev.type === "tool_execution_started") ac.abort();
		}
		expect(sawAbort).toBe(true);
	});
});

describe("guard helpers", () => {
	it("resolution rerun clears the uncertain block for the next execution", () => {
		const log = new EventLog();
		log.append({ type: "tool_execution_started", callId: "c1", name: "web_search", input: { query: "k" } });
		expect(latestExecutionFor(log.all, "web_search", { query: "k" })?.status).toBe("uncertain");
		log.append({ type: "tool_execution_resolved", callId: "c1", resolution: "rerun" });
		expect(latestExecutionFor(log.all, "web_search", { query: "k" })?.status).toBe("rerun");
		log.append({ type: "tool_execution_started", callId: "c2", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_execution_resolved", callId: "c2", resolution: "abandoned" });
		expect(latestExecutionFor(log.all, "web_search", { query: "k" })?.status).toBe("abandoned");
	});
});
