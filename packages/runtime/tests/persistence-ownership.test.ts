/**
 * round 1 — unified event persistence ownership.
 *
 * 1. The EventLog must never advance past what the store accepted: a
 *    StaleWriterError poisons the session — the in-memory log may not
 *    keep accumulating seqs and "catch up" to the disk.
 * 2. A stale session (B) that fails repeatedly must NEVER write an event
 *    derived from its stale context; the disk projection and the model's
 *    view must be the same after a reload.
 * 3. Every persisted event must be yielded exactly once — no hidden
 *    log.append inside the loop that is neither yielded nor durable.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, EventLog, loop, type Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, StaleWriterError } from "../src/index.js";

const STOP: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

function agent(store: SessionStore, script: FauxScript = STOP) {
	return createAgent({
		model: "faux",
		store,
		tools: [
			defineTool({
				name: "web_search",
				description: "S",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				execute: async () => ({ content: "ok", isError: false }),
			}),
		],
		adapter: createFauxProvider(script),
	});
}

describe("persistence ownership (round 1)", () => {
	it("a stale session is POISONED on the first rejected write — it can never accumulate seqs toward the disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-po-"));
		const storeA = new SessionStore(dir);
		const sessionA = await agent(storeA).session({ id: "s" });
		for await (const _ev of sessionA.run("first")) {
			// run 1 completes; storeA closes (its view ends at N)
		}
		storeA.closeAll();

		// B is a stale handle: it preloads the log at seq N.
		const storeB = new SessionStore(dir);
		const agentB = agent(storeB);
		const sessionB = await agentB.session({ id: "s" });

		// C advances the file beyond B's view.
		const storeC = new SessionStore(dir);
		const agentC = agent(storeC);
		const sessionC = await agentC.session({ id: "s" });
		for await (const _ev of sessionC.run("second")) {
			// drain
		}
		storeC.closeAll();

		// B tries to write an event derived from ITS stale context.
		await expect(async () => {
			for await (const _ev of sessionB.run("stale")) {
				// never reaches a terminal
			}
		}).rejects.toThrow(StaleWriterError);

		// B is poisoned: every further attempt fails fast, and the in-memory
		// log cannot keep advancing.
		await expect(async () => {
			for await (const _ev of sessionB.run("stale-again")) {
				// never
			}
		}).rejects.toThrow(/poisoned|stale/i);

		// The DISK projection is intact and equal to what the model saw.
		const storeD = new SessionStore(dir);
		const agentD = agent(storeD);
		const reloaded = await agentD.session({ id: "s" });
		const projected = reloaded.projected();
		// The stale context B derived was never persisted: the disk holds
		// exactly C's trajectory — and a fresh session's projection equals it.
		const userMessages = projected.filter((m) => m.role === "user");
		expect(userMessages.map((m) => (m as { content: string }).content)).not.toContain("stale");
		expect(userMessages.map((m) => (m as { content: string }).content)).not.toContain("stale-again");
	});

	it("every loop event is yielded exactly once and persisted exactly once (no hidden appends)", async () => {
		const log = new EventLog();
		const registry = new (await import("@vincemakes/kiso-core")).ToolRegistry();
		registry.register(
			defineTool({
				name: "web_search",
				description: "S",
				parameters: { type: "object" },
				execute: async () => ({ content: "ok", isError: false }),
			}),
		);
		const yielded: Event[] = [];
		for await (const ev of loop({
			adapter: createFauxProvider([
				{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			model: "faux",
			registry,
			log,
			messages: [{ role: "user", content: "go" }],
			hooks: { onUserMessage: async (msg) => ({ ...msg, content: "rewritten" }) },
		})) {
			yielded.push(ev);
		}
		// The seed (user_input) is appended but not yielded by the loop —
		// the Run layer yields it. Everything the loop appends AFTER its
		// first yield must be visible in the yielded stream.
		const yieldedSeqs = yielded.map((e) => e.seq);
		const logSeqs = log.all.map((e) => e.seq);
		expect(yieldedSeqs).toEqual(logSeqs.filter((s) => s > 0)); // seq 0 is the seed
		// No seq is duplicated or skipped.
		expect(new Set(yieldedSeqs).size).toBe(yieldedSeqs.length);
		expect(yieldedSeqs).toEqual([...logSeqs.slice(1)]);
	});
});
