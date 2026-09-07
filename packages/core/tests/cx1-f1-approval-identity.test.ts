/**
 * CX-1 F1 — a replayed approval binds to the framework invocation.
 *
 * The audit's shape: a provider reuses one callId for two different
 * calls — `target: allowed` then `target: forbidden`. The durable-
 * decision lookup keyed on callId found the FIRST decision in the log
 * and skipped the policy for the second call: the policy saw only
 * `allowed`, both handlers ran, one `permission_decided` existed.
 * That is a policy bypass.
 *
 * The invariant: a durable policy decision applies to exactly the
 * invocation it was recorded for (`permission_decided.invocationSeq`
 * === the call's seq). A provider callId is correlation, never
 * identity. A new call with the same name and the same arguments
 * never inherits an earlier decision.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import type { Adapter } from "../src/protocol/adapter.js";
import type { ChainVerdict } from "../src/protocol/extension.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { EventLog } from "../src/kernel/event-log.js";

const USER: Message = { role: "user", content: "go" };

function scripted(phases: Event[][]): Adapter {
	let phase = 0;
	return {
		stream: async function* () {
			const events = phases[Math.min(phase, phases.length - 1)]!;
			phase += 1;
			for (const ev of events) yield ev;
		},
	} as unknown as Adapter;
}

function harness() {
	const ran: string[] = [];
	const seen: string[] = [];
	const registry = new ToolRegistry();
	registry.register(
		defineTool<{ target: string }>({
			name: "act",
			description: "act on a target",
			parameters: { type: "object", properties: { target: { type: "string" } } },
			execute: async (input) => {
				ran.push(input.target);
				return { content: `did ${input.target}`, isError: false };
			},
		}),
	);
	const approvalPolicy: { decide: (payload: { input: { target?: string }; callId?: string }) => Promise<ChainVerdict> } = {
		decide: async (payload) => {
			seen.push(String(payload.input.target));
			return payload.input.target === "allowed"
				? { action: "allow", decidedBy: "policy" }
				: { action: "deny", decidedBy: "policy", reason: "forbidden target" };
		},
	};
	return { ran, seen, registry, approvalPolicy };
}

async function drive(adapter: Adapter, h: ReturnType<typeof harness>): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({ adapter, model: "faux", registry: h.registry, messages: [USER], approvalPolicy: h.approvalPolicy })) {
		events.push(ev);
	}
	return events;
}

describe("CX-1 F1 — a reused provider callId never inherits an earlier decision", () => {
	it("the audit's shape: allowed then forbidden under ONE callId — the policy sees both, the second is denied", async () => {
		const h = harness();
		const events = await drive(
			scripted([
				[
					{ type: "tool_call_end", callId: "reused", name: "act", input: { target: "allowed" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[
					{ type: "tool_call_end", callId: "reused", name: "act", input: { target: "forbidden" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[{ type: "stop", reason: "end_turn", seq: 0 }],
			] as unknown as Event[][]),
			h,
		);
		expect(h.seen).toEqual(["allowed", "forbidden"]); // the policy evaluated BOTH invocations
		expect(h.ran).toEqual(["allowed"]); // only the allowed one executed
		const decisions = events.filter((e) => e.type === "permission_decided");
		expect(decisions).toHaveLength(2);
		expect(decisions.map((d) => (d as { decision: string }).decision)).toEqual(["approved", "denied"]);
	});

	it("same callId AND identical arguments in a new invocation — decided anew, never inherited", async () => {
		const h = harness();
		await drive(
			scripted([
				[
					{ type: "tool_call_end", callId: "same", name: "act", input: { target: "allowed" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[
					{ type: "tool_call_end", callId: "same", name: "act", input: { target: "allowed" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[{ type: "stop", reason: "end_turn", seq: 0 }],
			] as unknown as Event[][]),
			h,
		);
		expect(h.seen).toEqual(["allowed", "allowed"]); // two invocations, two evaluations
		expect(h.ran).toEqual(["allowed", "allowed"]);
	});

	it("a LEGACY decision (no invocationSeq) that binds to no call is ambiguous — the call asks, never the chain's allow", async () => {
		const h = harness();
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" } as never);
		// an old decision recorded with the same callId, but a run boundary
		// sits between it and any call it could bind to — nothing binds
		log.append({ type: "terminal", outcome: { kind: "completed" } } as never);
		log.append({ type: "permission_decided", decisionId: "old", callId: "reused", decision: "approved", decidedBy: "policy" } as never);
		const events: Event[] = [];
		for await (const ev of loop({
			adapter: scripted([
				[
					{ type: "tool_call_end", callId: "reused", name: "act", input: { target: "allowed" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[{ type: "stop", reason: "end_turn", seq: 0 }],
			] as unknown as Event[][]),
			model: "faux",
			registry: h.registry,
			log,
			approvalPolicy: h.approvalPolicy,
		})) {
			events.push(ev);
		}
		expect(h.seen).toEqual([]); // the chain was NOT consulted — no silent allow
		expect(h.ran).toEqual([]); // and nothing executed
	});

	it("the review's same-turn shape (2026-09-07 P1): ONE turn, TWO calls under one callId with identical input — the policy decides both, the second is denied, the handler runs once", async () => {
		const h = harness();
		let n = 0;
		h.approvalPolicy.decide = async () => (++n === 1 ? { action: "allow", decidedBy: "policy" } : { action: "deny", decidedBy: "policy", reason: "only the first" });
		const events = await drive(
			scripted([
				[
					{ type: "tool_call_end", callId: "same", name: "act", input: { target: "t" }, seq: 0 },
					{ type: "text_delta", text: "next", seq: 1 },
					{ type: "tool_call_end", callId: "same", name: "act", input: { target: "t" }, seq: 2 },
					{ type: "stop", reason: "tool_use", seq: 3 },
				],
				[{ type: "stop", reason: "end_turn", seq: 0 }],
			] as unknown as Event[][]),
			h,
		);
		expect(n).toBe(2); // decided twice — the retracted re-issue rule let the second inherit the first
		expect(h.ran).toEqual(["t"]); // executed once
		expect(events.filter((e) => e.type === "permission_decided").map((d) => (d as { decision: string }).decision)).toEqual(["approved", "denied"]);
	});

	it("the review's voided-draft shape (2026-09-07 P1): the draft's call is approved, the stream fails, the retry re-emits the SAME callId — decided again, bound to the NEW invocation", async () => {
		const h = harness();
		let n = 0;
		h.approvalPolicy.decide = async () => (++n === 1 ? { action: "allow", decidedBy: "policy" } : { action: "deny", decidedBy: "policy", reason: "now denied" });
		let phase = 0;
		const adapter = {
			stream: async function* () {
				const p = phase++;
				if (p < 2) {
					yield { type: "tool_call_end", callId: "same", name: "act", input: { target: "t" }, seq: 0 };
					yield { type: "text_delta", text: "draft", seq: 1 };
					if (p === 0) throw { code: "network", message: "cut", retryable: true };
					yield { type: "stop", reason: "tool_use", seq: 2 };
				} else yield { type: "stop", reason: "end_turn", seq: 0 };
			},
		} as unknown as Adapter;
		const events: Event[] = [];
		for await (const ev of loop({ adapter, model: "faux", registry: h.registry, messages: [USER], maxRetries: 1, approvalPolicy: h.approvalPolicy })) events.push(ev);
		expect(events.some((e) => e.type === "model_output_abandoned")).toBe(true); // the draft was voided
		expect(n).toBe(2); // the retry's call was decided anew
		expect(h.ran).toEqual([]); // and the new verdict (deny) governed it — nothing inherited the draft's allow
		const decisions = events.filter((e) => e.type === "permission_decided") as (Event & { type: "permission_decided"; invocationSeq?: number })[];
		const calls = events.filter((e): e is Event & { type: "tool_call_end" } => e.type === "tool_call_end");
		expect(decisions).toHaveLength(2);
		expect(decisions[1]!.invocationSeq).toBe(calls[1]!.seq);
	});

	it("the /mode-switch shape: a DIFFERENT callId with identical arguments after a denial is a new invocation — decided anew (the wide re-issue rule inherited the denial; caught by tui-modes)", async () => {
		const h = harness();
		// the policy denies the first, allows the second — the shape the
		// PTY gate drives with plan → default; here the verdict flips by
		// the callId so a inherited denial is observable as a missing call
		const seenIds: string[] = [];
		h.approvalPolicy.decide = async (payload) => {
			seenIds.push(String(payload.callId));
			return seenIds.length === 1
				? { action: "deny", decidedBy: "policy", reason: "first time: no" }
				: { action: "allow", decidedBy: "policy" };
		};
		await drive(
			scripted([
				[
					{ type: "tool_call_end", callId: "w1", name: "act", input: { target: "same" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[
					{ type: "tool_call_end", callId: "w2", name: "act", input: { target: "same" }, seq: 0 },
					{ type: "stop", reason: "tool_use", seq: 1 },
				],
				[{ type: "stop", reason: "end_turn", seq: 0 }],
			] as unknown as Event[][]),
			h,
		);
		expect(seenIds).toEqual(["w1", "w2"]); // the second call was decided, not inherited
		expect(h.ran).toEqual(["same"]); // denied once, then allowed and executed once
	});
});

