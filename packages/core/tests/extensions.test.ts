/**
 * E1 — the extension approval policy chain (deny > ask > allow).
 *
 * The loop runs extension policies BEFORE the human flow: any deny wins
 * (the FIRST denial's reason), else any ask falls into the existing human
 * approval flow, and only an ALL-allow chain auto-approves — recorded
 * durably with the deciding extension's name (decidedBy), never pausing
 * for a human. A policy that throws counts as ask. A durable decision
 * recorded before a crash takes effect on resume: the chain never re-runs
 * (同构 alreadyReplaced — the deterministic decisionId is the key).
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { EventLog, loop, type Event, type PolicyVerdict } from "../src/index.js";

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

const allowAll = (): PolicyVerdict => ({ action: "allow" });
const askAll = (): PolicyVerdict => ({ action: "ask" });

/** One scripted turn that calls the named tool, then stops for it. */
function scriptedCall(name: string, callId: string, input: Record<string, unknown>): FauxScript {
	return [{ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] }];
}


const decided = (log: EventLog): (Event & { type: "permission_decided" })[] =>
	log.all.filter((e): e is Event & { type: "permission_decided" } => e.type === "permission_decided");
const resultOf = (log: EventLog): (Event & { type: "tool_result" }) | undefined =>
	log.all.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");

describe("E1: the policy chain composes deny > ask > allow", () => {
	it("deny outranks ask and allow — the FIRST denial's reason, decidedBy recorded, no human pause", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for await (const _ev of loop({
			adapter: createFauxProvider(
				scriptedCall("shell", "s1", { command: "git reset --hard" }) as FauxScript,
			),
			model: "faux",
			registry: makeRegistry(),
			log,
			approvalPolicies: [
				{ extension: "allow-all", policy: { decide: allowAll } },
				{
					extension: "danger-guard",
					policy: {
						decide: (call) =>
							call.name === "shell"
								? { action: "deny", reason: "no destructive git" }
								: { action: "allow" },
					},
				},
				{ extension: "ask-all", policy: { decide: askAll } },
			],
		})) {
			// drain
		}
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "denied", reason: "no destructive git", decidedBy: "danger-guard" });
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false); // never paused for a human
		expect(resultOf(log)).toMatchObject({ isError: true });
		expect(resultOf(log)?.content).toContain("[Permission denied] no destructive git");
	});

	it("ask outranks allow — the existing human flow pauses, decided WITHOUT decidedBy", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			hooks: { onPreTool: async () => ({ action: "defer" }) },
			resolveApproval: async () => ({ action: "allow" }),
			approvalPolicies: [
				{ extension: "ask-all", policy: { decide: askAll } },
				{ extension: "allow-all", policy: { decide: allowAll } },
			],
		})) {
			// drain
		}
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(true); // the ask reached the human flow
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]!.decision).toBe("approved");
		expect(ds[0]!.decidedBy).toBeUndefined(); // the HUMAN decided, not a policy
		expect(log.all.some((e) => e.type === "tool_result" && e.content === "ok")).toBe(true); // ran after the human allowed
	});

	it("all allow — auto-approved with the extension's name, never a human pause", async () => {
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
					return { action: "defer" };
				},
			},
			approvalPolicies: [
				{ extension: "reader", policy: { decide: allowAll } },
				{ extension: "writer", policy: { decide: allowAll } },
			],
		})) {
			// drain
		}
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(false);
		expect(hookRan).toBe(false); // 全 allow 自动放行 — the hook never ran
		const ds = decided(log);
		expect(ds).toHaveLength(1);
		expect(ds[0]).toMatchObject({ decision: "approved", decidedBy: "reader" });
		expect(log.all.some((e) => e.type === "tool_result" && e.content === "ok")).toBe(true);
	});
});

describe("E1: policy failures and absent flows degrade honestly", () => {
	it("a policy that throws counts as ask — the human flow decides", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			hooks: { onPreTool: async () => ({ action: "defer" }) },
			resolveApproval: async () => ({ action: "deny", reason: "human says no" }),
			approvalPolicies: [
				{
					extension: "broken",
					policy: {
						decide: () => {
							throw new Error("policy bug");
						},
					},
				},
				{ extension: "allow-all", policy: { decide: allowAll } },
			],
		})) {
			// drain
		}
		expect(log.all.some((e) => e.type === "permission_requested")).toBe(true);
		expect(resultOf(log)?.content).toContain("[Permission denied] human says no");
	});

	it("ask with no approval flow configured degrades to an honest denial", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for await (const _ev of loop({
			adapter: createFauxProvider(scriptedCall("read_file", "r1", { path: "a.ts" })),
			model: "faux",
			registry: makeRegistry(),
			log,
			approvalPolicies: [{ extension: "ask-all", policy: { decide: askAll } }],
		})) {
			// drain
		}
		expect(resultOf(log)?.content).toContain("[Permission denied]");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false); // never executed
	});
});

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
			approvalPolicies: [
				{
					extension: "reader",
					policy: {
						decide: () => {
							calls += 1;
							return { action: "ask" };
						},
					},
				},
			],
		})) {
			// drain
		}
		expect(calls).toBe(0); // policy 不重跑
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
			approvalPolicies: [
				{
					extension: "guard",
					policy: {
						decide: () => {
							calls += 1;
							return { action: "allow" };
						},
					},
				},
			],
		})) {
			// drain
		}
		expect(calls).toBe(0);
		expect(resultOf(log)?.content).toContain("[Permission denied] already denied");
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false);
	});
});

