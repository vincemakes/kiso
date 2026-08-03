/**
 * Phase C — durable multi-turn sessions.
 *
 * The store is an append-only JSONL; events are written and fsynced BEFORE
 * they reach the consumer (write-ahead); a session rebuilt from disk
 * continues exactly where the last run ended; a crashed consumer leaves
 * only what was durably written; a partial tail line (crash mid-write)
 * is skipped, not fatal.
 */

import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { defineTool, type Event, type Message } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

function tempStore(): SessionStore {
	return new SessionStore(mkdtempSync(join(tmpdir(), "kiso-sess-")));
}

describe("SessionStore", () => {
	it("appends durably and replays in order", async () => {
		const store = tempStore();
		await store.append("s1", "r1", { seq: 0, type: "user_input", content: "hi" });
		await store.append("s1", "r1", { seq: 1, type: "stop", reason: "end_turn" });
		const records = store.load("s1");
		expect(records.map((r) => r.event.type)).toEqual(["user_input", "stop"]);
		expect(records[0]?.runId).toBe("r1");
	});

	it("skips a partial tail line (crash mid-write) without losing the prefix", async () => {
		const store = tempStore();
		await store.append("s1", "r1", { seq: 0, type: "user_input", content: "hi" });
		appendFileSync(join(store.root, "s1.jsonl"), '{"runId":"r1","event":');
		const records = store.load("s1");
		expect(records).toHaveLength(1);
		expect(records[0]?.event.type).toBe("user_input");
	});

	it("rejects session ids that would escape the store directory", async () => {
		const store = tempStore();
		await expect(store.append("../evil", "r1", { seq: 0, type: "user_input", content: "x" })).rejects.toThrow();
	});

	it("lists session metadata with titles from the first prompt", async () => {
		const store = tempStore();
		await store.append("demo", "r1", { seq: 0, type: "user_input", content: "Inspect this repository" });
		await store.append("other", "r1", { seq: 0, type: "user_input", content: "hi" });
		const metas = store.list();
		expect(metas.map((m) => m.id).sort()).toEqual(["demo", "other"]);
		expect(metas.find((m) => m.id === "demo")?.title).toBe("Inspect this repository");
	});
});

describe("AgentSession durability", () => {
	it("a second run sees the first run's history (same store, fresh instances = process restart)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-sess-"));
		const script: FauxScript = [
			{
				events: [
					{ type: "text_delta", text: "looking" },
					{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } },

				{ type: "stop", reason: "tool_use" }],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];

		// ── process A ──
		const seenByRun2: Message[][] = [];
		const wrappingAdapter = () => {
			const base = createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]);
			return {
				stream: (opts: Parameters<typeof base.stream>[0]) => {
					seenByRun2.push([...opts.messages]);
					return base.stream(opts);
				},
			};
		};

		const storeA = new SessionStore(dir);
		const agentA = createAgent({
			model: "faux",
			store: storeA,
			tools: [defineTool({ name: "add", description: "Add", parameters: { type: "object" }, execute: async () => ({ content: "5", isError: false }) })],
			adapter: createFauxProvider(script),
		});
		const sessionA = await agentA.session({ id: "demo" });
		const first: Event[] = [];
		for await (const ev of sessionA.run("What is 2+3?")) first.push(ev);
		expect(first.some((e) => e.type === "tool_result" && e.content === "5")).toBe(true);

		// ── process B: fresh store handle, fresh agent, SAME directory ──
		storeA.closeAll(); // the old process released its writer lock
		const storeB = new SessionStore(dir);
		const agentB = createAgent({
			model: "faux",
			store: storeB,
			tools: [defineTool({ name: "add", description: "Add", parameters: { type: "object" }, execute: async () => ({ content: "5", isError: false }) })],
			adapter: wrappingAdapter(),
		});
		const sessionB = await agentB.session({ id: "demo" });
		for await (const _ev of sessionB.run("again")) {
			// drain
		}

		// The second run's model call carried the full first run: the user
		// prompt, the tool_use, and the tool result — rebuilt from disk.
		const lastSeen = seenByRun2.at(-1)!;
		expect(lastSeen.some((m) => m.role === "user" && typeof m.content === "string" && m.content === "What is 2+3?")).toBe(true);
		expect(lastSeen.some((m) => m.role === "tool" && m.content === "5")).toBe(true);
	});

	it("write-ahead: events are on disk before the consumer sees them", async () => {
		const store = tempStore();
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "text_delta", text: "one" }, { type: "text_delta", text: "two" }, { type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		let seen = 0;
		await expect(async () => {
			for await (const _ev of session.run("go")) {
				seen += 1;
				if (seen === 2) throw new Error("consumer crashed");
			}
		}).rejects.toThrow("consumer crashed");

		// Exactly the events the consumer received are durable; the terminal
		// never made it (the consumer died before the loop reached it).
		const records = store.load("s");
		expect(records).toHaveLength(2);
		expect(records[0]?.event.type).toBe("user_input");
		expect(records.at(-1)?.event.type).toBe("text_delta");
	});

	it("seq continues across runs and restarts — no re-issue, no collision", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-sess-"));
		const store = new SessionStore(dir);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("q1")) {
			// drain
		}
		const last1 = store.load("s").at(-1)?.event.seq ?? -1;

		// fresh instances = restart
		store.closeAll(); // old process released its writer lock
		const store2 = new SessionStore(dir);
		const agent2 = createAgent({
			model: "faux",
			store: store2,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session2 = await agent2.session({ id: "s" });
		for await (const _ev of session2.run("q2")) {
			// drain
		}
		const seqs = store2.load("s").map((r) => r.event.seq);
		expect(seqs).toEqual([...seqs.keys()]); // 0..N contiguous
		expect(seqs[0]).toBe(0);
		expect(seqs.at(-1)).toBe(last1 + 3); // q2: user_input + stop + terminal
	});

	it("run ids are unique per run and recorded on every record", async () => {
		const store = tempStore();
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "stop", reason: "end_turn" }] }]),
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("a")) {
			// drain
		}
		for await (const _ev of session.run("b")) {
			// drain
		}
		const records = store.load("s");
		expect(new Set(records.map((r) => r.runId)).size).toBe(2);
	});
});
