/**
 * 0.1.40 (R-C item 3) — the truncation guard: a truncated turn's tool batch
 * never executes. The wrapper holds the tool_call_end events and fails them
 * (input: null — the kernel's existing invalid-input denial) on a max_tokens
 * stop; a compatible stop flushes them untouched. The integration test pins
 * the guarantee end-to-end through the kernel: the calls land as denials,
 * the tool handler never runs, the turn ends with the max_tokens terminal.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, loop, ToolRegistry, type Event, type TerminalEvent } from "@vincemakes/kiso-core";
import { truncationGuard } from "../src/truncation-guard.js";

async function collect(
	script: FauxScript,
	opts: { guarded?: boolean; tool?: (ctx: { signal?: { aborted: boolean } }) => Promise<{ content: string; isError: boolean }> } = {},
): Promise<readonly Event[]> {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "web_search",
			description: "Search",
			parameters: { type: "object", properties: { query: { type: "string" } } },
			execute: opts.tool ?? (async () => ({ content: "ok", isError: false })),
		}),
	);
	const adapter = createFauxProvider(script);
	const events: Event[] = [];
	const user = { role: "user" as const, content: "do it" };
	for await (const ev of loop({
		adapter: opts.guarded ? truncationGuard(adapter) : adapter,
		model: "faux",
		registry,
		messages: [user],
	})) {
		events.push(ev);
	}
	return events;
}

const terminalOf = (events: readonly Event[]) => events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

describe("the truncation guard (the pi protection)", () => {
	it("a truncation stop fails the WHOLE batch — null inputs, nothing executes, the turn voids as max_tokens", async () => {
		let executed = 0;
		const events = await collect(
			[
				{
					events: [
						{ type: "tool_call_start", callId: "c1", name: "web_search" },
						{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: "{\"q" },
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
						{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "more" } },
						{ type: "stop", reason: "max_tokens" },
					],
				},
			],
			{
				guarded: true,
				tool: async () => {
					executed += 1;
					return { content: "ok", isError: false };
				},
			},
		);
		// the whole batch failed as invalid — the handler never ran.
		expect(executed).toBe(0);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results.length).toBe(2);
		expect(results.every((r) => r.isError && r.errorKind === "invalid_input")).toBe(true);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("a compatible stop flushes the held calls untouched, in order — the kernel executes them", async () => {
		const inputs: unknown[] = [];
		const events = await collect(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "a" } },
						{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "b" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			{
				guarded: true,
				tool: async (ctx) => {
					// the second turn runs the settled results — not asserted here.
					void ctx;
					return { content: "ok", isError: false };
				},
			},
		);
		// both calls executed (the flush preserved them), in call order.
		const started = events.filter((e) => e.type === "tool_execution_started");
		expect(started.map((e) => e.callId)).toEqual(["c1", "c2"]);
		inputs.push(...started.map((e) => e.input));
		expect(inputs).toEqual([{ query: "a" }, { query: "b" }]);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("the deltas pass through live — only the completion is gated", async () => {
		const events = await collect(
			[
				{
					events: [
						{ type: "tool_call_start", callId: "c1", name: "web_search" },
						{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: "{\"query" },
						{ type: "stop", reason: "max_tokens" },
					],
				},
			],
			{ guarded: true },
		);
		expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
		expect(events.some((e) => e.type === "tool_call_input_delta")).toBe(true);
		expect(events.some((e) => e.type === "tool_call_end")).toBe(false); // held, never released on truncation
	});
});
