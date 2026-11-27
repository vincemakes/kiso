/**
 * The voided-turn terminals, pinned byte for byte. Written against the
 * pre-refactor kernel (origin/main d6fee6d7) and kept: every path that voids
 * a turn must produce exactly these terminal bytes, so a zero-behaviour
 * refactor of how they are built (the `invalid()` helper, the incompatible-
 * stop switch reusing terminalForStop) is provably zero-behaviour.
 */
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { ContinuationScope, Event } from "../src/protocol/events.js";
import { loop } from "../src/kernel/loop.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";

const SCOPE: ContinuationScope = { providerId: "anthropic", apiId: "anthropic-messages", modelId: "claude-x" };

const registry = new ToolRegistry();
registry.register(defineTool({ name: "echo", description: "e", parameters: { type: "object" }, execute: async () => ({ content: "ok", isError: false }) }));

async function terminalOf(script: unknown[], scope?: ContinuationScope): Promise<string> {
	const adapter: Adapter = {
		stream: async function* () {
			for (const ev of script) yield { seq: 0, ...(ev as object) } as never;
		},
	};
	const events: Event[] = [];
	for await (const ev of loop({ adapter, model: "claude-x", registry, messages: [{ role: "user", content: "go" }], ...(scope !== undefined ? { continuationScope: scope } : {}) })) events.push(ev);
	const t = events.filter((e) => e.type === "terminal");
	expect(t).toHaveLength(1);
	return JSON.stringify((t[0] as { outcome: unknown }).outcome);
}

const call = [
	{ type: "tool_call_start", callId: "c1", name: "echo" },
	{ type: "tool_call_end", callId: "c1", name: "echo", input: {} },
];
const err = (code: string, message: string) => JSON.stringify({ kind: "error", error: { code, retryable: false, message } });

describe("voided-turn terminals are byte-stable", () => {
	it("a forged kernel-owned event", async () => {
		expect(await terminalOf([{ type: "terminal", outcome: { kind: "completed" } }])).toBe(err("invalid_request", "provider emitted a kernel-owned event"));
	});
	it("an event after the stop", async () => {
		expect(await terminalOf([{ type: "stop", reason: "end_turn" }, { type: "text_delta", text: "late" }])).toBe(err("invalid_request", "provider emitted events after its stop event"));
	});
	it("a duplicate stop", async () => {
		expect(await terminalOf([{ type: "text_delta", text: "a" }, { type: "stop", reason: "end_turn" }, { type: "stop", reason: "end_turn" }])).toBe(err("invalid_request", "provider emitted 2 stop events in one turn"));
	});
	it("no stop at all", async () => {
		expect(await terminalOf([{ type: "text_delta", text: "a" }])).toBe(err("invalid_request", "provider stream ended without a stop event"));
	});
	it("a continuation over the hard cap", async () => {
		const huge = "x".repeat(3 * 1024 * 1024);
		expect(await terminalOf([{ type: "text_delta", text: "a" }, { type: "stop", reason: "end_turn", continuation: { scope: SCOPE, entries: [{ kind: "anthropic.content_block", required: true, data: huge }] } }], SCOPE)).toBe(
			err("invalid_request", "the turn's required continuation metadata exceeds the hard cap"),
		);
	});
	describe("an incompatible stop with a launched call", () => {
		const cases: [string, string][] = [
			["max_tokens", JSON.stringify({ kind: "max_tokens" })],
			["abort", JSON.stringify({ kind: "aborted", by: "user" })],
			["error", err("unknown", "provider stopped with an error")],
			["end_turn", err("invalid_request", "provider stopped with 'end_turn' with 1 tool call(s) launched")],
			["refusal", err("invalid_request", "provider stopped with 'refusal' with 1 tool call(s) launched")],
			["content_filter", err("invalid_request", "provider stopped with 'content_filter' with 1 tool call(s) launched")],
			["context_window", err("invalid_request", "provider stopped with 'context_window' with 1 tool call(s) launched")],
			["pause_turn", err("invalid_request", "provider stopped with 'pause_turn' with 1 tool call(s) launched")],
			["stop_sequence", err("invalid_request", "provider stopped with 'stop_sequence' with 1 tool call(s) launched")],
		];
		for (const [reason, bytes] of cases) it(reason, async () => expect(await terminalOf([...call, { type: "stop", reason }])).toBe(bytes));
	});
	describe("the no-call terminals (terminalForStop)", () => {
		const cases: [string, string][] = [
			["refusal", err("invalid_request", "the model refused the request")],
			["content_filter", err("invalid_request", "the provider's content filter triggered")],
			["tool_use", err("invalid_request", "provider stopped with a tool call that was never completed")],
			["max_tokens", JSON.stringify({ kind: "max_tokens" })],
			["error", err("unknown", "provider stopped with an error")],
			["end_turn", JSON.stringify({ kind: "completed" })],
		];
		for (const [reason, bytes] of cases) it(reason, async () => expect(await terminalOf([{ type: "text_delta", text: "a" }, { type: "stop", reason }])).toBe(bytes));
	});
});
