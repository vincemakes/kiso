/**
 * B 组 — recovery is PER-RUN, keyed by StoreRecord.runId, and execution
 * identity is the executionId everywhere.
 *
 * - only the LAST unterminated run is recovered; earlier runs' dangling
 *   approvals are closed (never resurrected by a late approve);
 * - a multi-turn session (run 1 completed, run 2 paused) resumes run 2
 *   across processes and produces its second terminal;
 * - resolveUncertain takes an executionId, is idempotent, irreversible,
 *   and only transitions uncertain → rerun/abandoned;
 * - the resolution-was-persisted-but-tool_result-wasn't crash window is
 *   repaired on resume.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { defineTool, type Event, type Tool } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

function markerTool(markerPath: string): Tool<{ query: string }> {
	return defineTool<{ query: string }>({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		execute: async (input) => {
			writeFileSync(markerPath, input.query, "utf8");
			return { content: `results for ${input.query}`, isError: false };
		},
	});
}

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
// Two tool-calling turns: run 1 consumes turns 1-2, run 2 consumes 3-4.
const CALL_TWICE: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];
const CALL: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
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

describe("per-run recovery (B 组)", () => {
	it("run 1 completed, run 2 paused: resume recovers RUN 2 and produces its second terminal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		const agentA = agent(storeA, marker, CALL_TWICE);
		const sessionA = await agentA.session({ id: "s" });

		// Run 1: completes normally (script: CALL → stop → completed).
		for await (const ev of sessionA.run("first")) {
			if (ev.type === "permission_requested") sessionA.approve(ev.decisionId, true);
		}
		// Run 2: pauses on the deferred tool, then the process exits.
		for await (const ev of sessionA.run("second")) {
			if (ev.type === "permission_requested") break;
		}
		storeA.closeAll();

		// Process B resumes: the recovery must target run 2 (not run 1).
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, STOP);
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) {
			events.push(ev);
			if (ev.type === "permission_requested") sessionB.approve(ev.decisionId, true);
		}

		expect(readFileSync(marker, "utf8")).toBe("k"); // run 2's call ran once
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		// TWO terminals in the durable history — run 1's and run 2's.
		const records = storeB.load("s");
		const terminals = records.filter((r) => r.event.type === "terminal");
		expect(terminals).toHaveLength(2);
		// The resumed run adopted run 2's id: exactly two runIds total.
		expect(new Set(records.map((r) => r.runId)).size).toBe(2);
	});

	it("an aborted run's dangling approval is closed — resume never resurrects it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		const agentA = agent(storeA, marker, CALL);
		const sessionA = await agentA.session({ id: "s" });
		// Run 1 pauses; the USER ABORTS — the run ends with an aborted
		// TERMINAL, its approval still unanswered (dead).
		const run1 = sessionA.run("first");
		for await (const ev of run1) {
			if (ev.type === "permission_requested") run1.abort();
		}
		storeA.closeAll();

		// Run 2 completes in a new process.
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, STOP);
		const sessionB = await agentB.session({ id: "s" });
		for await (const _ev of sessionB.run("second")) {
			// drain
		}
		storeB.closeAll();

		// The dangling approval of the ABORTED run 1 is dead: not
		// re-presented, and nothing to resume.
		const storeC = new SessionStore(dir);
		const agentC = agent(storeC, marker, STOP);
		const sessionC = await agentC.session({ id: "s" });
		expect(sessionC.pendingApprovals()).toEqual([]);
		const resumed: Event[] = [];
		for await (const ev of sessionC.resume()) resumed.push(ev);
		expect(resumed).toEqual([]); // nothing to resume — both runs terminated
		expect(existsSync(marker)).toBe(false); // run 1's tool never ran
	});

	it("a late approve() on an ABORTED run writes nothing and executes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const marker = join(dir, "m.txt");
		const storeA = new SessionStore(dir);
		const agentA = agent(storeA, marker, CALL);
		const sessionA = await agentA.session({ id: "s" });
		let decisionId = "";
		const run1 = sessionA.run("first");
		for await (const ev of run1) {
			if (ev.type === "permission_requested") {
				decisionId = ev.decisionId;
				run1.abort(); // the user cancels — the run terminates (aborted)
			}
		}
		storeA.closeAll();

		// The run is terminated; a later approve() must not resurrect it.
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, STOP);
		const sessionB = await agentB.session({ id: "s" });
		sessionB.approve(decisionId, true);
		const records = storeB.load("s");
		expect(records.some((r) => r.event.type === "permission_decided")).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("execution identity across runs (B 组)", () => {
	it("the same provider callId in two different runs is two independent executions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const marker = join(dir, "m.txt");
		const store = new SessionStore(dir);
		const agentA = agent(store, marker, CALL);
		const sessionA = await agentA.session({ id: "s" });
		for await (const ev of sessionA.run("first")) {
			if (ev.type === "permission_requested") sessionA.approve(ev.decisionId, true); // executes c1
		}
		store.closeAll();

		const storeB = new SessionStore(dir);
		const agentB = agent(storeB, marker, STOP);
		const sessionB = await agentB.session({ id: "s" });
		for await (const _ev of sessionB.run("second")) {
			// drain — run 2 does NOT call the tool
		}
		storeB.closeAll();
		const { executionLedger } = await import("@kiso/core");
		const ledger = executionLedger(storeB.load("s").map((r) => r.event));
		const executions = [...ledger.values()].filter((e) => e.callId === "c1");
		expect(executions).toHaveLength(1); // only run 1's c1
		// A NEW run issuing c1 again is a new executionId:
		const storeC = new SessionStore(dir);
		const agentC = agent(storeC, marker, CALL);
		const sessionC = await agentC.session({ id: "s" });
		for await (const ev of sessionC.run("third")) {
			if (ev.type === "permission_requested") sessionC.approve(ev.decisionId, true);
		}
		const ledger2 = executionLedger(storeC.load("s").map((r) => r.event));
		const c1s = [...ledger2.values()].filter((e) => e.callId === "c1");
		expect(c1s).toHaveLength(2);
		expect(new Set(c1s.map((e) => e.executionId)).size).toBe(2);
	});

	it("two uncertain executions are resolved independently, idempotently, irreversibly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const store = new SessionStore(dir);
		// Two interrupted executions, both uncertain.
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "a" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "a" } });
		store.append("s", "r1", { seq: 3, type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "b" } });
		store.append("s", "r1", { seq: 4, type: "tool_execution_started", executionId: "ex-4", callId: "c2", name: "web_search", input: { query: "b" } });
		store.closeAll();

		const agentA = agent(new SessionStore(dir), join(dir, "m.txt"));
		const session = await agentA.session({ id: "s" });
		const uncertain = session.uncertainExecutions();
		expect(uncertain.map((u) => u.executionId).sort()).toEqual(["ex-2", "ex-4"]);

		// Resolve one as rerun, the other as abandoned — by executionId.
		session.resolveUncertain("ex-2", "rerun");
		session.resolveUncertain("ex-4", "abandoned");
		expect(session.uncertainExecutions()).toEqual([]);
		// Idempotent: re-resolving does nothing.
		session.resolveUncertain("ex-2", "abandoned");
		const records = session.log.all.filter((e) => e.type === "tool_execution_resolved");
		expect(records).toHaveLength(2);
		// Irreversible: a resolved execution is not uncertain anymore.
		expect(session.uncertainExecutions()).toEqual([]);
		// Unknown executionId → loud error.
		expect(() => session.resolveUncertain("ex-999", "rerun")).toThrow(/no execution/);
	});

	it("resolution persisted but tool_result lost (crash window) is repaired on resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rr-"));
		const store = new SessionStore(dir);
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		// The resolution landed…
		store.append("s", "r1", { seq: 3, type: "tool_execution_resolved", executionId: "ex-2", callId: "c1", resolution: "abandoned" });
		// …but the process crashed before the tool_result fill was written.
		store.closeAll();

		const agentA = agent(new SessionStore(dir), join(dir, "m.txt"));
		const session = await agentA.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		// The fill is repaired: the model is not left staring at a dangling
		// tool_use, and the run completes.
		const filled = events.find((e) => e.type === "tool_result");
		expect(filled).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});
});

