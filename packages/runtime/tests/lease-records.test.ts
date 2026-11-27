/**
 * ADR-0064 A2 x ADR-0063 M2b — a lease session with records ON. Invariant 2
 * covers the extractor too (K3): after a compaction, neither the summary
 * request nor any extraction request carries the bootstrap's bytes, and a
 * record that quotes the bootstrap as the person's words is never admitted
 * (the provenance check reads a person's surface only from a user_input).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type AdapterEvent, type Event, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { writeBootstrap } from "../src/lease.js";
import { EXTRACTOR_SYSTEM } from "../src/records-extract.js";

const MARKER = "BOOTSTRAP-MARKER-9f3";
const BOOT = `Work snapshot at revision 4, taken when this session started. Never deploy on Fridays. ${MARKER}`;
const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
const BIG = "line of source text\n".repeat(2_000);
const readFile = defineTool({ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async () => ({ content: BIG, isError: false }) });
const usage = (inputTokens: number) => ({ type: "usage" as const, inputTokens, outputTokens: 200, cacheRead: inputTokens - 100, cacheWrite: null, known: true });
const call = (callId: string, billed: number) => ({ events: [{ type: "tool_call_end" as const, callId, name: "read_file", input: { path: `${callId}.ts` } }, usage(billed), { type: "stop" as const, reason: "tool_use" as const }] });
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

/** A lease session: the bootstrap at seq 0, then a long finished run. */
async function seedLease(store: SessionStore): Promise<void> {
	await writeBootstrap(store, "s", { meta: { leaseId: "L1", workId: "w1" }, projection: BOOT });
	let seq = 1;
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

/** A record that tries to launder the bootstrap into the person's words, and one honest record. */
const ANSWER = JSON.stringify([
	{ kind: "constraint", text: "Never deploy on Fridays.", authority: "user", quote: "Never deploy on Fridays.", evidence: [0] },
	{ kind: "constraint", text: "Never use Redis for session state.", authority: "user", quote: "Never use Redis for session state.", evidence: [1] },
]);

async function leaseWithRecords() {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-lease-records-")));
	await seedLease(store);
	const faux = createFauxProvider([call("c1", 155_000), say(VALID_SUMMARY), say("done"), say("again"), say("third")] as FauxScript);
	const requests: StreamOptions[] = [];
	const extractions: StreamOptions[] = [];
	const answers = [ANSWER];
	const adapter: Adapter = {
		stream(opts) {
			if (opts.systemPrompt !== EXTRACTOR_SYSTEM) return requests.push(opts), faux.stream(opts);
			extractions.push(opts);
			const text = answers.shift() ?? "[]";
			return {
				async *[Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
					yield { seq: 0, type: "text_delta", text };
					yield { seq: 0, type: "stop", reason: "end_turn" };
				},
			};
		},
	};
	const agent = createAgent({ model: "faux", store, tools: [readFile], adapter, systemPrompt: "you are a test agent", contextPolicy: { tiers: { windowTokens: 200_000 }, records: { enabled: true } } });
	const session = await agent.session({ id: "s" });
	const drive = async (input: string) => {
		for await (const _ of session.run(input)) void _;
		await new Promise((res) => setTimeout(res, 20)); // let an overlapped extraction settle
	};
	return { store, requests, extractions, drive, events: (): Event[] => store.load("s").map((x) => x.event) };
}

describe("a lease session with records on (invariant 2 covers the extractor, K3)", () => {
	it("a compaction and its extraction: no bootstrap bytes in the extraction or summary requests; a record citing the bootstrap is dropped", async () => {
		const s = await leaseWithRecords();
		await s.drive("continue");
		await s.drive("more");
		await s.drive("and more");
		const events = s.events();
		expect(events[0]!.type).toBe("context_bootstrap");
		const summarizedAt = events.findIndex((e) => e.type === "summarized");
		expect(summarizedAt).toBeGreaterThan(0); // the compaction did happen
		expect(s.extractions.length).toBeGreaterThan(0); // and so did an extraction
		for (const x of s.extractions) expect(JSON.stringify(x.messages)).not.toContain(MARKER);
		// the summary request: the serialised form (a lease session never takes the in-band call)
		const summaryCall = s.requests.find((r) => JSON.stringify(r.messages).includes("<conversation>"));
		expect(summaryCall).toBeDefined();
		expect(JSON.stringify(summaryCall!.messages)).not.toContain(MARKER);
		expect(JSON.stringify(events[summarizedAt])).not.toContain(MARKER);
		// the batch landed, with the person's record and without the laundered one
		const batch = events.find((e): e is Event & { type: "context_records" } => e.type === "context_records");
		expect(batch).toBeDefined();
		expect(JSON.stringify(batch)).not.toContain(MARKER);
		expect(JSON.stringify(batch!.records)).not.toContain("Fridays");
		expect(JSON.stringify(batch!.records)).toContain("Never use Redis for session state.");
		// the bootstrap still opens the model's context after all of it
		expect(s.requests.at(-1)!.messages[0]).toEqual({ role: "user", content: BOOT, source: "system" });
	});
});
