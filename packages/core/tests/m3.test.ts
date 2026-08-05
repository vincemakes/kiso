/**
 * M3: compaction correctness + delivery truth. The two mechanisms that make
 * a long-lived agent honest about its own history and its own completion.
 *
 * ADR-0044 merged the classic auto-compaction into the microcompact
 * boundary: the loop no longer produces `compacted` events, and the
 * microcompact() produce-side is gone. The boundary behavior itself is
 * pinned by microcompact.test.ts; this file pins the RETIREMENT (the
 * deprecated config is inert) and the delivery truth.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { analyzeDelivery } from "../src/governance/delivery.js";
import { FIXTURES } from "@vincemakes/kiso-evals";

function toolMsg(callId: string, content: string, isError = false): Message {
	return { role: "tool", callId, content, isError };
}
function userMsg(content = "user"): Message {
	return { role: "user", content };
}
function assistantWithTool(callId: string, name: string): Message {
	return {
		role: "assistant",
		blocks: [{ type: "tool_use", callId, name, input: {} }],
	};
}

describe("loop auto-compaction (ADR-0044: retired)", () => {
	it("config.compaction is IGNORED — no compacted events, no pre/post hooks, the run completes", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "s",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "x".repeat(200), isError: false }),
			}),
		);
		// A long session: 7 prior user turns with chunky tool results — far
		// over any plausible threshold, so the OLD path would have fired.
		const history: Message[] = [];
		for (let i = 0; i < 7; i++) {
			history.push(userMsg(`turn ${i}`));
			history.push(assistantWithTool(`h${i}`, "web_search"));
			history.push(toolMsg(`h${i}`, "x".repeat(200)));
		}
		const script: FauxScript = [
			{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];

		let pre = 0;
		let post = 0;
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider(script),
			model: "faux",
			registry,
			messages: [...history, userMsg("do it")],
			compaction: { thresholdTokens: 100 }, // deprecated — must be inert
			hooks: {
				onPreCompact: async () => {
					pre += 1;
				},
				onPostCompact: async () => {
					post += 1;
				},
			},
		})) {
			events.push(ev);
		}
		expect(pre).toBe(0); // the deprecated hooks never fire
		expect(post).toBe(0);
		expect(events.some((e) => e.type === "compacted")).toBe(false); // no new compacted events
		expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});
});

describe("analyzeDelivery", () => {
	const producers = new Set(["create_artifact"]);

	it("fails a required delivery with a claim and zero producers (terminal-lies)", () => {
		const events: Event[] = [
			{ seq: 0, type: "text_delta", text: "我已经生成了文档并交付。" },
			{ seq: 1, type: "terminal", outcome: { kind: "completed" } },
		];
		const verdict = analyzeDelivery(events, { required: true, producers });
		expect(verdict.claimedInText).toBe(true);
		expect(verdict.producerCalls).toEqual([]);
		expect(verdict.passed).toBe(false);
	});

	it("passes when a producer completed", () => {
		const events: Event[] = [
			{ seq: 0, type: "tool_call_end", callId: "c1", name: "create_artifact", input: {} },
			{ seq: 1, type: "tool_result", callId: "c1", content: "artifact://1", isError: false },
			{ seq: 2, type: "terminal", outcome: { kind: "completed" } },
		];
		const verdict = analyzeDelivery(events, { required: true, producers });
		expect(verdict.completedProducers).toEqual(["c1"]);
		expect(verdict.passed).toBe(true);
	});

	it("does not count a failed producer as delivery", () => {
		const events: Event[] = [
			{ seq: 0, type: "tool_call_end", callId: "c1", name: "create_artifact", input: {} },
			{ seq: 1, type: "tool_result", callId: "c1", content: "boom", isError: true, errorKind: "fatal" },
			{ seq: 2, type: "terminal", outcome: { kind: "completed" } },
		];
		expect(analyzeDelivery(events, { required: true, producers }).passed).toBe(false);
	});

	it("non-required turns always pass", () => {
		const events: Event[] = [{ seq: 0, type: "terminal", outcome: { kind: "completed" } }];
		expect(analyzeDelivery(events, { required: false, producers }).passed).toBe(true);
	});
});

describe("fixture delivery asserts on the real loop", () => {
	it("terminal-lies: the verdict fails on a real run, though the loop completed", async () => {
		const fixture = FIXTURES.find((f) => f.name === "terminal-lies")!;
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider(fixture.script),
			model: "faux",
			registry: new ToolRegistry(),
			messages: [{ role: "user", content: "写一份报告" }],
		})) {
			events.push(ev);
		}
		const violations = fixture.assert?.(events) ?? [];
		expect(violations).toEqual([]);
	});
});
