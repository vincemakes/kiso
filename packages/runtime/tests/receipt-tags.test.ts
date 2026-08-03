/**
 * 八 — the durable execution RECEIPT carries everything the repair needs,
 * including tags. When tool_execution_succeeded / tool_execution_failed is
 * persisted but the model-facing tool_result never landed (a crash in the
 * window between them), resume() repairs the result FROM THE RECEIPT — and
 * that repaired result must be identical to the normal path, tags included.
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

function agent(store: SessionStore, tags: readonly string[]) {
	return createAgent({
		model: "faux",
		store,
		tools: [
			defineTool<{ query: string }>({
				name: "web_search",
				description: "S",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				execute: async () => ({
					content: "results for k",
					isError: false,
					tags,
				}),
			}),
		],
		adapter: createFauxProvider(STOP),
	});
}

const TAGS = ["do-not-compact", "billing"] as const;

describe("receipt crash window tags (八)", () => {
	it("a SUCCESSFUL receipt with tags repairs a tool_result with the SAME tags", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rt-"));
		const store = new SessionStore(dir);
		// The live path wrote the receipt with tags, then crashed before the
		// tool_result landed.
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "r1", {
			seq: 2,
			type: "tool_execution_succeeded",
			executionId: "ex-1",
			callId: "c1",
			result: { content: "results for k", isError: false },
			tags: [...TAGS],
		});
		store.closeAll();

		const session = await agent(new SessionStore(dir), [...TAGS]).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		const repaired = events.find(
			(e): e is Event & { type: "tool_result"; tags?: readonly string[] } => e.type === "tool_result",
		);
		expect(repaired).toBeDefined();
		expect(repaired!.content).toBe("results for k");
		expect(repaired!.isError).toBe(false);
		expect(repaired!.tags).toEqual([...TAGS]); // the repair kept the tags
	});

	it("a FAILED receipt with tags repairs a tool_result with the SAME tags", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rt-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("s", "r1", { seq: 1, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } });
		await store.append("s", "r1", {
			seq: 2,
			type: "tool_execution_failed",
			executionId: "ex-1",
			callId: "c1",
			error: "boom",
			errorKind: "fatal",
			safeToRetry: true, // an idempotent failure is a clean, repairable failure
			tags: [...TAGS],
		});
		store.closeAll();

		const session = await agent(new SessionStore(dir), [...TAGS]).session({ id: "s" });
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);

		const repaired = events.find(
			(e): e is Event & { type: "tool_result"; tags?: readonly string[] } => e.type === "tool_result",
		);
		expect(repaired).toBeDefined();
		expect(repaired!.isError).toBe(true);
		expect(repaired!.content).toBe("boom");
		expect(repaired!.tags).toEqual([...TAGS]);
	});

	it("the LIVE path writes the tags onto the receipt in the first place", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rt-"));
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [
				defineTool<{ query: string }>({
					name: "web_search",
					description: "S",
					parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
					execute: async () => ({ content: "results for k", isError: false, tags: [...TAGS] }),
				}),
			],
			adapter: createFauxProvider(CALL),
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		const records = new SessionStore(dir).load("s");
		const receipt = records.find((r) => r.event.type === "tool_execution_succeeded");
		expect((receipt!.event as Event & { tags?: readonly string[] }).tags).toEqual([...TAGS]);
	});
});
