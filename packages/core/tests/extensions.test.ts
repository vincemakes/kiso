/**
 * E1 — the kernel's approval gate. The extensions' policies are composed
 * by the RUNTIME (composeApprovalChain: deny > allow > ask, W21/R3 — the
 * composition moved out of the kernel by the 2026-08-09 corrective
 * action) into ONE decide; the kernel consumes its verdict against the
 * durable check. These tests pin the KERNEL's side: a durable decision
 * takes effect on resume (the chain never re-runs), an ask with no
 * approval channel degrades to an honest denial, and a static hook never
 * speaks for an ask. The chain composition itself lives in the runtime —
 * see packages/runtime/tests/compose-approvals.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { EventLog, loop, type Event } from "../src/index.js";

function makeRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "read_file",
			description: "r",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "ok", isError: false }),
		}),
	);
	registry.register(
		defineTool({
			name: "shell",
			description: "s",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "ran", isError: false }),
		}),
	);
	return registry;
}

const askAll = () => ({ action: "ask" as const });

/** One scripted turn that calls the named tool, then stops for it. */
function scriptedCall(name: string, callId: string, input: Record<string, unknown>): FauxScript {
	return [{ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] }];
}


const decided = (log: EventLog): (Event & { type: "permission_decided" })[] =>
	log.all.filter((e): e is Event & { type: "permission_decided" } => e.type === "permission_decided");
const resultOf = (log: EventLog): (Event & { type: "tool_result" }) | undefined =>
	log.all.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");

describe("E1: a durable decision takes effect on resume — the chain never re-runs", () => {
	it("a durable APPROVAL executes the call with the policy called ZERO times", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "a.ts" } });
		// The crash window: the policy decided (decisionId d-2, the id the
		// original run computed) and the process died before the execution.
		// The resumed model RE-ISSUES the same call (same callId, same input)
		// — the durable verdict speaks for it; the chain never re-runs.
		log.append({ type: "permission_decided", decisionId: "d-2", callId: "r1", decision: "approved", decidedBy: "reader" });
		let calls = 0;
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			approvalPolicy: {
				decide: async () => {
					calls += 1;
					return { action: "ask" };
				},
			},
		})) {
			// drain
		}
		expect(calls).toBe(0); // the policy never re-runs
		expect(decided(log)).toHaveLength(1); // nothing new recorded
		expect(log.all.some((e) => e.type === "tool_result" && e.content === "ok")).toBe(true); // the durable approval executed
	});

	it("a durable DENIAL emits the denial result with the policy called ZERO times", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "git reset --hard" } });
		log.append({
			type: "permission_decided",
			decisionId: "d-2",
			callId: "s1",
			decision: "denied",
			reason: "already denied",
			decidedBy: "guard",
		});
		let calls = 0;
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("shell", "s1", { command: "git reset --hard" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			approvalPolicy: {
				decide: async () => {
					calls += 1;
					return { action: "allow", decidedBy: "guard" };
				},
			},
		})) {
			// drain
		}
		expect(calls).toBe(0);
		expect(resultOf(log)?.content).toContain("[Permission denied] already denied");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false);
	});
});

describe("E1: an absent approval flow degrades honestly", () => {
	it("ask with no approval flow configured degrades to an honest denial", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			approvalPolicy: { decide: askAll },
		})) {
			// drain
		}
		expect(resultOf(log)?.content).toContain("[Permission denied]");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false); // never executed
	});

	it("ruling A: ask with a hook but NO approval channel still degrades — the static hook never speaks for an ask", async () => {
		// An ask means "a HUMAN must decide" — the automated policy hook must
		// not answer for the human, not even with an allow. The no-flow
		// judgment keys on resolveApproval, not on the hook's presence.
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		let hookRan = false;
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			hooks: {
				onPreTool: async () => {
					hookRan = true;
					return { action: "allow" };
				},
			},
			approvalPolicy: { decide: askAll },
		})) {
			// drain
		}
		expect(hookRan).toBe(false); // the hook was never consulted for the ask
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false); // no channel — no pause
		expect(resultOf(log)?.content).toContain("[Permission denied]");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false);
	});

	it("R-E 0.1.43: NEW logs write invocationSeq = the call's tool_call_end.seq on the identity-bearing events", async () => {
		// run 1: the chain-allow path — decided (by the extension), started,
		// succeeded, result — every writer carries the framework identity.
		const logA = new EventLog();
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log: logA,
			messages: [{ role: "user", content: "go" }],
			approvalPolicy: {
				decide: async () => ({ action: "allow" as const, decidedBy: "reader" }),
			},
		})) {
			// drain
		}
		const callSeqA = logA.all.find((e) => e.type === "tool_call_end")!.seq;
		const identityA = (e: Event) => (e as { invocationSeq?: number }).invocationSeq === callSeqA;
		expect(logA.all.some((e) => e.type === "permission_decided" && identityA(e))).toBe(true);
		expect(logA.all.some((e) => e.type === "tool_execution_started" && identityA(e))).toBe(true);
		expect(logA.all.some((e) => e.type === "tool_execution_succeeded" && identityA(e))).toBe(true);
		expect(logA.all.some((e) => e.type === "tool_result" && identityA(e))).toBe(true);

		// run 2: the human-ask path — request + decided (the approval
		// channel's answer), then the executed call.
		const logB = new EventLog();
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("shell", "s1", { command: "ls" })),
			model: "faux",
			registry: makeRegistry(),
			log: logB,
			messages: [{ role: "user", content: "go" }],
			approvalPolicy: { decide: askAll },
			resolveApproval: async () => ({ action: "allow" as const, decidedBy: "reader" }),
		})) {
			// drain
		}
		const callSeqB = logB.all.find((e) => e.type === "tool_call_end")!.seq;
		const identityB = (e: Event) => (e as { invocationSeq?: number }).invocationSeq === callSeqB;
		expect(logB.all.some((e) => e.type === "permission_requested" && identityB(e))).toBe(true);
		expect(logB.all.some((e) => e.type === "permission_decided" && identityB(e))).toBe(true);
		expect(logB.all.some((e) => e.type === "tool_execution_started" && identityB(e))).toBe(true);
		expect(logB.all.some((e) => e.type === "tool_result" && identityB(e))).toBe(true);

		// old logs (no invocationSeq anywhere) project and run unchanged —
		// the fallback stays legal end to end.
		const oldLog = new EventLog();
		oldLog.append({ type: "user_input", content: "go" });
		oldLog.append({ type: "tool_call_end", callId: "c1", name: "read_file", input: {} });
		oldLog.append({ type: "permission_decided", decisionId: "d-9", callId: "c1", decision: "approved", decidedBy: "reader" });
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "c1", {})),
			model: "faux",
			registry: makeRegistry(),
			log: oldLog,
		})) {
			// drain
		}
		expect(resultOf(oldLog)?.content).toBe("ok"); // the durable approval still executes
	});
});
