/**
 * EC-1 ③ — the scheduler's AUTHORIZATION ORDER: post-commit asks and the
 * precommit launch rule.
 *
 * Two rules, one boundary. The chain the round builds is
 *
 *     untrusted stream → TURN COMMIT → authorized invocation →
 *     durable STARTED → effect
 *
 * and ③ is the arrow from the commit to the authorization.
 *
 * (a) POST-COMMIT ASKS. A human must never be asked to approve a call whose
 *     turn then proves invalid. Before this slice the ask fired the moment
 *     the decide chain reached it — mid-stream, while the turn was still
 *     only a draft — so a provider that violated the protocol AFTER its stop
 *     had already put a question in front of a person, and answering "yes"
 *     authorized nothing (the turn voided anyway). The RED below reproduces
 *     exactly that: the request lands, the approval channel is consulted,
 *     and only then does the turn void.
 *
 * (b) THE PRECOMMIT LAUNCH RULE. The 0.1.26 streaming win is not abandoned,
 *     it is EARNED: a call may start before Turn Commit iff its tool
 *     declares `precommitSafe` AND its authorization is already satisfied
 *     (an `allow` verdict — no human in the loop). Everything else waits for
 *     the commit. A precommit-safe tool that needs a human waits like
 *     anything else, because the certificate says the EXECUTION is harmless,
 *     not that the authorization is unnecessary.
 *
 * The seq comparison is the whole instrument: the durable stop IS the Turn
 * Commit, so `started.seq < stop.seq` means "started before the turn was
 * valid" and `started.seq > stop.seq` means "started after". Nothing else in
 * the log states the boundary as plainly.
 */

import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import type { PermissionDecision } from "../src/kernel/permission.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";

const USER: Message = { role: "user", content: "go" };

/** A provider with a REAL gap between events: the scheduler's decisions have
 *  to be observable WHILE the stream is still running, which a burst
 *  provider hides — it finishes before any launch gets past its decide. */
function delayed(phases: Event[][], gapMs: number): Adapter {
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

function tool(name: string, ran: string[], effects?: Tool["effects"]): Tool {
	return defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		...(effects !== undefined ? { effects } : {}),
		execute: async () => {
			ran.push(name);
			return { content: name, isError: false };
		},
	});
}

const seqOf = (events: readonly Event[], type: Event["type"]): number | undefined =>
	events.find((e) => e.type === type)?.seq;

describe("EC-1 ③(a) — a human is never asked about an uncommitted turn", () => {
	it("a POST-STOP VIOLATION voids the turn: no request, no approval channel call, no execution", async () => {
		// The violating stream: a call, the stop, then one more delta. The
		// kernel's protocol rule (round 5) voids the turn on the trailing
		// event — and the whole question is whether a person was bothered
		// before that verdict existed.
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("write_thing", ran));
		const asked: string[] = [];
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "write_thing", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
						{ type: "text_delta", text: "one more thing", seq: 2 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				60,
			),
			model: "faux",
			registry,
			messages: [USER],
			approvalPolicy: { decide: async () => ({ action: "ask" as const }) },
			resolveApproval: async (decisionId: string): Promise<PermissionDecision> => {
				asked.push(decisionId);
				return { action: "allow" };
			},
		})) {
			events.push(ev);
		}

		// RED before ③: the request was durable and the channel was consulted
		// while the turn was still a draft.
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(0);
		expect(asked).toEqual([]);
		// And the rest of the chain never happened either.
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(ran).toEqual([]);
		// The turn's verdict is unchanged — ③ moves the ask, not the outcome.
		expect(events.some((e) => e.type === "stop")).toBe(false);
		const terminal = events.filter((e) => e.type === "terminal").at(-1)!;
		expect(terminal.outcome).toMatchObject({ kind: "error", error: { code: "invalid_request" } });
	});

	it("an INCOMPATIBLE stop (end_turn carrying a call) voids the turn before any ask", async () => {
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("write_thing", ran));
		const asked: string[] = [];
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "write_thing", input: {}, seq: 0 },
						{ type: "stop", reason: "end_turn", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				60,
			),
			model: "faux",
			registry,
			messages: [USER],
			approvalPolicy: { decide: async () => ({ action: "ask" as const }) },
			resolveApproval: async (decisionId: string): Promise<PermissionDecision> => {
				asked.push(decisionId);
				return { action: "allow" };
			},
		})) {
			events.push(ev);
		}
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(0);
		expect(asked).toEqual([]);
		expect(ran).toEqual([]);
	});

	it("a VALID turn still asks — and the request lands AFTER the durable stop", async () => {
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("write_thing", ran));
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "write_thing", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				40,
			),
			model: "faux",
			registry,
			messages: [USER],
			approvalPolicy: { decide: async () => ({ action: "ask" as const }) },
			resolveApproval: async (): Promise<PermissionDecision> => ({ action: "allow" }),
		})) {
			events.push(ev);
		}
		const stop = seqOf(events, "stop")!;
		const requested = seqOf(events, "permission_requested")!;
		const started = seqOf(events, "tool_execution_started")!;
		// The commit is a fact BEFORE the question is asked — the human's
		// answer now authorizes something that is certainly valid.
		expect(requested).toBeGreaterThan(stop);
		expect(started).toBeGreaterThan(requested);
		expect(ran).toEqual(["write_thing"]);
	});

	it("the abort-during-pause rescue survives the move: a verdict given in the same instant is recorded exactly once", async () => {
		// round 4's adversarial case, re-verified against the post-commit
		// ask: the human answers as the abort lands. The decision must be
		// recorded (never lost), and the run must still end aborted.
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("write_thing", ran));
		const controller = new AbortController();
		let verdictGiven = false;
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "write_thing", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				30,
			),
			model: "faux",
			registry,
			messages: [USER],
			signal: controller.signal,
			approvalPolicy: { decide: async () => ({ action: "ask" as const }) },
			// The human answers and the abort lands in the same instant: the
			// channel never resolves, but the verdict IS available.
			resolveApproval: () =>
				new Promise<PermissionDecision>(() => {
					verdictGiven = true;
					controller.abort();
				}),
			approvalVerdict: () => (verdictGiven ? true : undefined),
		})) {
			events.push(ev);
		}
		// The ask happened at all — proving the pause is reachable after the
		// commit, which is the precondition for this rescue mattering.
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
		// The consumed verdict is durable, exactly once.
		const decided = events.filter((e) => e.type === "permission_decided");
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({ decision: "approved" });
		// The abort still ends the run, and the effect never happened.
		expect(events.filter((e) => e.type === "terminal").at(-1)!.outcome).toEqual({ kind: "aborted", by: "user" });
		expect(ran).toEqual([]);
	});
});

