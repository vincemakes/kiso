/**
 * 0430-F1 — the fresh path and the recovery path record the same
 * decisions.
 *
 * The recovery's decision step used to write a `permission_decided`
 * stamped "mode:default" for verdicts the fresh path never records (the
 * default allow, an onPreTool allow or deny), so the same durable prefix
 * grew two different histories depending on whether the process had
 * crashed; and it skipped the fresh path's preflight (unknown tool,
 * unparsable arguments, a schema failure), executing what the kernel
 * would have refused. Now: persist facts, derive state — the recovery
 * understands the fresh log instead of the fresh log bending to the
 * recovery. Every test here runs the same committed call fresh and
 * recovered (the recovery seeded with the turn up to its stop, minus the
 * call's outcome events, re-numbered) and compares the two OUTCOME
 * histories shape for shape. The claim, exactly: for a committed
 * invocation whose execution has not started, the recovery adds no
 * permission fact the fresh path would not; the exact-prefix,
 * seq-for-seq case (a real fresh log cut before its started event) is
 * raw-input.test.ts's parity test.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, END_TURN, type Adapter, type AdapterEvent, type Event, type HookHost, type ToolContext } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type AgentDefinition } from "../src/index.js";

/** The model: one call (its shape per test), then an answer. */
function model(call: { name: string; input: Record<string, unknown> | null }): Adapter {
	let n = 0;
	return {
		stream: async function* (): AsyncIterable<AdapterEvent> {
			n += 1;
			if (n === 1) {
				yield { seq: 0, type: "tool_call_start", callId: "c1", name: call.name };
				yield { seq: 0, type: "tool_call_input_delta", callId: "c1", inputJsonDelta: JSON.stringify(call.input ?? {}) };
				yield { seq: 0, type: "tool_call_end", callId: "c1", name: call.name, input: call.input as Record<string, unknown> };
				yield { seq: 0, type: "stop", reason: "tool_use" };
			} else {
				yield { seq: 0, type: "text_delta", text: "done" };
				yield { seq: 0, type: "stop", reason: "end_turn" };
			}
		},
	};
}
const answering: Adapter = {
	stream: async function* (): AsyncIterable<AdapterEvent> {
		yield { seq: 0, type: "text_delta", text: "done" };
		yield { seq: 0, type: "stop", reason: "end_turn" };
	},
};

const seen: ToolContext[] = [];
const probe = defineTool({
	name: "probe",
	description: "records its context",
	parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false },
	execute: async (_input, ctx) => {
		seen.push(ctx);
		return { content: "ok", isError: false };
	},
});

const shape = (e: Event): string => {
	const parts: string[] = [e.type];
	if (e.type === "permission_decided") parts.push(e.decision, e.decidedBy ?? "-");
	if (e.type === "tool_result") parts.push(String(e.isError), (e as { errorKind?: string }).errorKind ?? "-", ((e as { tags?: readonly string[] }).tags ?? []).join("+"), typeof e.content === "string" ? e.content.slice(0, 40) : "blocks");
	if (e.type === "tool_execution_started") parts.push(e.executionId);
	return parts.join(" ");
};

const OUTCOME = new Set(["permission_requested", "permission_decided", "tool_execution_started", "tool_execution_succeeded", "tool_execution_failed", "tool_result"]);

/** Run the call fresh; then seed a second store with the same durable
 *  prefix — everything up to and including the turn's stop, MINUS the
 *  call's outcome events (a crash between the stop and the first outcome
 *  event; on the fresh path a fast outcome can land before the stop, so
 *  the outcome is compared by type, not by position) — and resume. Returns
 *  both outcome histories (shape by shape) and both handler contexts. */
async function bothPaths(call: { name: string; input: Record<string, unknown> | null }, def: Partial<AgentDefinition> = {}) {
	seen.length = 0;
	const dirA = mkdtempSync(join(tmpdir(), "kiso-parity-fresh-"));
	const storeA = new SessionStore(dirA);
	const agentA = createAgent({ model: "faux", store: storeA, tools: [probe], adapter: model(call), ...def } as AgentDefinition);
	const sessionA = await agentA.session({ id: "s" });
	for await (const _ of sessionA.run("go")) void _;
	const logA = [...sessionA.log.all];
	const freshCtx = seen[0];
	agentA.close();

	const callEnd = logA.findIndex((e) => e.type === "tool_call_end");
	const stopAt = logA.findIndex((e, i) => e.type === "stop" && i > callEnd);
	const prefix = logA.slice(0, stopAt + 1).filter((e) => !OUTCOME.has(e.type));
	const dirB = mkdtempSync(join(tmpdir(), "kiso-parity-resume-"));
	const seedStore = new SessionStore(dirB);
	let seq = 0;
	for (const e of prefix) await seedStore.append("s", "r1", { ...e, seq: seq++ } as Event);
	seedStore.closeAll();
	seen.length = 0;
	const agentB = createAgent({ model: "faux", store: new SessionStore(dirB), tools: [probe], adapter: answering, ...def } as AgentDefinition);
	const sessionB = await agentB.session({ id: "s" });
	for await (const _ of sessionB.resume()) void _;
	const logB = [...sessionB.log.all];
	const resumedCtx = seen[0];
	agentB.close();

	const outcome = (log: Event[]) => log.filter((e) => OUTCOME.has(e.type)).map(shape);
	return { fresh: outcome(logA), resumed: outcome(logB), freshCtx, resumedCtx, logA, logB };
}

