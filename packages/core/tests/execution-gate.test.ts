/**
 * C 组 — the execution gate.
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

	it("stop max_tokens with a pending call never executes the tool", async () => {
		const registry = registryWith({ executed: () => void 0 });
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "max_tokens" }] }],
			registry,
		);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("stop refusal with a pending call never executes the tool", async () => {
		const registry = registryWith({ executed: () => void 0 });
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "refusal" }] }],
			registry,
		);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(terminalOf(events).outcome.kind).toBe("error");
	});

	it("stop end_turn with a pending call is contradictory — error, no execution", async () => {
		const registry = registryWith({ executed: () => void 0 });
		const events = await runTurn(
			[{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "end_turn" }] }],
			registry,
		);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
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

describe("C3: a failed non-idempotent execution is a persistent uncertain pause", () => {
	it("pauses for a human decision; no sibling runs, no auto-retry, the next model turn waits", async () => {
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
		const decisions: string[] = [];
		const resolveUncertainty = async (executionId: string) => {
			while (decisions.length === 0) await new Promise((r) => setTimeout(r, 5));
			return decisions.shift()! as "rerun" | "abandoned";
		};
		const events: Event[] = [];
		const gen = loop({
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
			resolveUncertainty,
		});
		for await (const ev of gen) {
			events.push(ev);
			if (ev.type === "uncertain_pending") {
				// The human is asked; meanwhile no sibling may run.
				expect(order).toEqual(["first"]);
				decisions.push("abandoned");
			}
		}
		expect(order).toEqual(["first"]); // sibling NEVER ran
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(true);
		expect(terminalOf(events).outcome.kind).toBe("completed"); // next model turn resumed after the verdict
		// The pause is durable in the log.
		expect(log.all.some((e) => e.type === "uncertain_pending")).toBe(true);
	});

	it("without an uncertainty channel the failure is recorded abandoned — never retried automatically", async () => {
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
		expect(executed).toBe(1); // never auto-retried
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
