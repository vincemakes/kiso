/**
 * Area 2 — REAL cross-process continuation.
 *
 * A pause is a durable state machine, not a denial: process A pauses on a
 * deferred tool and exits; process B loads the session, resumes, approves,
 * and the ORIGINAL tool call runs exactly once — no new user_input, no
 * second model prompt, no second approval — and the original run completes.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { defineTool, type Event, type Tool } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

/** A tool whose side effect is a marker FILE — observable across processes. */
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

const STOP_SCRIPT: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

const SCRIPT: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function pausedAgent(store: SessionStore, markerPath: string, script: FauxScript = SCRIPT) {
	return createAgent({
		model: "faux",
		store,
		tools: [markerTool(markerPath)],
		adapter: createFauxProvider(script),
		permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
	});
}

const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal");

describe("resume: process A paused and exited, process B decides", () => {
	it("approve in process B runs the ORIGINAL call once and completes the original run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const marker = join(dir, "side-effect.txt");
		const storeA = new SessionStore(dir);
		const agentA = pausedAgent(storeA, marker);
		const sessionA = await agentA.session({ id: "s" });

		// Process A: pause on the deferred tool, then exit (abandon the run).
		const inA: Event[] = [];
		for await (const ev of sessionA.run("search")) {
			inA.push(ev);
			if (ev.type === "permission_requested") break;
		}
		expect(inA.some((e) => e.type === "permission_requested")).toBe(true);
		expect(existsSync(marker)).toBe(false); // nothing ran yet
		storeA.closeAll();

		// Process B: reload, resume, approve.
		const storeB = new SessionStore(dir);
		const agentB = pausedAgent(storeB, marker, STOP_SCRIPT);
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) {
			events.push(ev);
			if (ev.type === "permission_requested") sessionB.approve(ev.decisionId, true);
		}

		// The original call ran exactly once, in process B, with the ORIGINAL input.
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8")).toBe("k");

		// The original run completed.
		expect(terminalOf(events)?.outcome.kind).toBe("completed");

		// No new user_input, no second approval, no re-prompt of the model
		// before the persisted call executed.
		const records = storeB.load("s");
		expect(records.filter((r) => r.event.type === "user_input")).toHaveLength(1);
		expect(records.filter((r) => r.event.type === "permission_requested")).toHaveLength(1);
		// The whole trajectory is one run.
		expect(new Set(records.map((r) => r.runId)).size).toBe(1);
		// Execution events and the tool result are durable.
		expect(records.some((r) => r.event.type === "tool_execution_started")).toBe(true);
		expect(records.some((r) => r.event.type === "tool_result")).toBe(true);
	});

	it("deny in process B writes an honest tool result and completes the run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const marker = join(dir, "side-effect.txt");
		const storeA = new SessionStore(dir);
		const agentA = pausedAgent(storeA, marker);
		const sessionA = await agentA.session({ id: "s" });
		for await (const ev of sessionA.run("search")) {
			if (ev.type === "permission_requested") break;
		}
		storeA.closeAll();

		const storeB = new SessionStore(dir);
		const agentB = pausedAgent(storeB, marker, STOP_SCRIPT);
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) {
			events.push(ev);
			if (ev.type === "permission_requested") sessionB.approve(ev.decisionId, false);
		}

		expect(existsSync(marker)).toBe(false);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ isError: true, errorKind: "precondition" });
		const records = storeB.load("s");
		expect(records.some((r) => r.event.type === "permission_decided" && r.event.decision === "denied")).toBe(true);
		expect(records.filter((r) => r.event.type === "user_input")).toHaveLength(1);
	});

	it("an approval decided while no process was running is applied on resume, not re-asked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const marker = join(dir, "side-effect.txt");
		const storeA = new SessionStore(dir);
		const agentA = pausedAgent(storeA, marker);
		const sessionA = await agentA.session({ id: "s" });
		for await (const ev of sessionA.run("search")) {
			if (ev.type === "permission_requested") break;
		}
		storeA.closeAll();

		// A helper process approved the request directly (durable decision).
		const storeMid = new SessionStore(dir);
		const agentMid = pausedAgent(storeMid, marker);
		const sessionMid = await agentMid.session({ id: "s" });
		const pending = sessionMid.pendingApprovals();
		expect(pending).toHaveLength(1);
		sessionMid.approve(pending[0]!.decisionId, true);
		storeMid.closeAll();

		// The real resume applies the decision WITHOUT pausing again.
		const storeB = new SessionStore(dir);
		const agentB = pausedAgent(storeB, marker, STOP_SCRIPT);
		const sessionB = await agentB.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of sessionB.resume()) events.push(ev);

		expect(events.some((e) => e.type === "permission_requested")).toBe(false);
		expect(existsSync(marker)).toBe(true);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});
});

describe("receipt repair", () => {
	it("a succeeded execution whose tool_result never landed is completed from the receipt — never re-executed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const marker = join(dir, "side-effect.txt");
		writeFileSync(marker, "already-ran", "utf8");
		// The crashed trajectory: execution succeeded, but the tool_result
		// write never made it before the process died.
		const store = new SessionStore(dir);
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 3, type: "tool_execution_succeeded", executionId: "ex-2", callId: "c1", result: { content: "results for k", isError: false } });
		store.closeAll();

		const agent = pausedAgent(new SessionStore(dir), marker, STOP_SCRIPT);
		const session = await agent.session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		// The tool did NOT run again — the marker still holds the old value.
		expect(readFileSync(marker, "utf8")).toBe("already-ran");
		// The model-facing result was rebuilt from the receipt.
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ callId: "c1", content: "results for k", isError: false });
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
	});
});

describe("resume boundaries", () => {
	it("resume() on a completed session yields nothing — it never fabricates a turn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const store = new SessionStore(dir);
		const agent = pausedAgent(store, join(dir, "m.txt"));
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("search")) {
			if (_ev.type === "permission_requested") session.approve((_ev as { decisionId: string }).decisionId, true);
		}
		store.closeAll();

		const session2 = await agent.session({ id: "s" });
		const resumed: Event[] = [];
		for await (const ev of session2.resume()) resumed.push(ev);
		expect(resumed).toEqual([]);
	});

	it("resume() refuses while uncertain executions await a human decision", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-res-"));
		const store = new SessionStore(dir);
		store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		store.append("s", "r1", { seq: 2, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: { query: "k" } });
		store.closeAll();

		const agent = pausedAgent(new SessionStore(dir), join(dir, "m.txt"));
		const session = await agent.session({ id: "s" });
		await expect(async () => {
			for await (const _ev of session.resume()) {
				// never reached
			}
		}).rejects.toThrow(/uncertain|resolve/i);
	});
});
