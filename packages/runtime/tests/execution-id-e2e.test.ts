/**
 * round 4 — executionId is the ONLY recovery key, end to end.
 *
 * 1. recover pairs receipts/resolutions/failures by executionId, never by
 *    the repeatable provider callId; a new successful execution is not
 *    polluted by a historical same-callId failure.
 * 2. tool_result carries its executionId; repair and fills pair by it.
 * 3. resolutions are attributed to the ORIGINAL runId (no fake "resolution"
 *    runId) and are appended/persisted/yielded exactly once.
 * 4. a non-idempotent failure AFTER a cross-process approval enters a
 *    durable uncertain pause — provider and siblings stop until a human
 *    decides.
 * 5. multiple open runs are REFUSED at the persistence layer.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { executionLedger, defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

function markerTool(markerPath: string, opts: { fail?: boolean } = {}): Tool<{ query: string }> {
	return defineTool<{ query: string }>({
		name: "web_search",
		description: "S",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		execute: async (input) => {
			writeFileSync(markerPath, input.query, "utf8");
			return opts.fail
				? { content: "failed after side effect", isError: true, errorKind: "fatal" as const }
				: { content: `results for ${input.query}`, isError: false };
		},
	});
}

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
const CALL: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function agent(store: SessionStore, markerPath: string, script: FauxScript = STOP) {
	return createAgent({
		model: "faux",
		store,
		tools: [markerTool(markerPath)],
		adapter: createFauxProvider(script),
		permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
	});
}

const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal");

describe("execution identity end to end (round 4)", () => {
	it("a new successful execution is NOT polluted by a historical same-callId failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		// Run 1: the same callId FAILS (uncertain).
		const agentA = createAgent({
			model: "faux",
			store: storeA,
			tools: [markerTool(marker, { fail: true })],
			adapter: createFauxProvider(CALL),
		});
		const sessionA = await agentA.session({ id: "s" });
		const run1 = sessionA.run("first");
		for await (const ev of run1) {
			if (ev.type === "uncertain_pending") await sessionA.resolveUncertain(ev.executionId, "abandoned");
		}
		storeA.closeAll();

		// Run 2: the SAME callId SUCCEEDS — it must not inherit run 1's
		// failure, must not emit a stale uncertain_pending, and must not
		// deadlock.
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, CALL);
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.run("second")) {
			events.push(ev);
			if (ev.type === "permission_requested") await sessionB.approve(ev.decisionId, true);
		}
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false); // not polluted
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		// Two executions, two ids.
		const ledger = executionLedger(storeB.load("s").map((r) => r.event));
		expect(ledger.size).toBe(2);
	});

	it("resolutions are attributed to the ORIGINAL runId — never the fake 'resolution'", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const store = new SessionStore(dir);
		await store.append("s", "run-one", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "run-one", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-one", {
			seq: 2,
			type: "tool_execution_started",
			executionId: "ex-2",
			callId: "c1",
			name: "web_search",
			input: { query: "k" },
		});
		store.closeAll();

		const session = await agent(new SessionStore(dir), join(dir, "m.txt")).session({ id: "s" });
		await session.resolveUncertain("ex-2", "abandoned");
		const records = new SessionStore(dir).load("s");
		// Every record after the crash belongs to the ORIGINAL run.
		for (const r of records) {
			expect(r.runId).toBe("run-one");
		}
		expect(records.some((r) => r.runId === "resolution")).toBe(false);
	});

	it("a non-idempotent failure after a cross-process approval is a clean failure with the note — no pause (ruling #12)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		const agentA = agent(storeA, marker, CALL);
		const sessionA = await agentA.session({ id: "s" });
		for await (const ev of sessionA.run("first")) {
			if (ev.type === "permission_requested") break; // pause, then exit
		}
		storeA.closeAll();

		// Process B resumes and approves; the resumed execution FAILS
		// non-idempotently — the receipt IS the outcome: a clean failure
		// with the honest note, no uncertain pause (ADR-0038).
		const storeB = new SessionStore(dir);
		const agentB = createAgent({
			model: "faux",
			store: storeB,
			tools: [markerTool(marker, { fail: true })],
			adapter: createFauxProvider(STOP),
		});
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) {
			events.push(ev);
			if (ev.type === "permission_requested") {
				await sessionB.approve(ev.decisionId, true);
			}
		}
		expect(events.some((e) => e.type === "uncertain_pending")).toBe(false);
		const result = events.find((e): e is Event & { type: "tool_result" } => e.type === "tool_result");
		expect(String(result?.content ?? "")).toContain("non-idempotent tool failed");
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		// The failure's receipt pairs by executionId — never the repeatable callId.
		const records = storeB.load("s");
		expect(records.some((r) => r.event.type === "tool_execution_failed")).toBe(true);
	});

	it("receipt repair pairs by executionId — a same-callId result from an earlier execution never suppresses the fill", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const store = new SessionStore(dir);
		// run-zero is TERMINATED and its callId-c1 execution has a result.
		await store.append("s", "run-zero", { seq: 0, type: "user_input", content: "zero" });
		await store.append("s", "run-zero", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-zero", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-zero", { seq: 3, type: "tool_execution_succeeded", executionId: "ex-2", callId: "c1", result: { content: "old ok", isError: false } });
		await store.append("s", "run-zero", { seq: 4, type: "tool_result", callId: "c1", content: "old ok", isError: false, executionId: "ex-2" });
		await store.append("s", "run-zero", { seq: 5, type: "stop", reason: "end_turn" });
		await store.append("s", "run-zero", { seq: 6, type: "terminal", outcome: { kind: "completed" } });
		// run-one is OPEN: its execution SUCCEEDED but the tool_result never
		// landed (crash between the receipt and the result). The receipt's
		// callId is c1 again — only the executionId distinguishes it.
		await store.append("s", "run-one", { seq: 7, type: "user_input", content: "one" });
		await store.append("s", "run-one", { seq: 8, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-one", { seq: 9, type: "tool_execution_started", executionId: "ex-9", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-one", { seq: 10, type: "tool_execution_succeeded", executionId: "ex-9", callId: "c1", result: { content: "new ok", isError: false } });
		store.closeAll();

		const session = await agent(new SessionStore(dir), join(dir, "m.txt")).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		// The repair fill exists, keyed ex-9 — NOT suppressed by run-zero's
		// same-callId ex-2 result, and carries ITS executionId.
		const fill = events.find(
			(e): e is Event & { type: "tool_result"; executionId?: string } =>
				e.type === "tool_result" && (e as { executionId?: string }).executionId === "ex-9",
		);
		expect(fill).toBeDefined();
		expect(fill!.isError).toBe(false);
		expect(fill!.content).toBe("new ok");
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		// The fill is durable, attributed to the ORIGINAL run.
		const records = new SessionStore(dir).load("s");
		const fillRecord = records.find((r) => r.event.type === "tool_result" && (r.event as { executionId?: string }).executionId === "ex-9");
		expect(fillRecord?.runId).toBe("run-one");
	});

	it("resolution crash window fills by executionId — a same-callId result from an earlier execution never suppresses it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const store = new SessionStore(dir);
		// run-zero is TERMINATED with a same-callId result.
		await store.append("s", "run-zero", { seq: 0, type: "user_input", content: "zero" });
		await store.append("s", "run-zero", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-zero", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-zero", { seq: 3, type: "tool_execution_succeeded", executionId: "ex-2", callId: "c1", result: { content: "old ok", isError: false } });
		await store.append("s", "run-zero", { seq: 4, type: "tool_result", callId: "c1", content: "old ok", isError: false, executionId: "ex-2" });
		await store.append("s", "run-zero", { seq: 5, type: "stop", reason: "end_turn" });
		await store.append("s", "run-zero", { seq: 6, type: "terminal", outcome: { kind: "completed" } });
		// run-one is OPEN: the human resolved ex-8 (started, no result —
		// the uncertain execution) but the crash hit before the denial fill.
		await store.append("s", "run-one", { seq: 7, type: "user_input", content: "one" });
		await store.append("s", "run-one", { seq: 8, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-one", { seq: 9, type: "tool_execution_started", executionId: "ex-9", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "run-one", { seq: 10, type: "tool_execution_resolved", executionId: "ex-9", callId: "c1", resolution: "abandoned" });
		store.closeAll();

		const session = await agent(new SessionStore(dir), join(dir, "m.txt")).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		const fill = events.find(
			(e): e is Event & { type: "tool_result"; executionId?: string } =>
				e.type === "tool_result" && (e as { executionId?: string }).executionId === "ex-9",
		);
		expect(fill).toBeDefined();
		expect(fill!.isError).toBe(true);
		expect(String(fill!.content)).toContain("abandoned");
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		const records = new SessionStore(dir).load("s");
		const fillRecord = records.find((r) => r.event.type === "tool_result" && (r.event as { executionId?: string }).executionId === "ex-9");
		expect(fillRecord?.runId).toBe("run-one");
	});

	it("live and resume agree on execution identity and outcome for the same interaction", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const marker = join(dir, "m.txt");
		// Live: pause at the approval, approve, run to the terminal.
		const liveStore = new SessionStore(dir);
		const live = await agent(liveStore, marker, CALL).session({ id: "s" });
		const liveEvents: Event[] = [];
		for await (const ev of live.run("hello")) {
			liveEvents.push(ev);
			if (ev.type === "permission_requested") await live.approve(ev.decisionId, true);
		}
		liveStore.closeAll();

		// Resume: same durable prefix, crash at the pause, approve, run on.
		const resumeDir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const resumeStore = new SessionStore(resumeDir);
		const before = await agent(resumeStore, marker, CALL).session({ id: "s" });
		for await (const ev of before.run("hello")) {
			if (ev.type === "permission_requested") break; // pause, then exit
		}
		resumeStore.closeAll();

		const after = await agent(new SessionStore(resumeDir), marker, CALL).session({ id: "s" });
		const resumeEvents: Event[] = [];
		for await (const ev of after.resume()) {
			resumeEvents.push(ev);
			if (ev.type === "permission_requested") await after.approve(ev.decisionId, true);
		}

		// The executionId is POSITION-derived (`ex-<seq>` of the started
		// event — deterministic per log, on the live and the recovery paths
		// alike; 0.1.26 the streaming execution lands the approval pause
		// BEFORE the stop, so the two paths' base logs differ by one event
		// and the positions differ — the contract is the derivation, never
		// a guessed value). Each path's receipts pair by its own id.
		const liveStarted = liveEvents.find((e) => e.type === "tool_execution_started");
		const resumeStarted = resumeEvents.find((e) => e.type === "tool_execution_started");
		expect(liveStarted).toBeDefined();
		expect(resumeStarted).toBeDefined();
		expect(liveStarted!.executionId).toBe(`ex-${liveStarted!.seq}`);
		expect(resumeStarted!.executionId).toBe(`ex-${resumeStarted!.seq}`);
		for (const ev of [liveEvents, resumeEvents]) {
			const started = ev.find((e) => e.type === "tool_execution_started");
			expect(ev.some((e) => e.type === "tool_execution_succeeded" && e.executionId === started!.executionId)).toBe(true);
			expect(ev.some((e) => e.type === "tool_result" && e.executionId === started!.executionId)).toBe(true);
		}
		expect(terminalOf(liveEvents)?.outcome.kind).toBe("completed");
		expect(terminalOf(resumeEvents)?.outcome.kind).toBe("completed");
	});

	it("multiple open runs are REFUSED at the persistence layer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-eid-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		const agentA = agent(storeA, marker, CALL);
		const sessionA = await agentA.session({ id: "s" });
		// Run 1 pauses and is abandoned (open, undecided, no terminal).
		for await (const ev of sessionA.run("first")) {
			if (ev.type === "permission_requested") break;
		}
		storeA.closeAll();

		// Run 2 must be REFUSED: an earlier run is still open.
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, STOP);
		const sessionB = await agentB.session({ id: "s" });
		await expect(async () => {
			for await (const _ev of sessionB.run("second")) {
				// never
			}
		}).rejects.toThrow(/open run|resume/i);
	});
});
