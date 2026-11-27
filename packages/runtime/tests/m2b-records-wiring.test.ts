/**
 * ADR-0063 M2b — the extraction wiring (spec `spec-m2b-extraction-wiring`,
 * rev 1). OFF by default: a compaction makes no extraction call, writes no
 * batch and no records ledger line. ON: one serialized extraction per
 * boundary, overlapped with the run, landing through the compaction point;
 * a transport failure writes nothing and merges into the next boundary; a
 * deterministic failure twice commits the range empty, counted in the trace.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type AdapterEvent, type Event, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { EXTRACTOR_SYSTEM, serializeRange } from "../src/records-extract.js";
import { log } from "./fixtures/history-logs.js";

const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
const BIG = "line of source text\n".repeat(2_000);
const readFile = defineTool({ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async () => ({ content: BIG, isError: false }) });

async function seed(store: SessionStore): Promise<void> {
	let seq = 0;
	await store.append("s", "r1", { seq: seq++, type: "user_input", content: "Never use Redis for session state. Work through the repo." });
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
const call = (callId: string, billed: number) => ({ events: [{ type: "tool_call_end" as const, callId, name: "read_file", input: { path: `${callId}.ts` } }, usage(billed), { type: "stop" as const, reason: "tool_use" as const }] });
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

type Answer = string | { readonly throws: string } | { readonly truncated: string };
/** Main requests go to the faux script; extraction requests (the extractor's system prompt) are answered in order. */
function router(main: FauxScript, answers: Answer[]) {
	const faux = createFauxProvider(main);
	const requests: StreamOptions[] = [];
	const extractions: StreamOptions[] = [];
	const adapter: Adapter = {
		stream(opts) {
			if (opts.systemPrompt !== EXTRACTOR_SYSTEM) return requests.push(opts), faux.stream(opts);
			extractions.push(opts);
			const a = answers.shift() ?? "[]";
			return {
				async *[Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
					if (typeof a === "object" && "throws" in a) throw new Error(a.throws);
					const text = typeof a === "string" ? a : a.truncated;
					yield { seq: 0, type: "text_delta", text };
					yield { seq: 0, type: "stop", reason: typeof a === "string" ? "end_turn" : "max_tokens" };
				},
			};
		},
	};
	return { adapter, requests, extractions };
}

