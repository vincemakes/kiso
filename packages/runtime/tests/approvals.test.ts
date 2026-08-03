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
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
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
});

describe("uncertain executions", () => {
	function crashedStore(): { dir: string; store: SessionStore } {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		// Simulate a crash mid-execution: started is durable, no result ever
		// followed, and the run has no terminal.
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", callId: "c1", name: "web_search", input: { query: "k" } });
		return { dir, store };
	}

	it("lists interrupted executions as uncertain and blocks them in the next run", async () => {
		const { dir, store } = crashedStore();
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });
		const uncertain = session.uncertainExecutions();
		expect(uncertain).toHaveLength(1);
		expect(uncertain[0]).toMatchObject({ callId: "c1", name: "web_search", status: "uncertain" });

		// The next run's model re-issues the same call: it must be blocked,
		// not executed.
		const events: Event[] = [];
		for await (const ev of session.run("again")) {
			events.push(ev);
			if (ev.type === "permission_requested") session.approve(ev.decisionId, true);
		}
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		expect((result as { content: string }).content).toMatch(/uncertain|interrupted|human/i);
	});

	it("resolving as abandoned keeps it blocked; resolving as rerun allows execution", async () => {
		const { dir, store } = crashedStore();
		const agent = searchAgent(store);
		const session = await agent.session({ id: "s" });

		// Human decision: abandon the interrupted attempt.
		session.resolveUncertain("c1", "abandoned");
		const reloaded = await agent.session({ id: "s" });
		expect(reloaded.uncertainExecutions()).toEqual([]);

		// abandoned: still blocked.
		const blocked: Event[] = [];
		for await (const ev of reloaded.run("again")) {
			blocked.push(ev);
			if (ev.type === "permission_requested") reloaded.approve(ev.decisionId, true);
		}
		expect(blocked.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, errorKind: "precondition" });

		// rerun: the human takes responsibility — the side effect may run.
		const dir2 = crashedStore().dir;
		const store2 = new SessionStore(dir2);
		const agent2 = searchAgent(store2);
		const session2 = await agent2.session({ id: "s" });
		session2.resolveUncertain("c1", "rerun");
		const rerun: Event[] = [];
		for await (const ev of session2.run("again")) {
			rerun.push(ev);
			if (ev.type === "permission_requested") session2.approve(ev.decisionId, true);
		}
		expect(rerun.some((e) => e.type === "tool_execution_succeeded")).toBe(true);
	});
});
