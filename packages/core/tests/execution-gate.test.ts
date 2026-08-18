/**
 * C group — the execution gate.
 *
 * C1: NO tool runs unless the provider turn is well-formed: exactly one
 * stop, and the stop reason is compatible with a complete tool call.
 * C3: a failed NON-idempotent execution enters a persistent uncertain
 * PAUSE — no next model turn, no sibling tool, no auto-retry until a
 * human resolves it (no channel = recorded as abandoned, never retried).
 * C4: onUserMessage null truly vetoes; a rewrite becomes the ONLY fact
 * later turns see.
 */

import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event, TerminalEvent } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { EventLog, loop } from "../src/index.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";

const USER: Message = { role: "user", content: "go" };

function registryWith(opts: { fail?: boolean; idempotent?: boolean; executed?: () => void } = {}) {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "web_search",
			description: "Search",
			parameters: { type: "object", properties: { query: { type: "string" } } },
			...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
			execute: async () => {
				opts.executed?.();
				return opts.fail
					? { content: "failed after side effect", isError: true, errorKind: "fatal" as const }
					: { content: "ok", isError: false };
			},
		}),
	);
	return registry;
}

const terminalOf = (events: readonly Event[]) =>
	events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

describe("C1: the turn is verified BEFORE any tool runs", () => {
	async function runTurn(script: FauxScript, registry: ToolRegistry): Promise<readonly Event[]> {
		const events: Event[] = [];
		for await (const ev of loop({ adapter: createFauxProvider(script), model: "faux", registry, messages: [USER] })) {
			events.push(ev);
		}
		return events;
	}

	it("a tool call WITHOUT a stop never executes — the turn is malformed", async () => {
		const registry = registryWith({ executed: () => void 0 });
		const events = await runTurn([{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }] }], registry);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(terminalOf(events).outcome).toMatchObject({ kind: "error", error: { code: "invalid_request" } });
	});

	// ── EC-1, the SCHEDULER-TIMING CLASS ───────────────────────────────────
	// The three cases below are declared members of the timing class: each
	// PINNED the 0.1.26 streaming launch, and each asserted that an
	// INCOMPATIBLE turn had already produced its side effect by the time the
	// kernel learned the turn was invalid. That was this file's standing
	// embarrassment — the describe block promises "the turn is verified
	// BEFORE any tool runs" and the assertions said otherwise.
	//
	// EC-1 makes the promise true. The stop is held until the stream is
	// exhausted AND structurally compatible (Turn Commit); a commit-required
	// handler waits for that commit (invariant 3). An incompatible stop
	// therefore voids the turn while its calls are still only intent — the
	// verdicts below flip from "it ran anyway" to "it never ran", and the
	// terminal each turn produces is UNCHANGED.

	it("stop max_tokens with a pending call: the call NEVER runs — the turn never commits", async () => {
		let executed = 0;
		const registry = registryWith({
			executed: () => {
				executed += 1;
			},
		});
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "max_tokens" }] }],
			registry,
		);
		// EC-1: max_tokens cannot carry a tool call, so the turn never commits
		// — and an uncommitted turn never starts a commit-required handler.
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(false);
		// The stop itself is never durable: an uncommitted turn leaves none.
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("stop refusal with a pending call: the call NEVER runs — the turn never commits", async () => {
		let executed = 0;
		const registry = registryWith({
			executed: () => {
				executed += 1;
			},
		});
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "refusal" }] }],
			registry,
		);
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(false);
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(terminalOf(events).outcome.kind).toBe("error");
	});

	it("stop end_turn with a pending call is contradictory — the call NEVER runs", async () => {
		let executed = 0;
		const registry = registryWith({
			executed: () => {
				executed += 1;
			},
		});
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "end_turn" }] }],
			registry,
		);
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(false);
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(terminalOf(events).outcome.kind).toBe("error");
	});

	it("stop tool_use with a complete call executes normally", async () => {
		const registry = registryWith({ executed: () => void 0 });
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] }],
			registry,
		);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(true);
	});
});

describe("C3: a failed execution is a clean failure — the approval chain guards retries (ruling #12, ADR-0038)", () => {
	it("a failure does NOT pause its siblings — the pending list runs on, the model retries", async () => {
		const registry = new ToolRegistry();
		const order: string[] = [];
		registry.register(
			defineTool({
				name: "first",
				description: "First",
				parameters: { type: "object" },
				execute: async () => {
					order.push("first");
					return { content: "failed after side effect", isError: true, errorKind: "fatal" as const };
				},
			}),
		);
		registry.register(
			defineTool({
				name: "second",
				description: "Second",
				parameters: { type: "object" },
				execute: async () => {
					order.push("second");
					return { content: "ok", isError: false };
				},
			}),
		);
		const log = new EventLog();
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{
					events: [
						{ type: "tool_call_end", callId: "a", name: "first", input: {} },
						{ type: "tool_call_end", callId: "b", name: "second", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [USER],
		})) {
			events.push(ev);
		}
		expect(order).toEqual(["first", "second"]); // the sibling RAN — no pause, no auto-retry block
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false);
		expect(terminalOf(events).outcome.kind).toBe("completed");
	});

	it("no channel, no verdict — the failure is simply recorded failed, never abandoned", async () => {
		const registry = new ToolRegistry();
		let executed = 0;
		registry.register(
			defineTool({
				name: "shell",
				description: "Shell",
				parameters: { type: "object" },
				execute: async () => {
					executed += 1;
					return { content: "exited 1", isError: true, errorKind: "fatal" as const };
				},
			}),
		);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "a", name: "shell", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			messages: [USER],
		})) {
			events.push(ev);
		}
		expect(executed).toBe(1); // one attempt; a retry would be a NEW call through the approval chain
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false);
		expect(terminalOf(events).outcome.kind).toBe("completed");
	});
});

describe("C4: onUserMessage veto and rewrite are the only facts later turns see", () => {
	it("null truly vetoes — the model never receives the message", async () => {
		const registry = new ToolRegistry();
		const seen: Message[][] = [];
		const base = createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]);
		const adapter: Adapter = {
			stream: (opts) => {
				seen.push([...opts.messages]);
				return base.stream(opts);
			},
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter,
			model: "faux",
			registry,
			messages: [USER],
			hooks: { onUserMessage: async () => null },
		})) {
			events.push(ev);
		}
		// A true veto leaves nothing to process: the model is never called.
		expect(seen).toHaveLength(0);
		expect(terminalOf(events).outcome.kind).toBe("completed");
	});

	it("a rewrite replaces the original for the WHOLE run — later turns see only the rewritten fact", async () => {
		const registry = new ToolRegistry();
		const seen: Message[][] = [];
		const base = createFauxProvider([
			{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		]);
		const adapter: Adapter = {
			stream: (opts) => {
				seen.push([...opts.messages]);
				return base.stream(opts);
			},
		};
		for await (const _ev of loop({
			adapter,
			model: "faux",
			registry,
			messages: [{ role: "user", content: "original" }],
			hooks: {
				onUserMessage: async (msg) => ({ ...msg, content: "rewritten-fact" }),
			},
		})) {
			// drain
		}
		// Every adapter call sees the rewritten fact, never the original.
		for (const messages of seen) {
			const userTexts = messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);
			expect(userTexts).not.toContain("original");
			expect(userTexts).toContain("rewritten-fact");
		}
	});
});
