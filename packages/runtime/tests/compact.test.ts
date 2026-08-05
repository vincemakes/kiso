/**
 * ADR-0044 — /compact is wired through the runtime: AgentSession.summarize
 * compresses the older conversation into ONE durable `summarized` event.
 * The wiring the spec demands: the summary call goes OFF-LOOP through the
 * session's OWN adapter (the same instance the loop uses), generation
 * succeeds BEFORE anything lands on disk, a failure leaves the session
 * byte-identical, and a reloaded session projects the compressed view.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { projectMessages } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

/** 7 chunky rounds, the shape of a long session (user + read + result),
 *  COMPLETED with a terminal so later runs() pass the open-run gate. */
async function seedLongSession(store: SessionStore, id = "s"): Promise<void> {
	let seq = 0;
	for (let i = 0; i < 7; i++) {
		await store.append(id, "r1", { seq: seq++, type: "user_input", content: `turn ${i}` });
		await store.append(id, "r1", { seq: seq++, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		await store.append(id, "r1", { seq: seq++, type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
	}
	await store.append(id, "r1", { seq: seq++, type: "user_input", content: "final" });
	await store.append(id, "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
}

const SUMMARY_TURN: FauxScript = [
	{ events: [{ type: "text_delta", text: "The user explored seven files." }, { type: "stop", reason: "end_turn" }] },
];

describe("AgentSession.summarize (ADR-0044)", () => {
	it("persists ONE summarized event, keyed to the covered boundary, and the projection compresses", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(SUMMARY_TURN) });
		const session = await agent.session({ id: "s" });

		const result = await session.summarize();
		expect(result).not.toBeNull();
		// K=4 kept → 8 rounds total (7 seed + final) → 4 covered rounds.
		expect(result!.summary).toBe("The user explored seven files.");
		expect(result!.savedTokens).toBeGreaterThan(0);

		const durable = store.load("s");
		const summaries = durable.filter((r) => r.event.type === "summarized");
		expect(summaries).toHaveLength(1);
		const covers = (summaries[0]!.event as { coversToSeq: number }).coversToSeq;
		// The covered range ends before the 5th-most-recent round's input —
		// the final user_input is round 8; round 5's input is at seq 12.
		expect(covers).toBe(11);

		// A FRESH session from disk projects the compressed view: exactly
		// one assistant summary message, the covered text absent.
		const reloaded = await agent.session({ id: "s" });
		const msgs = reloaded.projected();
		expect(msgs.filter((m) => m.role === "assistant" && m.blocks.some((b) => b.type === "text"))).toHaveLength(1);
		expect(msgs.some((m) => m.role === "user" && m.content === "turn 0")).toBe(false);
	});

	it("a second summarize covers the rounds since the first summary point only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(SUMMARY_TURN) });
		const session = await agent.session({ id: "s" });

		await session.summarize(); // covers rounds 1-4
		// Three more rounds (5-7 were kept; add 8-10 to cross K again).
		// Round 5's input is seq 12 — append rounds via fresh runs.
		const script: FauxScript = [
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const agent2 = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(script) });
		for (const prompt of ["more1", "more2", "more3"]) {
			const session2 = await agent2.session({ id: "s" });
			for await (const _ev of session2.run(prompt)) {
				// drain — the turn lands in the log + store
			}
		}

		// A FRESH adapter serves the second summary call (the first agent's
		// summary script turn was consumed by the first summarize).
		const agent3 = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(SUMMARY_TURN) });
		const session3 = await agent3.session({ id: "s" });
		const result2 = await session3.summarize();
		expect(result2).not.toBeNull();
		// The second summary covers (firstCovers, newBoundary] — it never
		// re-covers the first range, and the projection shows TWO summaries.
		const durable = store.load("s");
		const summaries = durable.filter((r) => r.event.type === "summarized");
		expect(summaries).toHaveLength(2);
		const [s1, s2] = summaries.map((r) => r.event as { coversToSeq: number });
		expect(s2!.coversToSeq).toBeGreaterThan(s1!.coversToSeq);
		const texts = projectMessages(durable.map((r) => r.event))
			.filter((m) => m.role === "assistant")
			.map((m) => m.blocks.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join(""));
		expect(texts.filter((t) => t === "The user explored seven files.")).toHaveLength(2);
	});

	it("a failed summary leaves the session byte-identical (nothing happened)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact3-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		// An empty script turn: the summary call produces no text → throws.
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]) });
		const session = await agent.session({ id: "s" });
		const before = store.load("s");

		await expect(session.summarize()).rejects.toThrow("produced no text");
		expect(session.log.all.some((e) => e.type === "summarized")).toBe(false);
		expect(store.load("s")).toEqual(before); // disk unchanged, byte for byte
		// The session stays healthy: a subsequent run works.
		const script: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];
		const agent2 = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(script) });
		const s2 = await agent2.session({ id: "s" });
		for await (const _ev of s2.run("still alive")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "terminal")).toBe(true);
	});

	it("returns null when fewer than K+1 rounds exist (nothing to cover)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact4-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "hi" });
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(SUMMARY_TURN) });
		const session = await agent.session({ id: "s" });
		expect(await session.summarize()).toBeNull();
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
	});
});
