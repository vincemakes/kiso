/**
 * The loop, proven against fixtures and failure shapes. These are the tests
 * the loop was written to pass — the fixtures existed first (M0), red until
 * this file went green.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "../src/adapters/faux";
import type { Event } from "../src/protocol/events";
import type { Message } from "../src/protocol/messages";
import { defineTool, type Tool } from "../src/tools/tool";
import { ToolRegistry } from "../src/tools/registry";
import { loop } from "../src/kernel/loop";
import { terminalLies } from "./fixtures/terminal-lies";
import { silentToolFailure } from "./fixtures/silent-tool-failure";

async function run(
	script: FauxScript,
	registry: ToolRegistry,
	opts: Partial<Parameters<typeof loop>[0]> = {},
): Promise<readonly Event[]> {
	const events: Event[] = [];
	const user: Message = { role: "user", content: "把这件事做完" };
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux-model",
		registry,
		messages: [user],
		...opts,
	})) {
		events.push(ev);
	}
	return events;
}

function terminalOf(events: readonly Event[]): Event {
	const t = events.filter((e) => e.type === "terminal");
	expect(t.length, "exactly one terminal event per run").toBe(1);
	return t[0]!;
}

const searchTool: Tool<{ query: string }> = defineTool({
	name: "web_search",
	description: "Search the web",
	parameters: { type: "object", properties: { query: { type: "string" } } },
	execute: async () => ({ content: "some results", isError: false }),
});

describe("loop", () => {
	it("converges on exactly one terminal event", async () => {
		const registry = new ToolRegistry();
		const events = await run([{ events: [{ type: "stop", reason: "end_turn" }] }], registry);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("yields events with monotonic seq (ADR-0002)", async () => {
		const registry = new ToolRegistry();
		const events = await run(
			[
				{
					events: [
						{ type: "text_start" },
						{ type: "text_delta", text: "hi" },
						{ type: "text_end" },
						{ type: "stop", reason: "end_turn" },
					],
				},
			],
			registry,
		);
		for (let i = 1; i < events.length; i++) {
			expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1);
		}
	});

	it("executes a tool call and feeds the result back into history", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		const events = await run(
			[
				{
					events: [
						{
							type: "tool_call_end",
							callId: "c1",
							name: "web_search",
							input: { query: "kiso" },
						},
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
		);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ callId: "c1", isError: false });
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("surfaces tool errors with their kind — never a clean success (silent-tool-failure)", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				...searchTool,
				execute: async () => ({
					content: "overloaded — try again",
					isError: true,
					errorKind: "transient" as const,
				}),
			}),
		);
		const events = await run(silentToolFailure.script, registry);
		const err = events.find((e) => e.type === "tool_result" && e.isError);
		expect(err).toBeDefined();
		expect(err).toMatchObject({ errorKind: "transient" });
		// The error must remain distinguishable in the SAME trajectory where
		// the model narrates success.
		expect(events.some((e) => e.type === "text_delta" && /很好/.test(e.text))).toBe(true);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("terminal-lies: the loop never invents a delivery — completion is honest (no producers)", async () => {
		const registry = new ToolRegistry();
		const events = await run(terminalLies.script, registry);
		// Model claims delivery with zero producer calls; the loop must end
		// completed WITHOUT any tool_result — the claim stays a claim.
		expect(events.filter((e) => e.type === "tool_result")).toHaveLength(0);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("denies a tool call via onPreTool and reports precondition, not failure", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		const events = await run(
			[
				{
					events: [
						{
							type: "tool_call_end",
							callId: "c1",
							name: "web_search",
							input: { query: "x" },
						},
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				hooks: {
					onPreTool: async () => ({ action: "deny" as const, reason: "not allowed here" }),
				},
			},
		);
		const denied = events.find((e) => e.type === "tool_result");
		expect(denied).toMatchObject({ isError: true, errorKind: "precondition" });
	});

	it("runs concurrency-safe calls in parallel and serial calls in order", async () => {
		const order: string[] = [];
		const mk = (name: string, safe: boolean): Tool => {
			let n = 0;
			return defineTool({
				name,
				description: name,
				parameters: { type: "object", properties: {} },
				concurrencySafe: () => safe,
				execute: async () => {
					const id = `${name}#${++n}`;
					order.push(`${id}:start`);
					await new Promise((r) => setTimeout(r, name === "slow" ? 20 : 5));
					order.push(`${id}:end`);
					return { content: name, isError: false };
				},
			});
		};
		const registry = new ToolRegistry();
		registry.register(mk("fast", true));
		registry.register(mk("fast2", true));
		registry.register(mk("serial", false));

		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "a", name: "fast", input: {} },
						{ type: "tool_call_end", callId: "b", name: "fast2", input: {} },
						{ type: "tool_call_end", callId: "c", name: "serial", input: {} },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
		);
		// Parallel pair overlaps (fast2 starts before fast ends); the serial
		// call runs strictly after both.
		const fastEnd = order.findIndex((o) => o === "fast#1:end");
		const fast2Start = order.findIndex((o) => o === "fast2#1:start");
		const serialStart = order.findIndex((o) => o === "serial#1:start");
		expect(fast2Start).toBeLessThan(fastEnd);
		expect(serialStart).toBeGreaterThan(fastEnd);
		// Results come back in call order regardless.
		const results = events.filter((e) => e.type === "tool_result").map((e) => e.callId);
		expect(results).toEqual(["a", "b", "c"]);
	});

	it("stops at maxTurns with an honest terminal", async () => {
		const registry = new ToolRegistry();
		registry.register(searchTool);
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} },
					],
				},
				{
					events: [
						{ type: "tool_call_end", callId: "c2", name: "web_search", input: {} },
					],
				},
				{
					events: [
						{ type: "tool_call_end", callId: "c3", name: "web_search", input: {} },
					],
				},
			],
			registry,
			{ maxTurns: 2 },
		);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_turns", turns: 2 });
	});

	it("retries a retryable adapter error inside the loop, then completes (ADR-0005)", async () => {
		const registry = new ToolRegistry();
		let calls = 0;
		const flakyAdapter = {
			stream: async function* () {
				calls += 1;
				if (calls === 1) {
					throw {
						code: "overloaded" as const,
						status: 529,
						retryable: true,
						message: "overloaded",
					};
				}
				yield { type: "stop" as const, reason: "end_turn" as const };
			},
		};
		const events: Event[] = [];
		const user: Message = { role: "user", content: "hi" };
		for await (const ev of loop({
			adapter: flakyAdapter,
			model: "faux",
			registry,
			messages: [user],
			maxRetries: 2,
		})) {
			events.push(ev);
		}
		expect(calls).toBe(2);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("gives up after retries and reports a structured terminal error", async () => {
		const registry = new ToolRegistry();
		const failingAdapter = {
			stream: async function* () {
				throw {
					code: "overloaded" as const,
					status: 529,
					retryable: true,
					message: "overloaded",
				};
			},
		};
		const events: Event[] = [];
		const user: Message = { role: "user", content: "hi" };
		for await (const ev of loop({
			adapter: failingAdapter,
			model: "faux",
			registry,
			messages: [user],
			maxRetries: 1,
		})) {
			events.push(ev);
		}
		const terminal = terminalOf(events);
		expect(terminal.outcome).toMatchObject({
			kind: "error",
			error: { code: "overloaded", retryable: true },
		});
	});
});
