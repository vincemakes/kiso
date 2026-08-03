/**
 * Phase B — terminal honesty and retry discipline.
 *
 * 1. A provider's stop reason is NEVER unconditionally converted to
 *    `completed`: max_tokens gets its own terminal kind, abort its own.
 * 2. A turn that has already streamed content is never silently re-streamed:
 *    retry is only legal BEFORE the first event of the turn left the adapter.
 * 3. Every run converges on exactly one terminal.
 */

import { describe, expect, it } from "vitest";
import type { Adapter, StreamOptions } from "../src/protocol/adapter.js";
import type { Event, TerminalEvent } from "../src/protocol/events.js";
import { loop } from "../src/kernel/loop.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createFauxProvider, type FauxScript } from "@kiso/evals";

const registry = new ToolRegistry();
registry.register(
	defineTool({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } } },
		execute: async () => ({ content: "results", isError: false }),
	}),
);

async function run(
	script: FauxScript,
	opts: Partial<Parameters<typeof loop>[0]> = {},
): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter: createFauxProvider(script),
		model: "faux",
		registry,
		messages: [{ role: "user", content: "go" }],
		...opts,
	})) {
		events.push(ev);
	}
	return events;
}

const terminalOf = (events: readonly Event[]) =>
	events.filter((e): e is TerminalEvent => e.type === "terminal").at(-1)!;

describe("stop reasons map to explicit terminals (never blanket completed)", () => {
	it("end_turn with no tool calls → completed", async () => {
		const events = await run([{ events: [{ type: "stop", reason: "end_turn" }] }]);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("max_tokens with no tool calls → a max_tokens terminal, NOT completed", async () => {
		const events = await run([
			{ events: [{ type: "text_delta", text: "cut off" }, { type: "stop", reason: "max_tokens" }] },
		]);
		expect(terminalOf(events).outcome).toEqual({ kind: "max_tokens" });
	});

	it("stop_sequence → completed (a legitimate stop)", async () => {
		const events = await run([{ events: [{ type: "stop", reason: "stop_sequence" }] }]);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("tool_use WITHOUT a complete tool call is a protocol error, not completed", async () => {
		const events = await run([{ events: [{ type: "stop", reason: "tool_use" }] }]);
		expect(terminalOf(events).outcome.kind).toBe("error");
	});

	it("refusal / pause_turn / content_filter / context_window are never completed (Area 6)", async () => {
		for (const reason of ["refusal", "pause_turn", "content_filter", "context_window"] as const) {
			const events = await run([{ events: [{ type: "stop", reason }] }]);
			expect(terminalOf(events).outcome.kind, reason).toBe("error");
			expect(terminalOf(events).outcome, reason).not.toEqual({ kind: "completed" });
		}
	});

	it("a stream that ends WITHOUT a stop event is an error terminal, not completed", async () => {
		const events = await run([{ events: [{ type: "text_delta", text: "hello" }] }]);
		expect(terminalOf(events).outcome).toMatchObject({
			kind: "error",
			error: { code: "invalid_request" },
		});
	});

	it("an EMPTY provider stream is an error terminal, not completed", async () => {
		const events = await run([{ events: [] }]);
		expect(terminalOf(events).outcome).toMatchObject({ kind: "error", error: { code: "invalid_request" } });
	});

	it("a DUPLICATE stop event is an error terminal, not completed", async () => {
		const events = await run([
			{ events: [{ type: "stop", reason: "end_turn" }, { type: "stop", reason: "end_turn" }] },
		]);
		expect(terminalOf(events).outcome).toMatchObject({ kind: "error", error: { code: "invalid_request" } });
	});

	it("an abort mid-run yields exactly one terminal of kind aborted", async () => {
		const ac = new AbortController();
		const events: Event[] = [];
		const script: FauxScript = [
			{
				events: [
					{ type: "text_delta", text: "working" },
					{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "x" } },
				],
			},
		];
		const gen = loop({
			adapter: createFauxProvider(script),
			model: "faux",
			registry,
			messages: [{ role: "user", content: "go" }],
			signal: ac.signal,
		});
		for await (const ev of gen) {
			events.push(ev);
			if (ev.type === "tool_call_end") ac.abort();
		}
		const terminals = events.filter((e) => e.type === "terminal");
		expect(terminals).toHaveLength(1);
		expect(terminalOf(events).outcome).toEqual({ kind: "aborted", by: "user" });
	});

	it("an aborted signal BEFORE the run starts still converges on aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const events = await run([{ events: [{ type: "stop", reason: "end_turn" }] }], { signal: ac.signal });
		expect(terminalOf(events).outcome).toEqual({ kind: "aborted", by: "user" });
	});
});

describe("retry discipline: nothing streamed ⇒ retry is legal", () => {
	it("a retryable error AFTER content was streamed never re-streams (no duplicates)", async () => {
		let calls = 0;
		const flaky: Adapter = {
			stream: async function* (opts: StreamOptions) {
				calls += 1;
				yield { seq: 0, type: "text_start" };
				yield { seq: 0, type: "text_delta", text: "partial" };
				throw { code: "overloaded", status: 529, retryable: true, message: "overloaded" };
			},
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: flaky,
			model: "faux",
			registry,
			messages: [{ role: "user", content: "go" }],
			maxRetries: 3,
		})) {
			events.push(ev);
		}
		expect(calls).toBe(1); // never re-streamed
		const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text);
		expect(deltas).toEqual(["partial"]); // exactly once
		expect(terminalOf(events).outcome.kind).toBe("error");
	});

	it("a retryable error BEFORE anything streamed retries inside the frame (ADR-0005)", async () => {
		let calls = 0;
		const flaky: Adapter = {
			stream: async function* () {
				calls += 1;
				if (calls === 1) {
					throw { code: "overloaded", status: 529, retryable: true, message: "overloaded" };
				}
				yield { seq: 0, type: "stop", reason: "end_turn" as const };
			},
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: flaky,
			model: "faux",
			registry,
			messages: [{ role: "user", content: "go" }],
			maxRetries: 3,
		})) {
			events.push(ev);
		}
		expect(calls).toBe(2);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
	});

	it("a partial tool call is never re-streamed either", async () => {
		let calls = 0;
		const flaky: Adapter = {
			stream: async function* () {
				calls += 1;
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: "web_search" };
				yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: '{"qu' };
				throw { code: "network", retryable: true, message: "socket dropped" };
			},
		};
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: flaky,
			model: "faux",
			registry,
			messages: [{ role: "user", content: "go" }],
			maxRetries: 2,
		})) {
			events.push(ev);
		}
		expect(calls).toBe(1);
		expect(terminalOf(events).outcome.kind).toBe("error");
	});
});
