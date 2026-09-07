/**
 * A1a (A) — request-budget accounting: the parts of the assembled
 * request, each estimated the way the kernel estimates (chars/4, marked
 * approximate), summed once. The continuation envelopes are measured as
 * a sub-part of the messages (never added twice); the output reserve is
 * the request's max_tokens or null when the provider sends none.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@vincemakes/kiso-core";
import { requestBudget } from "../src/request-budget.js";

const MESSAGES: Message[] = [
	{ role: "user", content: "x".repeat(400) },
	{
		role: "assistant",
		blocks: [{ type: "text", text: "y".repeat(200) }, { type: "tool_use", callId: "c1", name: "read_file", input: { path: "a" } }],
		continuation: { scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId: "m" }, entries: [{ kind: "anthropic.content_block", required: true, data: "z".repeat(800) }] },
	},
	{ role: "tool", callId: "c1", content: "w".repeat(1200), isError: false },
];

describe("A1a — requestBudget", () => {
	it("the parts sum to the total; the continuation is a sub-part counted once", () => {
		const b = requestBudget({ systemPrompt: "s".repeat(2000), toolSpecs: [{ name: "t", description: "d".repeat(400), inputSchema: { type: "object" } }], messages: MESSAGES, maxTokens: 4096 }, 100_000);
		expect(b.approximate).toBe(true);
		expect(b.system).toBe(500);
		expect(b.tools).toBeGreaterThan(100);
		expect(b.continuations).toBeGreaterThan(200); // ~800 chars of envelope
		expect(b.messages).toBe(b.user + b.assistant + b.toolResults + b.continuations);
		expect(b.total).toBe(b.system + b.tools + b.messages + (b.outputReserve ?? 0));
		expect(b.outputReserve).toBe(4096);
		expect(b.headroom).toBe(100_000 - b.total);
		expect(b.ratio).toBeCloseTo(b.total / 100_000, 9);
	});

	it("no max_tokens → the reserve is null, not 4096, and the total excludes it", () => {
		const b = requestBudget({ toolSpecs: [], messages: MESSAGES }, 100_000);
		expect(b.outputReserve).toBeNull();
		expect(b.total).toBe(b.system + b.tools + b.messages);
		expect(b.system).toBe(0);
	});

	it("a large tool table lowers the headroom that a messages-only ratio would show", () => {
		const specs = Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(300), inputSchema: { type: "object", properties: { a: { type: "string", description: "e".repeat(200) } } } }));
		const withTools = requestBudget({ toolSpecs: specs, messages: MESSAGES }, 100_000);
		const without = requestBudget({ toolSpecs: [], messages: MESSAGES }, 100_000);
		expect(withTools.headroom).toBeLessThan(without.headroom - 3000);
	});
});