describe("0430-F1: the same durable prefix, fresh and recovered, writes the same decisions", () => {
	it("the default allow (no chain, no hook): no decision event on either path; the same outcome shape, and — when the fresh outcome came after the stop — the same executionId (raw-input.test.ts proves the exact-prefix case unconditionally)", async () => {
		const r = await bothPaths({ name: "probe", input: { x: 1 } });
		expect(r.fresh).toEqual(r.resumed);
		expect(r.fresh.some((s) => s.startsWith("permission_decided"))).toBe(false);
		const { signal: _a, ...fresh } = r.freshCtx!;
		const { signal: _b, ...resumed } = r.resumedCtx!;
		expect(resumed.sessionId).toBe(fresh.sessionId);
		expect(resumed.callId).toBe(fresh.callId);
		expect(resumed.rawInput).toBe(fresh.rawInput);
		expect(Object.keys(resumed).sort()).toEqual(Object.keys(fresh).sort());
		// executionId: the started seq is a function of the durable prefix; on the
		// fresh path a fast outcome may land BEFORE the stop, so the two prefixes
		// can differ by position even though they hold the same facts — compare
		// the id each path wrote, and assert equality when the fresh outcome came
		// after the stop (the crash shape the resume reproduces exactly).
		const freshStarted = r.logA.find((e) => e.type === "tool_execution_started") as (Event & { type: "tool_execution_started" }) | undefined;
		const resumedStarted = r.logB.find((e) => e.type === "tool_execution_started") as (Event & { type: "tool_execution_started" }) | undefined;
		expect(fresh.executionId).toBe(freshStarted?.executionId);
		expect(resumed.executionId).toBe(resumedStarted?.executionId);
		const stopSeq = (r.logA.find((e) => e.type === "stop") as Event).seq;
		if (freshStarted!.seq > stopSeq) expect(resumed.executionId).toBe(fresh.executionId);
	});

	it("onPreTool allow: no decision event on either path", async () => {
		const hooks: HookHost = { onPreTool: async () => ({ action: "allow" }) };
		const r = await bothPaths({ name: "probe", input: { x: 1 } }, { hooks });
		expect(r.fresh).toEqual(r.resumed);
		expect(r.fresh.some((s) => s.startsWith("permission_decided"))).toBe(false);
	});

	it("onPreTool deny: one denial result with the same tags on both paths, no decision event, no execution", async () => {
		const hooks: HookHost = { onPreTool: async () => ({ action: "deny", reason: "not now" }) };
		const r = await bothPaths({ name: "probe", input: { x: 1 } }, { hooks });
		expect(r.fresh).toEqual(r.resumed);
		expect(r.fresh.some((s) => s.startsWith("tool_result true precondition denied"))).toBe(true);
		expect(r.fresh.some((s) => s.startsWith("tool_execution_started"))).toBe(false);
		expect(r.resumedCtx).toBeUndefined();
	});

	it("a speaking chain's allow: the SAME decision event on both paths (the row that was already right)", async () => {
		const gate = { name: "gate", approvals: [{ decide: () => ({ action: "allow" as const }) }] };
		const r = await bothPaths({ name: "probe", input: { x: 1 } }, { extensions: [gate] } as Partial<AgentDefinition>);
		expect(r.fresh).toEqual(r.resumed);
		expect(r.fresh.filter((s) => s.startsWith("permission_decided approved gate"))).toHaveLength(1); // decidedBy = the speaking extension
	});

	it("the preflight: an unknown tool, unparsable arguments and a schema failure are refused the same way on both paths — one invalid_input result, no decision, no execution", async () => {
		for (const call of [
			{ name: "ghost", input: { x: 1 } },
			{ name: "probe", input: null },
			{ name: "probe", input: { x: "not a number" } },
		]) {
			const r = await bothPaths(call);
			expect(r.fresh, JSON.stringify(call)).toEqual(r.resumed);
			expect(r.fresh.filter((s) => s.startsWith("tool_result true invalid_input"))).toHaveLength(1);
			expect(r.fresh.some((s) => s.startsWith("permission_decided") || s.startsWith("tool_execution_started"))).toBe(false);
		}
	});

	it("a crash after the started receipt, before the result, with no decision on disk: the recovery repairs from the receipt and invents no decision", async () => {
		seen.length = 0;
		const dirA = mkdtempSync(join(tmpdir(), "kiso-parity-crash-"));
		const storeA = new SessionStore(dirA);
		const agentA = createAgent({ model: "faux", store: storeA, tools: [probe], adapter: model({ name: "probe", input: { x: 1 } }) });
		const sessionA = await agentA.session({ id: "s" });
		for await (const _ of sessionA.run("go")) void _;
		const logA = [...sessionA.log.all];
		agentA.close();
		const cut = logA.findIndex((e) => e.type === "tool_result");
		const dirB = mkdtempSync(join(tmpdir(), "kiso-parity-crash-resume-"));
		const seedStore = new SessionStore(dirB);
		for (const e of logA.slice(0, cut)) await seedStore.append("s", "r1", e); // started + succeeded receipt on disk, no result
		seedStore.closeAll();
		seen.length = 0;
		const agentB = createAgent({ model: "faux", store: new SessionStore(dirB), tools: [probe], adapter: answering });
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) events.push(ev);
		expect(seen, "never re-executed").toHaveLength(0);
		expect(events.some((e) => e.type === "permission_decided"), "no fabricated decision").toBe(false);
		expect(events.find((e) => e.type === "tool_result")).toMatchObject({ callId: "c1", content: "ok", isError: false });
		expect(events.find((e) => e.type === "terminal")).toMatchObject({ outcome: { kind: "completed" } });
	});

	it("END_TURN on a recovered denial path stays a tool's own fact: an executed tool's tagged result ends the run after recovery too", async () => {
		const ender = defineTool({ name: "ender", description: "ends", parameters: { type: "object" }, execute: async () => ({ content: "asked", isError: false, tags: [END_TURN] }) });
		const dir = mkdtempSync(join(tmpdir(), "kiso-parity-end-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "ender", input: {} });
		await store.append("s", "r1", { seq: 2, type: "stop", reason: "tool_use" });
		store.closeAll();
		let calls = 0;
		const counting: Adapter = { stream: async function* () { calls += 1; yield* answering.stream({} as never); } };
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [ender], adapter: counting });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		expect(calls).toBe(0);
		expect(events.some((e) => e.type === "permission_decided")).toBe(false);
		expect(events.find((e) => e.type === "terminal")).toMatchObject({ outcome: { kind: "completed" } });
	});
});

