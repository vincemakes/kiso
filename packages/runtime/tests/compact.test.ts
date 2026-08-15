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
import { defineTool, projectMessages, type Adapter, type Message } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type CompactInfo } from "../src/index.js";

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

/** A valid checkpoint body — the (b) validation rejects anything less, so
 *  every fixture that goes through the summary call must emit one. */
const VALID_SUMMARY = [
	"## Goal",
	"wire the flags",
	"## Constraints",
	"the fallback must not be used",
	"## User requests",
	"turn 1: make the report work",
	"## Files and changes",
	"src/cli.js: wired --count",
	"## Errors and fixes",
	"none",
	"## Current work",
	"flags wired",
	"## Next steps",
	"wire --sum",
].join("\n");

const SUMMARY_TURN: FauxScript = [
	{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
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
		expect(result!.summary).toBe(VALID_SUMMARY);
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
		expect(texts.filter((t) => t === VALID_SUMMARY)).toHaveLength(2);
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

	it("W18: the REAL slow summarize — onStart surfaces the knowable data, the call takes real seconds, and the signal cancels it mid-flight with nothing persisted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact-w18-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		// A REAL slow adapter: the same interface the providers implement,
		// with a genuine 1.1s wall-clock delay — the "large context
		// multi-second freeze" the indicator exists for.
		const slowAdapter: Adapter = {
			stream(options) {
				return {
					async *[Symbol.asyncIterator]() {
						await new Promise((resolve) => setTimeout(resolve, 1100));
						if (options.signal?.aborted) throw new Error("aborted by the signal");
						yield { type: "text_delta", text: VALID_SUMMARY, seq: 0 };
						yield { type: "stop", reason: "end_turn", seq: 1 };
					},
				};
			},
		};
		const agent = createAgent({ model: "faux", store, tools: [], adapter: slowAdapter });

		// The cancel case FIRST (its failure must leave nothing behind):
		// an abort mid-call rejects and NOTHING is persisted (ADR-0044
		// crash semantics — the session is unchanged).
		const ac = new AbortController();
		const sessionB = await agent.session({ id: "s" });
		const racing = sessionB.summarize({
			signal: ac.signal,
			onStart: () => setTimeout(() => ac.abort(), 150),
		});
		await expect(racing).rejects.toThrow("aborted by the signal");
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);

		// The real-slow case: onStart carries the knowable pre-call data
		// (4 covered rounds of the seeded 8, the token estimate), and the
		// call took REAL seconds — the whole call, not a fake.
		const sessionC = await agent.session({ id: "s" });
		let started: CompactInfo | null = null;
		const t0 = Date.now();
		const result = await sessionC.summarize({ onStart: (info) => void (started = info) });
		const elapsed = Date.now() - t0;
		expect(started).not.toBeNull();
		expect(started!.rounds).toBe(4); // 8 seeded rounds, 4 kept → 4 covered
		expect(started!.tokens).toBeGreaterThan(0);
		expect(elapsed).toBeGreaterThanOrEqual(1000); // real seconds elapsed
		expect(result!.summary).toBe(VALID_SUMMARY);
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(true);
	}, 30_000);
});

/**
 * P1 e2e (0.1.42) — the boundary straddle, reproduced WITHOUT the real
 * API. A T5-shaped session holds the hazard the pairing invariant exists
 * for: a tool call whose RESULT lands AFTER a user input arrived
 * mid-execution (the durable-log shape of "the user typed while the tool
 * ran"). The K-round boundary would cover the call and KEEP the result —
 * the projection renders an orphaned tool message and the next request
 * 400s (the pairing family, deepseek's own wording). /compact + RESUME in
 * a fresh process: the boundary must pull back before the pair's round,
 * and the next turn's request must validate.
 *
 * The mechanism finding (fresh2's actual log): the 400's physical shape
 * was the mid-turn interleaving (a result landing between the turn's
 * tool_call_ends) against the PRE-guard runtime — the current runtime
 * holds the ends (the 0.1.40 truncation guard) and drains every result
 * before the next request (the settle), so the interleaving cannot
 * happen here. The reachable-through-the-runtime split is the BOUNDARY
 * straddle — this test's subject.
 */
