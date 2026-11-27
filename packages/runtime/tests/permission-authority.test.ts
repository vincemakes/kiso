/**
 * Permission authority requires invocationSeq (the owner's ruling,
 * 2026-11-27): "pre-invocationSeq permission authority gets no recovery
 * compatibility; legacy events stay readable, and legacy execution/receipt
 * evidence stays conservative so an old side effect is never repeated."
 *
 * The fresh path (core decideCall) and the resume path (recovery-plan)
 * must agree on the same old prefix: a decision or a request without
 * invocationSeq authorizes nothing, so the chain decides the call again
 * and only a fresh decision bound to the call's seq can execute it. Effect
 * evidence keeps its old-log binding: a legacy start or receipt still
 * proves the effect happened, and it is never re-run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type AgentDefinition } from "../src/index.js";
import { deriveRecoveryPlan } from "../src/recovery-plan.js";

const ran: number[] = [];
const probe = defineTool({
	name: "probe",
	description: "records that it ran",
	parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false },
	execute: async (input: { x: number }) => {
		ran.push(input.x);
		return { content: "ok", isError: false };
	},
});
const answering: Adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { seq: 0, type: "text_delta", text: "done" };
		yield { seq: 0, type: "stop", reason: "end_turn" };
	},
};

const USER = { seq: 0, type: "user_input", content: "go" };
const CALL = { seq: 1, type: "tool_call_end", callId: "c1", name: "probe", input: { x: 1 } };
const STOP = { seq: 2, type: "stop", reason: "tool_use" };
// the pre-round-5 shapes: no invocationSeq anywhere
const LEGACY_POLICY_ALLOW = { seq: 3, type: "permission_decided", decisionId: "d-old", callId: "c1", decision: "approved", decidedBy: "gate" };
const LEGACY_REQUEST = { seq: 3, type: "permission_requested", decisionId: "r-old", callId: "c1", name: "probe", input: { x: 1 } };
const LEGACY_HUMAN_ALLOW = { seq: 4, type: "permission_decided", decisionId: "r-old", callId: "c1", decision: "approved" };

async function resume(prefix: Record<string, unknown>[], verdict: "allow" | "deny") {
	ran.length = 0;
	let asked = 0;
	const dir = mkdtempSync(join(tmpdir(), "kiso-authority-"));
	const store = new SessionStore(dir);
	for (const e of prefix) await store.append("s", "r1", e as unknown as Event);
	await store.closeAll();
	const gate = { name: "gate", approvals: [{ decide: () => ((asked += 1), verdict === "allow" ? { action: "allow" as const } : { action: "deny" as const, reason: "refused now" }) }] };
	const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [probe], adapter: answering, extensions: [gate] } as AgentDefinition);
	const session = await agent.session({ id: "s" });
	const events: Event[] = [];
	for await (const e of session.resume()) events.push(e);
	await agent.close();
	return { events, asked, ran: [...ran] };
}

describe("permission authority requires invocationSeq (owner ruling 2026-11-27)", () => {
	it("plan: a legacy policy allow does not authorize a committed call — DECIDE_PERMISSION, never EXECUTE", () => {
		const log = [USER, CALL, STOP, LEGACY_POLICY_ALLOW] as unknown as Event[];
		expect(deriveRecoveryPlan(log, log)).toEqual({ kind: "DECIDE_PERMISSION", invocationSeq: 1 });
	});

	it("plan: a legacy request owns no invocation — its old approval does not execute; the call is decided again", () => {
		const log = [USER, CALL, STOP, LEGACY_REQUEST, LEGACY_HUMAN_ALLOW] as unknown as Event[];
		expect(deriveRecoveryPlan(log, log)).toEqual({ kind: "DECIDE_PERMISSION", invocationSeq: 1 });
	});

	it("resume: the old allow is ignored, the chain runs once, a fresh decision carries invocationSeq, and only its verdict governs", async () => {
		const r = await resume([USER, CALL, STOP, LEGACY_POLICY_ALLOW], "deny");
		expect(r.asked).toBe(1);
		const fresh = r.events.filter((e) => e.type === "permission_decided") as (Event & { type: "permission_decided" })[];
		expect(fresh).toHaveLength(1);
		expect(fresh[0]!.invocationSeq).toBe(1);
		expect(fresh[0]!.decision).toBe("denied");
		expect(r.ran).toEqual([]); // the legacy approval never executed it
	});

	it("resume: a legacy request with an old human approval — the chain decides again; a fresh allow executes once", async () => {
		const r = await resume([USER, CALL, STOP, LEGACY_REQUEST, LEGACY_HUMAN_ALLOW], "allow");
		expect(r.asked).toBe(1);
		const fresh = r.events.filter((e) => e.type === "permission_decided") as (Event & { type: "permission_decided" })[];
		expect(fresh.map((e) => e.invocationSeq)).toEqual([1]);
		expect(r.ran).toEqual([1]);
	});

	it("effect evidence stays conservative: a legacy start without a receipt is never re-executed or re-decided", () => {
		const started = { seq: 4, type: "tool_execution_started", executionId: "x-old", callId: "c1", name: "probe", input: { x: 1 } };
		const log = [USER, CALL, STOP, LEGACY_POLICY_ALLOW, started] as unknown as Event[];
		const plan = deriveRecoveryPlan(log, log);
		expect(plan.kind).not.toBe("EXECUTE");
		expect(plan.kind).not.toBe("DECIDE_PERMISSION");
	});

	it("effect evidence stays conservative: a legacy receipt without a result is repaired from the receipt, never re-run", () => {
		const started = { seq: 4, type: "tool_execution_started", executionId: "x-old", callId: "c1", name: "probe", input: { x: 1 } };
		const succeeded = { seq: 5, type: "tool_execution_succeeded", executionId: "x-old", callId: "c1", result: { content: "ok", isError: false } };
		const log = [USER, CALL, STOP, LEGACY_POLICY_ALLOW, started, succeeded] as unknown as Event[];
		expect(deriveRecoveryPlan(log, log)).toEqual({ kind: "REPAIR_RESULT", executionId: "x-old" });
	});

	it("a legacy tool_result still closes its call: nothing is decided or executed again", () => {
		const result = { seq: 4, type: "tool_result", callId: "c1", content: "ok", isError: false };
		const log = [USER, CALL, STOP, LEGACY_POLICY_ALLOW, result] as unknown as Event[];
		const plan = deriveRecoveryPlan(log, log);
		expect(plan.kind).not.toBe("EXECUTE");
		expect(plan.kind).not.toBe("DECIDE_PERMISSION");
	});
});
