/**
 * 七 — the uncertainty resolution is part of the event stream, exactly once.
 *
 * - with a LIVE resolver, resolveUncertain() only passes the verdict; the
 *   active loop / recovery generator appends and yields
 *   tool_execution_resolved, and the Run persists it — the yielded stream
 *   and the durable seqs must be IDENTICAL (no hidden 6 → 8 gaps);
 * - without a live resolver, an OFFLINE verdict persists directly;
 * - live, cross-process, and abort paths each record the resolution at
 *   most once; an abort leaves the execution uncertain (no resolution at
 *   all), and the next resume blocks on it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
const CALL: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function failingAgent(store: SessionStore, script: FauxScript = CALL) {
	return createAgent({
		model: "faux",
		store,
		tools: [
			defineTool<{ query: string }>({
				name: "web_search",
				description: "S",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				execute: async () => ({ content: "failed after side effect", isError: true, errorKind: "fatal" as const }),
			}),
		],
		adapter: createFauxProvider(script),
		permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
	});
}

describe("uncertainty flow (七)", () => {
	it("LIVE: the yielded stream and the durable seqs are IDENTICAL — no hidden resolution gap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const agent = failingAgent(new SessionStore(dir));
		const session = await agent.session({ id: "s" });
		const yielded: Event[] = [];
		for await (const ev of session.run("go")) {
			yielded.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") {
				await session.resolveUncertain(ev.executionId, "abandoned");
			}
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		// The consumer's stream and the disk replay are THE SAME trajectory:
		// every yielded seq exists on disk, in order, with no gap and no
		// extra hidden event.
		expect(yielded.map((e) => e.seq)).toEqual(durable.map((e) => e.seq));
		expect(yielded.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
	});

	it("LIVE: the resolution is recorded AT MOST ONCE even when resolveUncertain is answered repeatedly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const agent = failingAgent(new SessionStore(dir));
		const session = await agent.session({ id: "s" });
		const yielded: Event[] = [];
		for await (const ev of session.run("go")) {
			yielded.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") {
				await session.resolveUncertain(ev.executionId, "abandoned");
				await session.resolveUncertain(ev.executionId, "rerun"); // a stray second verdict
			}
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(yielded.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
	});

	it("ABORT during the live wait: NO resolution is recorded — the execution stays uncertain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const agent = failingAgent(new SessionStore(dir));
		const session = await agent.session({ id: "s" });
		const ac = new AbortController();
		const run = session.run("go", { signal: ac.signal });
		const yielded: Event[] = [];
		for await (const ev of run) {
			yielded.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") ac.abort(); // the human never answers
		}
		const terminal = yielded.find((e) => e.type === "terminal");
		expect(terminal?.outcome.kind).toBe("aborted");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		// No resolution was fabricated, the execution is still uncertain.
		expect(durable.some((e) => e.type === "tool_execution_resolved")).toBe(false);
		expect(session.uncertainExecutions()).toHaveLength(1);
		// The run terminated with its honest aborted terminal; a resume of
		// the terminated run yields nothing and fabricates nothing.
		const resumed: Event[] = [];
		for await (const _ev of session.resume()) resumed.push(_ev);
		expect(resumed).toHaveLength(0);
		expect(new SessionStore(dir).load("s").some((r) => r.event.type === "tool_execution_resolved")).toBe(false);
	});

	it("CROSS-PROCESS (recovery): the resumed resolution is yielded AND durable, exactly once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const storeA = new SessionStore(dir);
		const agentA = failingAgent(storeA, CALL);
		const sessionA = await agentA.session({ id: "s" });
		for await (const ev of sessionA.run("first")) {
			if (ev.type === "permission_requested") break; // pause, exit
		}
		storeA.closeAll();

		// Process B resumes; the resumed execution fails non-idempotently.
		const storeB = new SessionStore(dir);
		const agentB = failingAgent(storeB, STOP);
		const sessionB = await agentB.session({ id: "s" });
		const yielded: Event[] = [];
		for await (const ev of sessionB.resume()) {
			yielded.push(ev);
			if (ev.type === "permission_requested") await sessionB.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") await sessionB.resolveUncertain(ev.executionId, "abandoned");
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		// The durable trajectory is contiguous 0..N, and the resume stream is
		// its GApLESS suffix from the replay point — every event the consumer
		// saw exists on disk, in order, with no hidden resolution gap.
		const durableSeqs = durable.map((e) => e.seq);
		expect(durableSeqs).toEqual([...Array(durableSeqs.length).keys()]);
		const from = durableSeqs.indexOf(yielded[0]!.seq);
		expect(yielded.map((e) => e.seq)).toEqual(durableSeqs.slice(from));
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.some((e) => e.type === "terminal" && e.outcome.kind === "completed")).toBe(true);
	});

	it("OFFLINE: without a live resolver the verdict persists directly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: {} });
		const session = await failingAgent(store, STOP).session({ id: "s" });
		await session.resolveUncertain("ex-1", "abandoned");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.some((e) => e.type === "tool_result" && e.isError)).toBe(true); // the fill
	});
});
