/**
 * M3: compaction correctness + delivery truth. The two mechanisms that make
 * a long-lived agent honest about its own history and its own completion.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "../src/adapters/faux";
import type { Event } from "../src/protocol/events";
import type { Message } from "../src/protocol/messages";
import { defineTool } from "../src/tools/tool";
import { ToolRegistry } from "../src/tools/registry";
import { loop } from "../src/kernel/loop";
import {
	CLEARED_MARKER_PREFIX,
	estimateTokens,
	microcompact,
	KEEP_RECENT_TURNS,
} from "../src/kernel/compaction";
import { analyzeDelivery } from "../src/governance/delivery";
import { FIXTURES } from "./fixtures/index";

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

describe("microcompact", () => {
	it("keeps recent turns intact, clears old tool results, never mutates", () => {
		// 3 user turns (> KEEP_RECENT_TURNS would be 6+; use 3 to stay under
		// the boundary and verify NO-OP, then a 7-turn case to verify clear).
		const turns: Message[] = [];
		for (let i = 0; i < 7; i++) {
			turns.push(userMsg(`turn ${i}`));
			turns.push(assistantWithTool(`c${i}`, "web_search"));
			turns.push(toolMsg(`c${i}`, `result-${i}`.repeat(20)));
		}
		const before = turns.length;
		const result = microcompact(turns);
		expect(result.messages).not.toBe(turns); // new array
		expect(result.messages).toHaveLength(before); // same length, no drops
		expect(result.clearedCallIds.length).toBeGreaterThan(0);
		// Recent window intact.
		const recent = result.messages.slice(-KEEP_RECENT_TURNS * 3);
		expect(recent.some((m) => m.role === "tool" && m.content.includes("result-"))).toBe(true);
		// Old ones carry the marker.
		const cleared = result.messages.find((m) => m.role === "tool" && m.content.startsWith(CLEARED_MARKER_PREFIX));
		expect(cleared).toBeDefined();
		expect(cleared?.content).toContain("web_search");
	});

	it("is idempotent: a second pass clears nothing (the regrowth incident's fix)", () => {
		const turns: Message[] = [];
		for (let i = 0; i < 7; i++) {
			turns.push(userMsg(`turn ${i}`));
			turns.push(assistantWithTool(`c${i}`, "web_search"));
			turns.push(toolMsg(`c${i}`, `result-${i}`.repeat(20)));
		}
		const first = microcompact(turns);
		const second = microcompact(first.messages);
		expect(second.clearedCallIds).toEqual([]);
		expect(second.messages).toBe(first.messages); // untouched array identity
	});

	it("estimateTokens is monotone and clearing reduces it", () => {
		const turns: Message[] = [];
		for (let i = 0; i < 7; i++) {
			turns.push(userMsg(`turn ${i}`));
			turns.push(assistantWithTool(`c${i}`, "web_search"));
			turns.push(toolMsg(`c${i}`, `result-${i}`.repeat(20)));
		}
		const before = estimateTokens(turns);
		const after = estimateTokens(microcompact(turns).messages);
		expect(after).toBeLessThan(before);
	});
});

describe("loop auto-compaction", () => {
	it("triggers onPreCompact/onPostCompact and compacts when over threshold", async () => {
		const registry = new ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "s",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "x".repeat(200), isError: false }),
			}),
		);
		// A long session: 7 prior user turns with chunky tool results.
		const history: Message[] = [];
		for (let i = 0; i < 7; i++) {
			history.push(userMsg(`turn ${i}`));
			history.push(assistantWithTool(`h${i}`, "web_search"));
			history.push(toolMsg(`h${i}`, "x".repeat(200)));
		}
		const script: FauxScript = [
			{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }] },
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
			compaction: { thresholdTokens: 100 },
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
		expect(pre).toBeGreaterThan(0);
		expect(post).toBeGreaterThan(0);
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
