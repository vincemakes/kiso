/**
 * 第四轮(对抗审查) — race fixes the review found.
 *
 * 1. A verdict the human GAVE in the same instant an abort lands must be
 *    RECORDED, exactly once — never lost (approval and uncertainty).
 * 2. Concurrent appends on ONE store instance must not spurious-fail with
 *    "locked by another writer (pid = itself)" and poison the session.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { defineTool, type Event } from "@kiso/core";
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

describe("adversarial races (第四轮)", () => {
	it("an UNCERTAIN verdict given in the same instant as the abort is RECORDED, exactly once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		const session = await failingAgent(new SessionStore(dir)).session({ id: "s" });
		const ac = new AbortController();
		const run = session.run("go", { signal: ac.signal });
		const yielded: Event[] = [];
		for await (const ev of run) {
			yielded.push(ev);
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") {
				// The human answers and the abort fires in the SAME tick.
				const p = session.resolveUncertain(ev.executionId, "abandoned");
				ac.abort();
				await p;
			}
		}
		const terminal = yielded.find((e) => e.type === "terminal");
		expect(terminal?.outcome.kind).toBe("aborted");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		// The verdict was consumed — it must be durable exactly once, and the
		// session must NOT be bricked for this execution.
		expect(durable.filter((e) => e.type === "tool_execution_resolved")).toHaveLength(1);
		expect(durable.filter((e) => e.type === "tool_execution_resolved")[0]).toMatchObject({ resolution: "abandoned" });
		// A later resume does not block on it, and cannot double-record it.
		const session2 = await failingAgent(new SessionStore(dir), STOP).session({ id: "s" });
		for await (const _ev of session2.resume()) {
			// drain
		}
		expect(new SessionStore(dir).load("s").filter((r) => r.event.type === "tool_execution_resolved")).toHaveLength(1);
	});

	it("an APPROVAL given in the same instant as the abort is RECORDED, exactly once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		const session = await failingAgent(new SessionStore(dir)).session({ id: "s" });
		const ac = new AbortController();
		const run = session.run("go", { signal: ac.signal });
		const yielded: Event[] = [];
		for await (const ev of run) {
			yielded.push(ev);
			if (ev.type === "permission_requested") {
				const p = session.approve(ev.decisionId, true);
				ac.abort();
				await p;
			}
		}
		const terminal = yielded.find((e) => e.type === "terminal");
		expect(terminal?.outcome.kind).toBe("aborted");
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "permission_decided" && e.decision === "approved")).toHaveLength(1);
	});

	it("concurrent appends on ONE store instance never spurious-fail or poison", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		const store = new SessionStore(dir);
		await Promise.all([
			store.append("s", "r1", { seq: 0, type: "user_input", content: "a" }),
			store.append("s", "r1", { seq: 1, type: "user_input", content: "b" }),
		]);
		const records = store.load("s");
		expect(records.map((r) => r.event.seq)).toEqual([0, 1]);
		expect(records.map((r) => (r.event as { content?: string }).content)).toEqual(["a", "b"]);
		// The instance is still healthy — a follow-up append works.
		await store.append("s", "r1", { seq: 2, type: "user_input", content: "c" });
		expect(store.load("s")).toHaveLength(3);
	});
});

	it("P1-5: approve() resolves only AFTER the decision is durable — an immediate break cannot lose it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		const session = await failingAgent(new SessionStore(dir)).session({ id: "s" });
		const run = session.run("go");
		for await (const ev of run) {
			if (ev.type === "permission_requested") {
				await session.approve(ev.decisionId, true);
				break; // abandon the generator right after the answer
			}
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		// The verdict was durable BEFORE approve() returned — the break
		// cannot lose it, and the answered set cannot make a retry a no-op
		// on a never-recorded decision.
		expect(durable.filter((e) => e.type === "permission_decided" && e.decision === "approved")).toHaveLength(1);
	});

	it("P1-5: resolveUncertain() resolves only AFTER the verdict is durable — an immediate break cannot lose it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-race-"));
		const session = await failingAgent(new SessionStore(dir)).session({ id: "s" });
		const run = session.run("go");
		for await (const ev of run) {
			if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			if (ev.type === "uncertain_pending") {
				await session.resolveUncertain(ev.executionId, "abandoned");
				break; // abandon the generator right after the verdict
			}
		}
		const durable = new SessionStore(dir).load("s").map((r) => r.event);
		expect(durable.filter((e) => e.type === "tool_execution_resolved" && e.resolution === "abandoned")).toHaveLength(1);
	});
