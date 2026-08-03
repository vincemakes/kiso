/**
 * Phase D — the runtime surface for approvals and uncertain executions:
 * session.approve resumes a paused run; a reloaded session re-presents
 * pending approvals and uncertain executions; resolutions are durable.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { defineTool, type Event } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

const SEARCH_SCRIPT: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function searchAgent(store: SessionStore) {
	return createAgent({
		model: "faux",
		store,
		tools: [
			defineTool<{ query: string }>({
				name: "web_search",
				description: "Search",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				execute: async (input) => ({ content: `results for ${input.query}`, isError: false }),
			}),
		],
		adapter: createFauxProvider(SEARCH_SCRIPT),
		permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
	});
}

describe("session.approve", () => {
	it("approve(true) resumes the paused run; the tool executes and the run completes", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-appr-")));
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("search")) {
			events.push(ev);
			if (ev.type === "permission_requested") {
				expect(session.pendingApprovals().map((p) => p.decisionId)).toContain(ev.decisionId);
				session.approve(ev.decisionId, true);
			}
		}
		const terminal = events.find((e) => e.type === "terminal");
		expect(terminal).toMatchObject({ outcome: { kind: "completed" } });
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
		// The approval is durable: reloaded session has no pending approvals.
		const reloaded = await agent.session({ id: "s" });
		expect(reloaded.pendingApprovals()).toEqual([]);
	});

	it("approve(false) denies: the tool never executes, the denial is durable", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-appr-")));
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("search")) {
			events.push(ev);
			if (ev.type === "permission_requested") session.approve(ev.decisionId, false);
		}
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		const reloaded = await agent.session({ id: "s" });
		expect(reloaded.pendingApprovals()).toEqual([]);
		expect(reloaded.log.all.some((e) => e.type === "permission_decided" && e.decision === "denied")).toBe(true);
	});

	it("a reloaded session re-presents an approval that was never answered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-appr-"));
		const store = new SessionStore(dir);
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		// Consume until the pause, then abandon the run (the CLI exits).
		for await (const ev of session.run("search")) {
			if (ev.type === "permission_requested") break;
		}
		// Process restart: fresh store handle, fresh agent.
		store.closeAll(); // old process released its writer lock
		const store2 = new SessionStore(dir);
		const agent2 = searchAgent(store2);
		const reloaded = await agent2.session({ id: "s" });
		const pending = reloaded.pendingApprovals();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.name).toBe("web_search");
		// Answering persists and clears it.
		reloaded.approve(pending[0]!.decisionId, false);
		const again = await agent2.session({ id: "s" });
		expect(again.pendingApprovals()).toEqual([]);
	});

	it("approve() is idempotent — a second answer never writes a contradictory decision (review finding 7)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-appr-"));
		const store = new SessionStore(dir);
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.run("search")) {
			events.push(ev);
			if (ev.type === "permission_requested") {
				session.approve(ev.decisionId, true); // the live answer
				session.approve(ev.decisionId, false); // a stray second answer
			}
		}
		const decided = store
			.load("s")
			.filter((r) => r.event.type === "permission_decided")
			.map((r) => (r.event as { decision: string }).decision);
		expect(decided).toEqual(["approved"]); // exactly one, the first
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
	});
});

describe("uncertain executions", () => {
	function crashedStore(): { dir: string; store: SessionStore } {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		// Simulate a crash mid-execution: started is durable, no result ever
		// followed, and the run has no terminal.
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		return { dir, store };
	}

	it("lists interrupted executions as uncertain; resume() refuses until resolved", async () => {
		const { store } = crashedStore();
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		const uncertain = session.uncertainExecutions();
		expect(uncertain).toHaveLength(1);
		expect(uncertain[0]).toMatchObject({ callId: "c1", name: "web_search", status: "uncertain" });

		// The continuation is BLOCKED until a human decides — the model is
		// never silently allowed past an interrupted side effect.
		await expect(async () => {
			for await (const _ev of session.resume()) {
				// never reached
			}
		}).rejects.toThrow(/uncertain|resolve/i);
	});

	it("a NEW logical call with the same input executes normally even after an uncertain one", async () => {
		const { store } = crashedStore();
		// The recovery (resume) consumes its own provider turns, and the new
		// run consumes its own — the script has four turns so neither starves.
		const agent = createAgent({
			model: "faux",
			store,
			tools: [
				defineTool<{ query: string }>({
					name: "web_search",
					description: "Search",
					parameters: { type: "object", properties: { query: { type: "string" } } },
					execute: async (input) => ({ content: `results for ${input.query}`, isError: false }),
				}),
			],
			adapter: createFauxProvider([...SEARCH_SCRIPT, ...SEARCH_SCRIPT]),
			permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
		});
		const session = await agent.session({ id: "s" });
		// The human closes the interrupted execution, and the OPEN run reaches
		// its terminal first (四: a new run is refused while an open run
		// lingers — resume is the only way past it).
		session.resolveUncertain("ex-2", "abandoned");
		for await (const ev of session.resume()) {
			if (ev.type === "permission_requested") session.approve(ev.decisionId, true);
		}
		expect(session.uncertainExecutions()).toEqual([]);
		// The model re-issues the call (new logical call): it executes —
		// exactly-once comes from human decisions on the UNCERTAIN one, not
		// from swallowing repeats.
		const events: Event[] = [];
		for await (const ev of session.run("again")) {
			events.push(ev);
			if (ev.type === "permission_requested") session.approve(ev.decisionId, true);
		}
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
	});

	it("both rerun and abandoned fill a model-facing result — never a dangling tool_use", async () => {
		// ── abandoned: the human says the attempt did not apply ──
		const { store: store1 } = crashedStore();
		const session1 = await searchAgent(store1).session({ id: "s" });
		session1.resolveUncertain("ex-2", "abandoned");
		const rec1 = store1.load("s");
		expect(rec1.some((r) => r.event.type === "tool_execution_resolved" && r.event.resolution === "abandoned")).toBe(true);
		expect(rec1.some((r) => r.event.type === "tool_result" && r.event.isError && r.event.errorKind === "precondition")).toBe(true);
		expect(session1.uncertainExecutions()).toEqual([]);

		// ── rerun: the human says the side effect did NOT happen; the model
		//    must be able to retry — which real providers REQUIRE (a dangling
		//    tool_use is rejected by the Anthropic API). A result is filled
		//    with the rerun verdict (review finding 1).
		const { store: store2 } = crashedStore();
		const session2 = await searchAgent(store2).session({ id: "s" });
		session2.resolveUncertain("ex-2", "rerun");
		const rec2 = store2.load("s");
		expect(rec2.some((r) => r.event.type === "tool_execution_resolved" && r.event.resolution === "rerun")).toBe(true);
		const filled = rec2.find((r) => r.event.type === "tool_result");
		expect(filled).toBeDefined();
		expect((filled?.event as { content: string }).content).toMatch(/rerun|NOT applied/i);
		expect(session2.uncertainExecutions()).toEqual([]);
	});
});
