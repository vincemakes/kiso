/**
 * ADR-0055 Amendment 2 — THE ROUND'S BLOCKER: the deterministic long-session
 * gate. The paired bench never crosses a compaction tier (the CTX-1
 * finding), so it cannot see the 0.40.1 stacking or its cure. This can.
 *
 * One run, a faux provider, a 200K window (the op fallback — the fastest
 * wall), 32 settled rounds each billed past hard, so every round fires.
 * Every checkpoint RESTATES the previous one — the in-band behaviour that
 * stacked: a faux checkpoint that did not restate would never reproduce it.
 * At EVERY model request after the first fire:
 *   - exactly one summary message is projected;
 *   - the projected estimate is bounded by (summary budget + tail + fixed);
 *   - it never grows from one fire to the next.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, SUMMARY_FRAMING, type Adapter, type Message, type StreamOptions } from "@vincemakes/kiso-core";
import { estimateTokens } from "../src/estimate-tokens.js";
import { createAgent, SessionStore } from "../src/index.js";
import { MANUAL_SUMMARY_BUDGET, SUMMARY_IN_BAND } from "../src/summarize.js";
import { tiersFor } from "../src/compaction-policy.js";

const FIRES = 32;
const WINDOW = 200_000;
const BIG = "line of source text\n".repeat(2_000); // 40k chars, ~10k tokens a round

const readFile = defineTool({
	name: "read_file",
	description: "read",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute: async () => ({ content: BIG, isError: false }),
});

/** A complete checkpoint of constant size (~2k tokens) that restates the task
 *  so far: the in-band shape, where every checkpoint is a full restatement. */
function checkpoint(n: number): string {
	const body = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
	return `${body}\nrestated through checkpoint ${String(n).padStart(3, "0")}: ${"the whole task, again ".repeat(360)}`;
}

/** Three settled read rounds from an earlier, completed run: the history a
 *  long session has before its first fire (the tail keeps 20k, so a fire
 *  needs more than that behind it to cover anything). */
async function seed(store: SessionStore): Promise<void> {
	let seq = 0;
	await store.append("s", "r0", { seq: seq++, type: "user_input", content: "read the repo" });
	for (let i = 0; i < 3; i++) {
		await store.append("s", "r0", { seq: seq++, type: "tool_call_end", callId: `s${i}`, name: "read_file", input: { path: `s${i}.ts` } });
		await store.append("s", "r0", { seq: seq++, type: "stop", reason: "tool_use" });
		await store.append("s", "r0", { seq: seq++, type: "tool_result", callId: `s${i}`, content: BIG, isError: false });
	}
	await store.append("s", "r0", { seq: seq++, type: "text_delta", text: "read" });
	await store.append("s", "r0", { seq: seq++, type: "stop", reason: "end_turn" });
	await store.append("s", "r0", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
}

const id = (i: number): string => `c${String(i).padStart(3, "0")}`;
const round = (i: number, billed: number) => ({
	events: [
		{ type: "tool_call_end" as const, callId: id(i), name: "read_file", input: { path: `${id(i)}.ts` } },
		{ type: "usage" as const, inputTokens: billed, outputTokens: 200, cacheRead: billed - 100, cacheWrite: null, known: true },
		{ type: "stop" as const, reason: "tool_use" as const },
	],
});
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

const isSummaryCall = (r: StreamOptions): boolean => {
	const last = r.messages.at(-1) as Message | undefined;
	return last?.role === "user" && last.content === SUMMARY_IN_BAND;
};
const summaryMessages = (r: StreamOptions): number =>
	r.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_FRAMING)).length;

describe("A2 — the long-session gate: thirty-two fires in one run, the context stays bounded", () => {
	it("every request after the first fire carries ONE summary and a bounded, non-growing context", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-a2-long-"));
		const store = new SessionStore(dir);
		await seed(store);
		// every round billed past hard (160k on a 200k window): every settled round fires
		const turns: FauxScript[number][] = [];
		for (let i = 0; i < FIRES; i++) turns.push(round(i, 170_000), say(checkpoint(i)));
		turns.push(say("done"));
		const script: FauxScript = turns;
		const faux = createFauxProvider(script);
		const requests: StreamOptions[] = [];
		const adapter = { stream: (opts: StreamOptions) => (requests.push(opts), faux.stream(opts)) } as Adapter;
		const agent = createAgent({ model: "faux", store, tools: [readFile], adapter, systemPrompt: "you are a test agent", contextPolicy: { tiers: { windowTokens: WINDOW } } });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("work through the repo")) {
			// the run lands in the log and the store
		}

		const events = store.load("s").map((r) => r.event);
		expect(events.filter((e) => e.type === "summarized")).toHaveLength(FIRES);
		expect(requests.filter(isSummaryCall)).toHaveLength(FIRES);
		expect(events.some((e) => e.type === "terminal" && (e.outcome as { kind: string }).kind === "completed")).toBe(true);

		// The model requests that follow a fire: every one after the first.
		const model = requests.filter((r) => !isSummaryCall(r));
		const afterFires = model.slice(1);
		expect(afterFires.length).toBeGreaterThanOrEqual(FIRES - 1);
		const tail = tiersFor(WINDOW, MANUAL_SUMMARY_BUDGET).tail;
		const fixed = 2_000; // the system prompt, the tool table's share, the user's line
		const bound = MANUAL_SUMMARY_BUDGET + tail + fixed;
		const sizes = afterFires.map((r) => estimateTokens(r.messages));
		for (const [k, r] of afterFires.entries()) {
			expect(summaryMessages(r), `request ${k} after the first fire`).toBe(1);
			expect(sizes[k]!, `request ${k} after the first fire`).toBeLessThanOrEqual(bound);
			if (k > 0) expect(sizes[k]!, `request ${k} grew past the one before it`).toBeLessThanOrEqual(sizes[k - 1]!);
		}
	}, 60_000); // 32 fires in one run: ~2s alone, past vitest's 5s default under the full suite's load
});
