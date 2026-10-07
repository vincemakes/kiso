/**
 * The compaction round (owner, 2026-10-06) — an in-run summary told to the
 * host as `/compact` tells its caller one: `contextPolicy.tiers.onSummary`
 * hears `start` (the tier, the covered rounds and their estimate), the
 * summary's `progress` against its budget, and `end` — `kept`, `discarded`
 * or `failed`, with the context's estimate before and after.
 *
 * It is display only: the requests are byte-identical with and without it,
 * and a callback that throws changes nothing.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
const BLOATED = `${VALID_SUMMARY}\n${"restated detail ".repeat(15_000)}`;
const BIG = "line of source text\n".repeat(2_000);

const readFile = defineTool({
	name: "read_file",
	description: "read",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute: async () => ({ content: BIG, isError: false }),
});

async function seed(store: SessionStore): Promise<void> {
	let seq = 0;
	await store.append("s", "r1", { seq: seq++, type: "user_input", content: "work through the repo" });
	for (let i = 0; i < 5; i++) {
		await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: `s${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		await store.append("s", "r1", { seq: seq++, type: "stop", reason: "tool_use" });
		await store.append("s", "r1", { seq: seq++, type: "tool_result", callId: `s${i}`, content: BIG, isError: false });
	}
	await store.append("s", "r1", { seq: seq++, type: "text_delta", text: "read them all" });
	await store.append("s", "r1", { seq: seq++, type: "stop", reason: "end_turn" });
	await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
}

const usage = (inputTokens: number) => ({ type: "usage" as const, inputTokens, outputTokens: 200, cacheRead: inputTokens - 100, cacheWrite: null, known: true });
const call = (callId: string, billed: number) => ({
	events: [{ type: "tool_call_end" as const, callId, name: "read_file", input: { path: `${callId}.ts` } }, usage(billed), { type: "stop" as const, reason: "tool_use" as const }],
});
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

type Told = Parameters<NonNullable<NonNullable<NonNullable<Parameters<typeof createAgent>[0]["contextPolicy"]>["tiers"]>["onSummary"]>>[0];

async function runWith(script: FauxScript, onSummary?: (e: Told) => void) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-in-run-summary-"));
	const store = new SessionStore(dir);
	await seed(store);
	const faux = createFauxProvider(script);
	const requests: StreamOptions[] = [];
	const adapter = { stream: (opts: StreamOptions) => (requests.push(opts), faux.stream(opts)) } as Adapter;
	const agent = createAgent({
		model: "faux",
		store,
		tools: [readFile],
		adapter,
		systemPrompt: "you are a test agent",
		contextPolicy: { tiers: { windowTokens: 200_000, ...(onSummary !== undefined ? { onSummary } : {}) } },
	});
	const session = await agent.session({ id: "s" });
	for await (const _ of session.run("continue")) {
		// the run lands in the log
	}
	return { requests, events: store.load("s").map((r) => r.event) };
}

describe("an in-run summary, told to the host", () => {
	it("kept: start (the tier, the covered rounds and tokens), progress from zero, end kept with the sizes — then the summarized event", async () => {
		const told: Told[] = [];
		const { events } = await runWith([call("c1", 155_000), say(VALID_SUMMARY), say("done")], (e) => told.push(e));
		expect(told[0]).toMatchObject({ phase: "start", reason: "hard" });
		const start = told[0] as Extract<Told, { phase: "start" }>;
		expect(start.info.rounds).toBeGreaterThanOrEqual(1);
		expect(start.info.tokens).toBeGreaterThan(10_000);
		const progress = told.filter((e) => e.phase === "progress") as Extract<Told, { phase: "progress" }>[];
		expect(progress.length).toBeGreaterThanOrEqual(1);
		expect(progress[0]!.progress.produced).toBe(0);
		const end = told.at(-1) as Extract<Told, { phase: "end" }>;
		expect(end.phase).toBe("end");
		expect(end.outcome).toBe("kept");
		expect(end.pre).toBeGreaterThan(end.post);
		expect(events.filter((e) => e.type === "summarized")).toHaveLength(1);
		// exactly one start and one end, in that order
		expect(told.filter((e) => e.phase === "start")).toHaveLength(1);
		expect(told.filter((e) => e.phase === "end")).toHaveLength(1);
	});

	it("discarded: a checkpoint that did not shrink ends `discarded`, nothing appended", async () => {
		const told: Told[] = [];
		const { events } = await runWith([call("c1", 155_000), say(BLOATED), say("done")], (e) => told.push(e));
		expect(told.at(-1)).toMatchObject({ phase: "end", outcome: "discarded" });
		expect(events.filter((e) => e.type === "summarized")).toHaveLength(0);
	});

	it("failed: both paths refused ends `failed`, the sizes equal — and the run goes on", async () => {
		const told: Told[] = [];
		const { events } = await runWith([call("c1", 155_000), say("not a checkpoint"), say("still not one"), say("done")], (e) => told.push(e));
		const end = told.at(-1) as Extract<Told, { phase: "end" }>;
		expect(end).toMatchObject({ phase: "end", outcome: "failed" });
		expect(end.post).toBe(end.pre);
		expect(events.some((e) => e.type === "terminal" && (e.outcome as { kind: string }).kind === "completed")).toBe(true);
	});

	it("display only: every request is byte-identical with and without the callback", async () => {
		const script = (): FauxScript => [call("c1", 155_000), say(VALID_SUMMARY), say("done")];
		const without = await runWith(script());
		const withIt = await runWith(script(), () => {});
		expect(withIt.requests).toHaveLength(without.requests.length);
		expect(JSON.stringify(withIt.requests)).toBe(JSON.stringify(without.requests));
	});

	it("a callback that throws changes nothing: the summary is still kept, the run still completes", async () => {
		const { events } = await runWith([call("c1", 155_000), say(VALID_SUMMARY), say("done")], () => {
			throw new Error("a host's broken display");
		});
		expect(events.filter((e) => e.type === "summarized")).toHaveLength(1);
		expect(events.some((e) => e.type === "terminal" && (e.outcome as { kind: string }).kind === "completed")).toBe(true);
	});
});