describe("0430-F1: a callId re-used by another invocation lends it nothing on recovery", () => {
	it("A (undecided, unexecuted) and B (a speaking chain's decision, executed) share a callId: recovering A decides A on its own — never B's decision, never B's result", async () => {
		// An artificial but legal log for the plan's contract: the reused id is
		// the openai no-id fallback's shape. B carries invocationSeq on every
		// outcome event; A has none of them.
		const dir = mkdtempSync(join(tmpdir(), "kiso-parity-reuse-"));
		const store = new SessionStore(dir);
		const ev = async (e: Record<string, unknown>) => store.append("s", "r1", e as unknown as Event);
		await ev({ seq: 0, type: "user_input", content: "go" });
		await ev({ seq: 1, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 1 } }); // A
		await ev({ seq: 2, type: "stop", reason: "tool_use" });
		await ev({ seq: 3, type: "tool_call_end", callId: "call_0", name: "probe", input: { x: 2 } }); // B
		await ev({ seq: 4, type: "stop", reason: "tool_use" });
		await ev({ seq: 5, type: "permission_decided", decisionId: "d-5", callId: "call_0", invocationSeq: 3, decision: "denied", reason: "B is refused", decidedBy: "gate" });
		await ev({ seq: 6, type: "tool_result", callId: "call_0", invocationSeq: 3, content: "[Permission denied] B is refused", isError: true, errorKind: "precondition", tags: ["denied"] });
		store.closeAll();
		seen.length = 0;
		const agent = createAgent({ model: "faux", store: new SessionStore(dir), tools: [probe], adapter: answering });
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const e of session.resume()) events.push(e);
		// A was decided on its own (the default allow) and executed with A's input
		expect(seen).toHaveLength(1);
		expect((seen[0] as ToolContext & { x?: number }).callId).toBe("call_0");
		const started = events.find((e) => e.type === "tool_execution_started") as (Event & { type: "tool_execution_started" }) | undefined;
		expect(started?.invocationSeq).toBe(1);
		expect(started?.input).toEqual({ x: 1 });
		// B's denial was not repaired onto A, and no decision was fabricated
		expect(events.filter((e) => e.type === "permission_decided")).toHaveLength(0);
		const results = events.filter((e) => e.type === "tool_result") as (Event & { type: "tool_result" })[];
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.invocationSeq).toBe(1);
	});
});
