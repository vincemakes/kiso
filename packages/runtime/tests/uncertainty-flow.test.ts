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

describe("uncertainty flow (七) — the crash window (裁决 #12, ADR-0038)", () => {
	/** Seed a crash-window execution: started, NO receipt — the only kind
	 *  of execution that may be uncertain anymore. */
	async function seedUncertain(store: SessionStore, id: string): Promise<void> {
		await store.append(id, "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append(id, "r1", {
			seq: 1,
			type: "tool_execution_started",
			executionId: "ex-1",
			callId: "c1",
			name: "web_search",
			input: {},
		});
	}

	it("OFFLINE: without a live resolver the verdict persists directly — the fill lands too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		await seedUncertain(store, "s");
		const session = await failingAgent(store, STOP).session({ id: "s" });
		await session.resolveUncertain("ex-1", "abandoned");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.some((e) => e.type === "tool_result" && e.isError)).toBe(true); // the fill
	});

	it("the offline resolution is recorded AT MOST ONCE — a repeat verdict is a no-op", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		await seedUncertain(store, "s");
		const session = await failingAgent(store, STOP).session({ id: "s" });
		await session.resolveUncertain("ex-1", "abandoned");
		await session.resolveUncertain("ex-1", "rerun"); // a stray second verdict
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")[0]!.resolution).toBe("abandoned");
	});

	it("an unresolved crash-window execution stays uncertain — nothing fabricated, no resolution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const store = new SessionStore(dir);
		await seedUncertain(store, "s");
		const session = await failingAgent(store, STOP).session({ id: "s" });
		// Nobody decided — the ledger reports it as uncertain, no resolution exists.
		expect(session.uncertainExecutions()).toHaveLength(1);
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.some((e) => e.type === "tool_execution_resolved")).toBe(false);
		// A receipted failure is NOT uncertain — only the crash window is
		// (the C-组 failed-receipt pause was removed by 裁决 #12).
		const store2 = new SessionStore(dir);
		await store2.append("s2", "r1", { seq: 0, type: "user_input", content: "go" });
		await store2.append("s2", "r1", { seq: 1, type: "tool_execution_started", executionId: "ex-2", callId: "c1", name: "web_search", input: {} });
		await store2.append("s2", "r1", { seq: 2, type: "tool_execution_failed", executionId: "ex-2", callId: "c1", error: "boom", safeToRetry: false });
		store2.closeAll();
		const session2 = await failingAgent(new SessionStore(dir), STOP).session({ id: "s2" });
		expect(session2.uncertainExecutions()).toHaveLength(0);
	});

	it("CROSS-PROCESS: the offline resolution is durable and the trajectory stays contiguous", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-unc-"));
		const storeA = new SessionStore(dir);
		await seedUncertain(storeA, "s");
		const sessionA = await failingAgent(storeA, STOP).session({ id: "s" });
		await sessionA.resolveUncertain("ex-1", "rerun"); // process A decides offline
		storeA.closeAll(); // process A exits — the lock is released

		// Process B reloads: the resolution is on disk, the seqs are
		// contiguous 0..N — the durable trajectory has no gap.
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.map((e) => e.seq)).toEqual([...Array(durable.length).keys()]);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
	});
});
