/**
 * 0.1.26 (ADR-0024 Amd) — the parallel + streaming execution acceptance:
 * ① three allow reads run CONCURRENTLY — the wall clock < 60% of the serial
 *   (faux tools with sleeps; the window is 4);
 * ④ EC-1 (was: streaming execution): a commit-required call starts only
 *   AFTER the durable stop — the Turn Commit is the gate. The 0.1.26
 *   streaming launch survives only for precommit-safe declarations;
 * ⑤ the ask conservative order: an ask and the calls after it wait for the
 *   human — the third (allow) call never starts before the ask resolves.
 * The projection byte discipline (③) lives in loop.test.ts — the results
 * of one turn project in CALL order whatever the completion interleaving.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

const USER: Message = { role: "user", content: "hi" };

/** The tool helper: a tool whose handler sleeps `ms` and records its
 *  start/end into the shared order. */
// EC-1 (scheduler-timing class): these stand-ins are the "allow READS" the
// tests below describe, and reads are exactly what `concurrency: "shared"`
// certifies. Before EC-1 every tool overlapped by default and the
// declaration did not exist; now absence means EXCLUSIVE, so an undeclared
// stand-in would serialize and these window tests would be measuring the
// barrier instead of the window. Declaring them shared keeps each test
// measuring what it was written to measure. The barrier itself is pinned by
// ec1-effects.test.ts, where the undeclared default is the whole point.
function slowTool(name: string, ms: number, order: string[]): Tool {
	return defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		effects: { precommitSafe: true, concurrency: "shared" },
		execute: async () => {
			order.push(`${name}:start`);
			await new Promise((r) => setTimeout(r, ms));
			order.push(`${name}:end`);
			return { content: name, isError: false };
		},
	});
}

async function run(
	script: FauxScript,
	registry: ToolRegistry,
	extra: Partial<Parameters<typeof loop>[0]> = {},
): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({ adapter: createFauxProvider(script), model: "faux", registry, messages: [USER], ...extra })) {
		events.push(ev);
	}
	return events;
}

// A tiny faux provider with a REAL delay between events — the streaming
// execution's proof needs the stream to still be running when the tool
// starts (a burst provider would finish before the launch lands). Phases
// like the evals' faux script: each turn serves the next phase.
function createDelayedProvider(phases: Event[][], gapMs: number): Adapter {
	let phase = 0;
	return {
		stream: async function* () {
			const events = phases[Math.min(phase, phases.length - 1)]!;
			phase += 1;
			for (const ev of events) {
				await new Promise((r) => setTimeout(r, gapMs));
				yield ev;
			}
		},
	} as unknown as Adapter;
}

describe("0.1.26 ① — three allow reads run CONCURRENTLY (window 4)", () => {
	it("three 300ms tools complete in < 60% of the serial wall clock", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(slowTool("t1", 300, order));
		registry.register(slowTool("t2", 300, order));
		registry.register(slowTool("t3", 300, order));
		const t0 = Date.now();
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "a", name: "t1", input: {} },
						{ type: "tool_call_end", callId: "b", name: "t2", input: {} },
						{ type: "tool_call_end", callId: "c", name: "t3", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
		);
		const dt = Date.now() - t0;
		// Serial would be ~900ms; the parallel (window 4) is ~300ms + the
		// settle overhead — the acceptance: < 60% of the serial (540ms).
		expect(dt).toBeLessThan(540);
		// All three ran; each started before its own end.
		expect(order.filter((s) => s.endsWith(":start"))).toHaveLength(3);
		expect(order.filter((s) => s.endsWith(":end"))).toHaveLength(3);
		// The ledger wrapped each call completely.
		const flow = events.filter((e) => e.type.startsWith("tool_execution_") || e.type === "tool_result");
		expect(flow.filter((e) => e.type === "tool_execution_started")).toHaveLength(3);
		expect(flow.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(3);
		expect(flow.filter((e) => e.type === "tool_result")).toHaveLength(3);
	});
});