async function session(main: FauxScript, answers: Answer[], records: boolean | undefined) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-m2b-"));
	const store = new SessionStore(dir);
	await seed(store);
	const r = router(main, answers);
	const agent = createAgent({
		model: "faux",
		store,
		tools: [readFile],
		adapter: r.adapter,
		systemPrompt: "you are a test agent",
		contextPolicy: { tiers: { windowTokens: 200_000 }, ...(records !== undefined ? { records: { enabled: records } } : {}) },
	});
	const s = await agent.session({ id: "s" });
	const drive = async (input: string) => {
		for await (const _ of s.run(input)) void _;
		await new Promise((res) => setTimeout(res, 20)); // let an overlapped extraction settle
	};
	const events = () => store.load("s").map((x) => x.event);
	const ledger = () => {
		try {
			return readFileSync(join(dir, "traces", "s.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
		} catch {
			return [];
		}
	};
	return { ...r, drive, events, ledger };
}

const COMPACTING: FauxScript = [call("c1", 155_000), say(VALID_SUMMARY), say("done"), say("again"), say("third")];
const batches = (events: readonly Event[]) => events.filter((e): e is Event & { type: "context_records" } => e.type === "context_records");

describe("M2b: off by default", () => {
	for (const records of [undefined, false]) {
		it(`records ${String(records)}: a compaction happens and NO extraction call is made, no batch, no ledger line`, async () => {
			const s = await session(COMPACTING, [], records);
			await s.drive("continue");
			await s.drive("more");
			expect(s.events().some((e) => e.type === "summarized")).toBe(true); // the compaction did happen
			expect(s.extractions).toHaveLength(0);
			expect(batches(s.events())).toHaveLength(0);
			expect(s.ledger().filter((l) => l.kind === "records")).toHaveLength(0);
			expect(s.ledger().some((l) => l.purpose === "records")).toBe(false);
		});
	}
});

describe("M2b: on", () => {
	const constraint = (seq: number) => JSON.stringify([{ kind: "constraint", text: "no Redis for session state", authority: "user", quote: "Never use Redis for session state.", evidence: [seq] }]);

	it("a committed checkpoint starts one extraction over (cursor, coversToSeq]; its batch lands at a later request, through the run's writer", async () => {
		const s = await session(COMPACTING, [constraint(0)], true);
		await s.drive("continue");
		await s.drive("more");
		const ev = s.events();
		const fired = ev.find((e): e is Event & { type: "summarized" } => e.type === "summarized")!;
		const b = batches(ev);
		expect(b).toHaveLength(1);
		expect(b[0]).toMatchObject({ coversFromSeq: -1, coversToSeq: fired.coversToSeq, batchKey: `s:-1:${fired.coversToSeq}:${fired.seq}` });
		expect(b[0]!.records).toEqual([expect.objectContaining({ kind: "constraint", authority: "user", quote: { owner: "session/s", seq: 0, span: "Never use Redis for session state." } })]);
		expect("projection" in b[0]!).toBe(false);
		expect(s.extractions[0]!.messages[0]).toMatchObject({ role: "user" });
		// accounted like a side call: a traced request (purpose "records") and a ledger line
		expect(s.ledger().some((l) => l.purpose === "records")).toBe(true);
		expect(s.ledger().filter((l) => l.kind === "records")[0]).toMatchObject({ outcome: "batch", records: 1, retried: false });
	});

	it("a transport failure writes nothing; the next boundary pays the merged range", async () => {
		const s = await session(COMPACTING, [{ throws: "503 upstream" }, "[]"], true);
		await s.drive("continue"); // compaction → extraction 1 fails; run end → extraction 2 over the merged range
		await s.drive("more"); // its batch lands here
		const b = batches(s.events());
		expect(s.ledger().filter((l) => l.kind === "records").map((l) => l.outcome).slice(0, 2)).toEqual(["transport-failure", "batch"]);
		expect(b).toHaveLength(1);
		expect(b[0]!.coversFromSeq).toBe(-1); // nothing was committed for the failed range: it merged
		expect(b[0]!.records).toEqual([]);
	});

	it("a deterministic failure gets one retry; twice, the range commits empty and the trace counts it", async () => {
		const s = await session(COMPACTING, ["not json", { truncated: '[{"kind": "constraint", "te' }], true);
		await s.drive("continue");
		await s.drive("more");
		expect(s.extractions).toHaveLength(2 + 1); // the failed pair, then the run-end extraction over the next range
		const lines = s.ledger().filter((l) => l.kind === "records");
		expect(lines[0]).toMatchObject({ outcome: "empty-after-failure", retried: true, records: 0 });
		expect(batches(s.events())[0]!.records).toEqual([]);
	});

	it("admission drops are counted by reason: outside the range, a failed quote, a secret, a deferred kind", async () => {
		const key = `${"sk-" + "ant-"}${"aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"}`;
		const answer = JSON.stringify([
			{ kind: "constraint", text: "no Redis", authority: "user", quote: "Never use Redis for session state.", evidence: [0] },
			{ kind: "constraint", text: "x", authority: "user", quote: "x", evidence: [999_999] },
			{ kind: "constraint", text: "use Postgres", authority: "user", quote: "Use Postgres only", evidence: [0] },
			{ kind: "decision", text: `decided: rotate the key ${key}`, authority: "model", evidence: [1] },
			{ kind: "change", text: "annotated f0.ts", authority: "model", evidence: [1] },
		]);
		const s = await session(COMPACTING, [answer], true);
		await s.drive("continue");
		await s.drive("more");
		expect(batches(s.events())[0]!.records).toHaveLength(1);
		expect(s.ledger().filter((l) => l.kind === "records")[0]!.drops).toEqual({
			"evidence outside the range": 1,
			"user quote failed the provenance check": 1,
			"contains a secret: provider-key": 1,
			"unknown kind change": 1,
		});
		expect(JSON.stringify(s.ledger())).not.toContain(key); // the match is never written anywhere
	});
});

describe("M2b: the serializer (bytes pinned)", () => {
	it("labels chips and runtime input, bounds tool output, omits thinking", () => {
		const events = log([
			{ seq: 0, type: "user_input", content: "Never use Redis." },
			{ seq: 1, type: "user_input", content: "Use the suggested plan", source: "suggestion" },
			{ seq: 2, type: "user_input", content: "task finished: lint", via: { kind: "tasks" } },
			{ seq: 3, type: "thinking", text: "private" },
			{ seq: 4, type: "tool_call_end", callId: "c", name: "read_file", input: { path: "a.ts" } },
			{ seq: 5, type: "stop", reason: "tool_use" },
			{ seq: 6, type: "tool_result", callId: "c", invocationSeq: 4, content: "y".repeat(400), isError: false },
			{ seq: 7, type: "text_delta", text: "ok" },
			{ seq: 8, type: "stop", reason: "end_turn" },
		]);
		expect(serializeRange(events, -1, 8)).toBe(
			[
				"#0 [person] Never use Redis.",
				"#1 [suggestion chip — not the person's words] Use the suggested plan",
				"#2 [runtime input — not the person's words] task finished: lint",
				'#4 [tool call read_file] {"path":"a.ts"}',
				`#6 [tool result read_file] ${"y".repeat(300)}… (100 more chars)`,
				"#7 [assistant] ok",
			].join("\n"),
		);
		expect(serializeRange(events, 4, 8).startsWith("#6 ")).toBe(true); // only the range
	});
});