describe("P1 e2e — the straddled pair survives /compact (the pairing 400 family)", () => {
	/** The T5 shape WITH the straddle: four chunky rounds, the pair's
	 *  round (call + stop), THREE mid-execution inputs while the tool runs,
	 *  the call's result landing after them, three more rounds, terminaled.
	 *  The mid inputs make the late result land STRICTLY AFTER the K-round
	 *  cut: with A = K-1 = 3 inputs after the cut input, that input sits at
	 *  index m-K, the old boundary is cutInput - 1 = 16, and the result at
	 *  18 is KEPT — the exact straddle the projection orphans. */
	async function seedStraddleSession(store: SessionStore, id = "s"): Promise<void> {
		let seq = 0;
		const chunky = async (callId: string): Promise<void> => {
			await store.append(id, "r1", { seq: seq++, type: "tool_result", callId, content: "line\n".repeat(200), isError: false });
		};
		for (let i = 0; i < 4; i++) {
			await store.append(id, "r1", { seq: seq++, type: "user_input", content: `turn ${i}` });
			await store.append(id, "r1", { seq: seq++, type: "tool_call_end", callId: `c${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			await chunky(`c${i}`);
		}
		// Round 5: the pair's call — its result lands BELOW, after the
		// mid-execution inputs (the straddle).
		await store.append(id, "r1", { seq: seq++, type: "user_input", content: "turn 4" });
		await store.append(id, "r1", { seq: seq++, type: "tool_call_end", callId: "p1", name: "read_file", input: { path: "a.ts" } });
		await store.append(id, "r1", { seq: seq++, type: "stop", reason: "tool_use" });
		for (let i = 0; i < 3; i++) {
			await store.append(id, "r1", { seq: seq++, type: "user_input", content: `turn ${5 + i}` }); // mid-execution
		}
		await store.append(id, "r1", { seq: seq++, type: "tool_result", callId: "p1", content: "line\n".repeat(200), isError: false });
		for (let i = 0; i < 3; i++) {
			await store.append(id, "r1", { seq: seq++, type: "user_input", content: `turn ${8 + i}` });
			await store.append(id, "r1", { seq: seq++, type: "tool_call_end", callId: `c${4 + i}`, name: "read_file", input: { path: `f${4 + i}.ts` } });
			await chunky(`c${4 + i}`);
		}
		await store.append(id, "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
	}

	/** The pairing check real providers enforce (the 400 family): every
	 *  assistant tool_calls followed by its results, and every tool message
	 *  preceded by its assistant's call — the straddle's split produces an
	 *  ORPHANED result, the covered assistant gone. */
	function pairViolation(msgs: readonly Message[]): string | undefined {
		for (let i = 0; i < msgs.length; i++) {
			const m = msgs[i]!;
			if (m.role !== "assistant") continue;
			const calls = m.blocks.filter((b) => b.type === "tool_use");
			if (calls.length === 0) continue;
			const answered = new Set<string>();
			for (let j = i + 1; j < msgs.length; j++) {
				const n = msgs[j]!;
				if (n.role === "assistant" || n.role === "user") break;
				if (n.role === "tool") answered.add(n.callId);
			}
			for (const c of calls) {
				if (!answered.has(c.callId)) return `missing result for ${c.callId}`;
			}
		}
		for (let i = 0; i < msgs.length; i++) {
			const m = msgs[i]!;
			if (m.role !== "tool") continue;
			let found = false;
			for (let j = i - 1; j >= 0; j--) {
				const n = msgs[j]!;
				if (n.role === "user") break;
				if (n.role === "assistant" && n.blocks.some((b) => b.type === "tool_use" && b.callId === m.callId)) {
					found = true;
					break;
				}
			}
			if (!found) return `orphaned tool message ${m.callId}`;
		}
		return undefined;
	}

	it("the straddled pair survives /compact — the resumed request never orphans a result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-p1-straddle-"));
		const store = new SessionStore(dir);
		await seedStraddleSession(store);

		const tools = [
			defineTool({
				name: "read_file",
				description: "read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				execute: async () => ({ content: "file", isError: false }),
			}),
		];

		// The adapter: call 1 = the /compact summary call; call 2 = the
		// resumed run's FIRST request — the pairing validation (the 400
		// shape). Every event carries its per-call `seq` (the adapter
		// contract — the loop's trust gate rejects a seq-less event).
		let call = 0;
		const adapter: Adapter = {
			async *stream(options) {
				call += 1;
				let seq = 0;
				if (call === 1) {
					yield { type: "text_delta", text: VALID_SUMMARY, seq: seq++ };
					yield { type: "stop", reason: "end_turn", seq: seq++ };
					return;
				}
				const bad = pairViolation(options.messages);
				if (bad !== undefined) {
					throw new Error(`400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message: ${bad})`);
				}
				yield { type: "stop", reason: "end_turn", seq: seq++ };
			},
		};

		// Process A: /compact (the seeded rounds compress into one summary).
		const agentA = createAgent({ model: "faux", store, tools, adapter });
		const sessionA = await agentA.session({ id: "s" });
		const compacted = await sessionA.summarize();
		expect(compacted).not.toBeNull();

		// Process B: RESUME in a fresh process — a fresh agent + session from
		// disk — the next turn's request must project the pair WHOLE.
		const agentB = createAgent({ model: "faux", store, tools, adapter });
		const sessionB = await agentB.session({ id: "s" });
		const outcomes: string[] = [];
		for await (const ev of sessionB.run("continue the work")) {
			if (ev.type === "terminal") {
				outcomes.push(ev.outcome.kind);
				if (ev.outcome.kind === "error") outcomes.push(ev.outcome.error.message);
			}
		}
		// The run must END normally — the request's message sequence
		// validated (the pairing check never fired the 400).
		expect(outcomes).toContain("completed");
		expect(outcomes.some((o) => o.includes("must be followed by tool messages"))).toBe(false);
		// The P1 pullback: the boundary sits BEFORE the straddled pair's
		// round (the pair's opening input at 12 → 11), NOT at the K-round
		// cut (16) that would cover the call at 13 and keep the result at 18.
		expect(compacted!.coversToSeq).toBe(11);
	}, 30_000);
});