// ── EC-1, the SCHEDULER-TIMING CLASS ───────────────────────────────────────
// This was 0.1.26 ④ — "streaming execution: the first allow call starts
// WHILE the stream is still running", pinned as `started.seq < stop.seq`.
// It is the single assertion EC-1 deliberately inverts. A commit-required
// handler now waits for the durable Turn Commit, so its started event can
// never precede the stop; the streaming launch survives only for calls that
// declare themselves precommit-safe (slice ②), which this undeclared tool
// is not. The tool still runs, and still runs concurrently with its
// siblings — only its start MOMENT moved behind the commit.
describe("EC-1 (was 0.1.26 ④) — a commit-required call starts only AFTER the durable stop", () => {
	it("a 300ms-gap stream: the started event lands AFTER the stop (the commit is the gate)", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(slowTool("fast", 50, order));
		// The stream: a text delta, the tool call, then a 300ms gap, then
		// the stop — the launch happens at the tool_call_end, so the
		// execution (50ms) completes DURING the stream's gap.
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: createDelayedProvider(
				[
					[
						{ type: "text_delta", text: "long stream", seq: 0 },
						{ type: "tool_call_end", callId: "a", name: "fast", input: {}, seq: 1 },
						{ type: "stop", reason: "tool_use", seq: 2 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				300,
			),
			model: "faux",
			registry,
			messages: [USER],
		})) {
			events.push(ev);
		}
		const started = events.find((e) => e.type === "tool_execution_started")!;
		const stop = events.find((e) => e.type === "stop")!;
		// EC-1: the durable stop is the commit, and the commit is what
		// authorizes the handler — so the order is now the other way round.
		// This is the invariant, not an accident of timing: there is no gap
		// in which an undeclared tool can start early.
		expect(started.seq).toBeGreaterThan(stop.seq);
		// The tool still ran to completion — gating moved the start, it did
		// not cancel the work.
		expect(order).toContain("fast:start");
		expect(order).toContain("fast:end");
	});
});

describe("0.1.26 ⑤ — the ask conservative order: an ask holds the calls after it", () => {
	it("the third (allow) call never starts before the ask resolves", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry();
		registry.register(slowTool("allow1", 10, order));
		registry.register(slowTool("ask", 10, order));
		registry.register(slowTool("allow2", 10, order));
		// The policy: allow1 + allow2 ALLOW, ask ASKS — the human answers
		// after a 100ms delay. (The composed chain is a single per-call
		// decide here — the kernel sees the runtime's composition.)
		const approvals: string[] = [];
		const resolveApproval = async (decisionId: string): Promise<import("../src/kernel/permission.js").PermissionDecision> => {
			approvals.push(decisionId);
			await new Promise((r) => setTimeout(r, 100));
			return { action: "allow" };
		};
		const events = await run(
			[
				{
					events: [
						{ type: "tool_call_end", callId: "a", name: "allow1", input: {} },
						{ type: "tool_call_end", callId: "b", name: "ask", input: {} },
						{ type: "tool_call_end", callId: "c", name: "allow2", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "stop", reason: "end_turn" }] },
			],
			registry,
			{
				approvalPolicy: {
					decide: async (payload: { name: string }) =>
						payload.name === "ask" ? { action: "ask" as const } : { action: "allow" as const, decidedBy: "mix" },
				},
				resolveApproval,
			},
		);
		// The ask paused for the human — the request + the decision are
		// durable events.
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
		expect(approvals).toHaveLength(1);
		// The conservative order: allow2 (the call AFTER the ask) started
		// only after the ask's permission_decided — its started seq is
		// greater than the decision's.
		const decided = events.find((e) => e.type === "permission_decided" && e.callId === "b")!;
		const allow2Started = events.find((e) => e.type === "tool_execution_started" && e.callId === "c")!;
		expect(allow2Started.seq).toBeGreaterThan(decided.seq);
		// The ask itself ran after its decision too.
		const askStarted = events.find((e) => e.type === "tool_execution_started" && e.callId === "b")!;
		expect(askStarted.seq).toBeGreaterThan(decided.seq);
		// allow1 (BEFORE the ask) ran freely — before the ask's decision.
		const allow1Started = events.find((e) => e.type === "tool_execution_started" && e.callId === "a")!;
		expect(allow1Started.seq).toBeLessThan(decided.seq);
		// All three completed.
		expect(order.filter((s) => s.endsWith(":start"))).toHaveLength(3);
	});
});