describe("EC-1 ③(b) — the precommit launch rule", () => {
	it("precommitSafe AND auto-allowed: the execution starts BEFORE the durable stop", async () => {
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("read_file", ran, { precommitSafe: true, concurrency: "shared" }));
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "read_file", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				120,
			),
			model: "faux",
			registry,
			messages: [USER],
		})) {
			events.push(ev);
		}
		const started = seqOf(events, "tool_execution_started")!;
		const stop = seqOf(events, "stop")!;
		// The 0.1.26 streaming win, earned by a declaration: the read is
		// already running while the model is still writing.
		expect(started).toBeLessThan(stop);
		expect(ran).toEqual(["read_file"]);
	});

	it("precommitSafe but NEEDING A HUMAN: it waits for the commit like everything else", async () => {
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("read_file", ran, { precommitSafe: true, concurrency: "shared" }));
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "read_file", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				120,
			),
			model: "faux",
			registry,
			messages: [USER],
			approvalPolicy: { decide: async () => ({ action: "ask" as const }) },
			resolveApproval: async (): Promise<PermissionDecision> => ({ action: "allow" }),
		})) {
			events.push(ev);
		}
		const started = seqOf(events, "tool_execution_started")!;
		const stop = seqOf(events, "stop")!;
		// The certificate says the EXECUTION is harmless, never that the
		// authorization is unnecessary.
		expect(started).toBeGreaterThan(stop);
		expect(ran).toEqual(["read_file"]);
	});

	it("UNDECLARED and auto-allowed: still commit-gated — absence is the conservative truth", async () => {
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("edit_file", ran));
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "edit_file", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				120,
			),
			model: "faux",
			registry,
			messages: [USER],
		})) {
			events.push(ev);
		}
		expect(seqOf(events, "tool_execution_started")!).toBeGreaterThan(seqOf(events, "stop")!);
		expect(ran).toEqual(["edit_file"]);
	});

	it("invariant 7: a precommit execution on a turn that VOIDS is an honest fact — and it never commits the turn", async () => {
		// The shape ⑤'s new prefix class is written for: the read really ran
		// and its receipt is durable, while the turn it belonged to never
		// became valid. Both facts are true at once, and the log says so —
		// there is a receipt and there is no stop.
		const ran: string[] = [];
		const registry = new ToolRegistry();
		registry.register(tool("read_file", ran, { precommitSafe: true, concurrency: "shared" }));
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: delayed(
				[
					[
						{ type: "tool_call_end", callId: "c1", name: "read_file", input: {}, seq: 0 },
						{ type: "stop", reason: "tool_use", seq: 1 },
						{ type: "text_delta", text: "after the stop", seq: 2 },
					],
					[{ type: "stop", reason: "end_turn", seq: 0 }],
				] as unknown as Event[][],
				120,
			),
			model: "faux",
			registry,
			messages: [USER],
		})) {
			events.push(ev);
		}
		// The execution fact stands.
		expect(ran).toEqual(["read_file"]);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(true);
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		// The turn fact is the opposite, and the durable log carries no stop:
		// a precommit result never legitimizes the turn that produced it.
		expect(events.some((e) => e.type === "stop")).toBe(false);
		expect(events.filter((e) => e.type === "terminal").at(-1)!.outcome).toMatchObject({
			kind: "error",
			error: { code: "invalid_request" },
		});
	});
});
