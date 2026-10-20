/**
 * 0.51.0 — host-defined checkpoint sections (plan-checkpoint-sections rev 2.1).
 *
 * The core gate is the DEFAULT PIN: with no `checkpointSections` the summary
 * requests are 0.50.0's, byte for byte (golden sha256 of both constants,
 * recorded from 0.50.0). The rest proves the custom path: the three entry
 * points, the every-section validation, the construction errors, and that
 * the host's array is snapshotted at construction and never read again.
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, ToolRegistry, type Adapter, type StreamOptions } from "@vincemakes/kiso-core";
import { AgentSession, createAgent, DEFAULT_CHECKPOINT_SECTIONS, SessionStore, type CheckpointSection } from "../src/index.js";
import {
	CHECKPOINT_NONE_RECORDED_RULE,
	MAX_CHECKPOINT_SECTIONS_BYTES,
	renderCheckpointPrompt,
	resolveCheckpoint,
	snapshotCheckpointSections,
	SUMMARY_IN_BAND,
	SUMMARY_PROMPT,
	validateSummary,
} from "../src/summarize.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Recorded from the 0.50.0 build (SUMMARY_PROMPT 1,818 bytes, SUMMARY_IN_BAND 1,910 bytes). */
const GOLDEN_PROMPT = "46a059a901ec8f5bc6e1c83b93942192866dbc3cf477e2f54635e2254e49009d";
const GOLDEN_IN_BAND = "fffea614be6b9bd885f8573cf3c654ea9c302d16d20b3c965f54888583771e5f";

const VIDEO: readonly CheckpointSection[] = [
	{ heading: "Story", instruction: "The story so far, in two sentences." },
	{ heading: "Storyboard", instruction: "Every shot decided, one by one." },
	{ heading: "Assets", instruction: "Every asset id and what it is." },
	{ heading: "Style", instruction: "The visual style rulings." },
	{ heading: "To do", instruction: "What remains." },
];
const VIDEO_SUMMARY = VIDEO.flatMap((s) => [`## ${s.heading}`, `${s.heading.toLowerCase()} text`]).join("\n");
const DEFAULT_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");

const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });
const readFile = defineTool({
	name: "read_file",
	description: "read",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute: async () => ({ content: "x", isError: false }),
});

/** Six user turns, each with a read round — enough rounds for /compact. */
async function seed(store: SessionStore): Promise<void> {
	let seq = 0;
	for (let i = 0; i < 6; i++) {
		await store.append("s", `r${i}`, { seq: seq++, type: "user_input", content: `turn ${i}` });
		await store.append("s", `r${i}`, { seq: seq++, type: "tool_call_end", callId: `c${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		await store.append("s", `r${i}`, { seq: seq++, type: "stop", reason: "tool_use" });
		await store.append("s", `r${i}`, { seq: seq++, type: "tool_result", callId: `c${i}`, content: "line\n".repeat(100), isError: false });
		await store.append("s", `r${i}`, { seq: seq++, type: "text_delta", text: `done ${i}` });
		await store.append("s", `r${i}`, { seq: seq++, type: "stop", reason: "end_turn" });
		await store.append("s", `r${i}`, { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
	}
}

async function sessionWith(script: FauxScript, sections?: readonly CheckpointSection[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-")));
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
		...(sections !== undefined ? { contextPolicy: { checkpointSections: sections } } : {}),
	});
	const session = await agent.session({ id: "s" });
	return { session, requests, store };
}

const last = (r: StreamOptions): string => (r.messages.at(-1) as { content: string }).content;

describe("the default pin — absent sections, 0.50.0's bytes", () => {
	it("the two constants are the 0.50.0 bytes", () => {
		expect(sha(SUMMARY_PROMPT)).toBe(GOLDEN_PROMPT);
		expect(sha(SUMMARY_IN_BAND)).toBe(GOLDEN_IN_BAND);
		expect(Buffer.byteLength(SUMMARY_PROMPT)).toBe(1818);
		expect(Buffer.byteLength(SUMMARY_IN_BAND)).toBe(1910);
	});

	it("resolveCheckpoint(undefined) returns the existing constants, not a rebuild", () => {
		const r = resolveCheckpoint(undefined);
		expect(r.prompt).toBe(SUMMARY_PROMPT);
		expect(r.inBand).toBe(SUMMARY_IN_BAND);
		expect(r.headings).toBeNull();
	});

	it("/compact in-band: the last user message is SUMMARY_IN_BAND exactly; the serialized fallback's system prompt is SUMMARY_PROMPT exactly", async () => {
		const { session, requests } = await sessionWith([say("no sections at all"), say(DEFAULT_SUMMARY)]);
		const result = await session.summarize({ manualBudget: true });
		expect(result).not.toBeNull();
		expect(requests).toHaveLength(2);
		expect(Buffer.from(last(requests[0]!)).equals(Buffer.from(SUMMARY_IN_BAND))).toBe(true);
		expect(requests[1]!.systemPrompt).toBe(SUMMARY_PROMPT);
	});

	it("the two default sections are still matched by substring (unchanged behaviour)", () => {
		expect(validateSummary("## Current work\nx\n## Next steps\ny")).toBeNull();
		expect(validateSummary("## Current work\nx")).toMatch(/missing the required section ## Next steps/);
	});
});

describe("the defaults as data", () => {
	it("renderCheckpointPrompt(DEFAULT) is SUMMARY_PROMPT plus exactly the none-recorded line", () => {
		const custom = renderCheckpointPrompt(DEFAULT_CHECKPOINT_SECTIONS);
		expect(custom.replace(`${CHECKPOINT_NONE_RECORDED_RULE}\n\n`, "")).toBe(SUMMARY_PROMPT);
		expect(custom).toContain(CHECKPOINT_NONE_RECORDED_RULE);
	});

	it("the default list is frozen at both levels", () => {
		expect(Object.isFrozen(DEFAULT_CHECKPOINT_SECTIONS)).toBe(true);
		expect(DEFAULT_CHECKPOINT_SECTIONS.every((s) => Object.isFrozen(s))).toBe(true);
		expect(DEFAULT_CHECKPOINT_SECTIONS.map((s) => s.heading)).toEqual(["Goal", "Constraints", "User requests", "Files and changes", "Errors and fixes", "Current work", "Next steps"]);
	});

	it("a custom prompt keeps the frame: guard first, the host's sections in order, the identifiers rule last block", () => {
		const prompt = renderCheckpointPrompt(snapshotCheckpointSections(VIDEO)!);
		expect(prompt.startsWith(SUMMARY_PROMPT.slice(0, SUMMARY_PROMPT.indexOf("Produce the checkpoint")))).toBe(true);
		const at = VIDEO.map((s) => prompt.indexOf(`## ${s.heading}\n${s.instruction}`));
		expect(at.every((i) => i > 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		expect(prompt.endsWith(SUMMARY_PROMPT.slice(SUMMARY_PROMPT.indexOf("Preserve concrete identifiers VERBATIM")))).toBe(true);
		expect(prompt).not.toContain("## Next steps");
	});
});

describe("the custom list reaches every entry point", () => {
	it("/compact in-band carries the host's checkpoint; focus is still appended", async () => {
		const snap = snapshotCheckpointSections(VIDEO)!;
		const { inBand } = resolveCheckpoint(snap);
		const plain = await sessionWith([say(VIDEO_SUMMARY)], VIDEO);
		expect(await plain.session.summarize({ manualBudget: true })).not.toBeNull();
		expect(last(plain.requests[0]!)).toBe(inBand);
		const focused = await sessionWith([say(VIDEO_SUMMARY)], VIDEO);
		expect(await focused.session.summarize({ manualBudget: true, focus: "the opening shot" })).not.toBeNull();
		expect(last(focused.requests[0]!)).toBe(`${inBand}\n\nFocus the summary on: the opening shot`);
	});

	it("/compact serialized fallback carries it as the system prompt", async () => {
		const { session, requests } = await sessionWith([say("rambling"), say(VIDEO_SUMMARY)], VIDEO);
		expect(await session.summarize({ manualBudget: true })).not.toBeNull();
		expect(requests[1]!.systemPrompt).toBe(resolveCheckpoint(snapshotCheckpointSections(VIDEO)).prompt);
	});

	it("the run-start auto-summary (contextPolicy.summary) uses it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-rs-")));
		let seq = 0;
		for (let i = 0; i < 7; i++) {
			await store.append("s", "r1", { seq: seq++, type: "user_input", content: `turn ${i}` });
			await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.md` } });
			await store.append("s", "r1", { seq: seq++, type: "tool_result", callId: `r${i}`, content: "text ".repeat(50), isError: false });
		}
		await store.append("s", "r1", { seq: seq++, type: "usage", inputTokens: 600_000, outputTokens: 1_000, cacheRead: 599_700, cacheWrite: null, known: true });
		await store.append("s", "r1", { seq: seq++, type: "stop", reason: "end_turn" });
		await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
		const faux = createFauxProvider([say(VIDEO_SUMMARY), say("done.")]);
		const requests: StreamOptions[] = [];
		const adapter = { stream: (o: StreamOptions) => (requests.push(o), faux.stream(o)) } as Adapter;
		const agent = createAgent({ model: "faux", store, tools: [], adapter, contextPolicy: { checkpointSections: VIDEO, summary: { triggerTokens: 500_000, keepRounds: 2, keepTokens: 50 } } });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("more")) {
			// the run lands in the store
		}
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(1);
		// the run-start summary is asked in-band, on the run's own prefix
		expect(last(requests[0]!)).toBe(resolveCheckpoint(snapshotCheckpointSections(VIDEO)).inBand);
	});

	it("the in-run tier (in-band) uses it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-tier-")));
		const BIG = "line of source text\n".repeat(2_000);
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
		const reading = defineTool({ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async () => ({ content: BIG, isError: false }) });
		const call = { events: [{ type: "tool_call_end" as const, callId: "c1", name: "read_file", input: { path: "c1.ts" } }, { type: "usage" as const, inputTokens: 155_000, outputTokens: 200, cacheRead: 154_900, cacheWrite: null, known: true as const }, { type: "stop" as const, reason: "tool_use" as const }] };
		const faux = createFauxProvider([call, say(VIDEO_SUMMARY), say("done")]);
		const requests: StreamOptions[] = [];
		const adapter = { stream: (o: StreamOptions) => (requests.push(o), faux.stream(o)) } as Adapter;
		const agent = createAgent({ model: "faux", store, tools: [reading], adapter, systemPrompt: "you are a test agent", contextPolicy: { checkpointSections: VIDEO, tiers: { windowTokens: 200_000 } } });
		const session = await agent.session({ id: "s" });
		for await (const _ of session.run("continue")) {
			// the run lands in the store
		}
		const inBand = resolveCheckpoint(snapshotCheckpointSections(VIDEO)).inBand;
		expect(requests.some((r) => last(r) === inBand)).toBe(true);
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(1);
	});
});

describe("validation: every listed section, as its own line", () => {
	const heads = VIDEO.map((s) => s.heading);
	it("a complete checkpoint passes", () => {
		expect(validateSummary(VIDEO_SUMMARY, heads)).toBeNull();
	});
	it("a missing section is rejected, and the message names it", () => {
		const missing = VIDEO_SUMMARY.replace("## Style\nstyle text\n", "");
		expect(validateSummary(missing, heads)).toMatch(/missing the required section ## Style/);
	});
	it("## Story is not satisfied by ## Storyboard (no substring matching)", () => {
		const onlyBoard = ["## Storyboard", "x", "## Assets", "x", "## Style", "x", "## To do", "x"].join("\n");
		expect(validateSummary(onlyBoard, heads)).toMatch(/## Story\b/);
	});
	it("a heading in the middle of a line does not count", () => {
		const mid = VIDEO_SUMMARY.replace("## Assets", "see ## Assets");
		expect(validateSummary(mid, heads)).toMatch(/## Assets/);
	});
	it("tool-call markup is still rejected, and the empty text", () => {
		expect(validateSummary(`${VIDEO_SUMMARY}\n<tool_call>`, heads)).toMatch(/tool-call marker/);
		expect(validateSummary("  ", heads)).toBe("the summary is empty");
	});
	it("an incomplete reply goes in-band, then serialized, then fails; the context is unchanged", async () => {
		const { session, requests, store } = await sessionWith([say("## Story\nonly one"), say("## Story\nstill one")], VIDEO);
		const before = store.load("s").length;
		await expect(session.summarize({ manualBudget: true })).rejects.toThrow(/invalid summary/);
		expect(requests).toHaveLength(2);
		expect(store.load("s")).toHaveLength(before);
	});
});

describe("construction: fail fast, never truncate", () => {
	const bad = (sections: unknown): string => {
		try {
			snapshotCheckpointSections(sections as never);
		} catch (e) {
			return (e as Error).message;
		}
		return "";
	};
	it("rejects each malformed list with a message that starts Invalid contextPolicy.checkpointSections", () => {
		expect(bad([])).toMatch(/^Invalid contextPolicy\.checkpointSections: .*1 to 16/);
		expect(bad(Array.from({ length: 17 }, (_, i) => ({ heading: `H${i}`, instruction: "i" })))).toMatch(/got 17/);
		expect(bad([{ heading: "  ", instruction: "i" }])).toMatch(/empty heading/);
		expect(bad([{ heading: "a\nb", instruction: "i" }])).toMatch(/one line/);
		expect(bad([{ heading: "x".repeat(81), instruction: "i" }])).toMatch(/cap is 80/);
		expect(bad([{ heading: "# Goal", instruction: "i" }])).toMatch(/must not start with "#"/);
		expect(bad([{ heading: "Goal", instruction: "i" }, { heading: "GOAL", instruction: "i" }])).toMatch(/repeats an earlier one/);
		expect(bad([{ heading: "Goal", instruction: " " }])).toMatch(/empty instruction/);
		expect(bad("nope")).toMatch(/must be an array/);
	});
	it("caps the rendered sections at 8,192 UTF-8 bytes, counting bytes not characters", () => {
		const ascii = [{ heading: "A", instruction: "x".repeat(MAX_CHECKPOINT_SECTIONS_BYTES) }];
		expect(bad(ascii)).toMatch(/bytes, the cap is 8192/);
		// 3 bytes a character: 3,000 characters is 9,000 bytes
		expect(bad([{ heading: "A", instruction: "€".repeat(3_000) }])).toMatch(/9\d{3} bytes/);
		expect(bad([{ heading: "A", instruction: "€".repeat(2_000) }])).toBe("");
	});
	it("createAgent throws at construction, before any session", () => {
		expect(() => createAgent({ model: "faux", store: new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-bad-"))), tools: [], adapter: createFauxProvider([]), contextPolicy: { checkpointSections: [] } })).toThrow(/Invalid contextPolicy\.checkpointSections/);
	});
});

describe("determinism and the snapshot", () => {
	it("two summaries from one configuration send identical bytes", async () => {
		const a = await sessionWith([say(VIDEO_SUMMARY)], VIDEO);
		const b = await sessionWith([say(VIDEO_SUMMARY)], VIDEO);
		await a.session.summarize({ manualBudget: true });
		await b.session.summarize({ manualBudget: true });
		expect(last(a.requests[0]!)).toBe(last(b.requests[0]!));
	});

	it("a host that edits its array after createAgent and before session() changes nothing", async () => {
		const mine: CheckpointSection[] = VIDEO.map((s) => ({ ...s }));
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-snap-")));
		await seed(store);
		const faux = createFauxProvider([say(VIDEO_SUMMARY)]);
		const requests: StreamOptions[] = [];
		const adapter = { stream: (o: StreamOptions) => (requests.push(o), faux.stream(o)) } as Adapter;
		const agent = createAgent({ model: "faux", store, tools: [readFile], adapter, systemPrompt: "t", contextPolicy: { checkpointSections: mine } });
		mine.push({ heading: "Extra", instruction: "late" });
		mine[0] = { heading: "Changed", instruction: "late" };
		const session = await agent.session({ id: "s" });
		await session.summarize({ manualBudget: true });
		expect(last(requests[0]!)).toBe(resolveCheckpoint(snapshotCheckpointSections(VIDEO)).inBand);
		expect(last(requests[0]!)).not.toContain("Extra");
	});

	it("a direct AgentSession snapshots in its own constructor", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cps-direct-")));
		await seed(store);
		const mine: CheckpointSection[] = VIDEO.map((s) => ({ ...s }));
		const faux = createFauxProvider([say(VIDEO_SUMMARY)]);
		const requests: StreamOptions[] = [];
		const adapter = { stream: (o: StreamOptions) => (requests.push(o), faux.stream(o)) } as Adapter;
		const agent = createAgent({ model: "faux", store, tools: [readFile], adapter, systemPrompt: "t" });
		const viaAgent = await agent.session({ id: "s" });
		expect(viaAgent).toBeInstanceOf(AgentSession);
		const direct = new AgentSession("s", viaAgent.log, store, adapter, { model: "faux", registry: new ToolRegistry(), contextPolicy: { checkpointSections: mine } } as never);
		mine.push({ heading: "Extra", instruction: "late" });
		await direct.summarize({ manualBudget: true });
		expect(last(requests[0]!)).not.toContain("Extra");
	});

	it('" Story " renders and validates as "## Story"', () => {
		const snap = snapshotCheckpointSections([{ heading: " Story ", instruction: " the story " }])!;
		expect(snap[0]).toEqual({ heading: "Story", instruction: "the story" });
		expect(renderCheckpointPrompt(snap)).toContain("## Story\nthe story");
		expect(validateSummary("## Story\nx", snap.map((s) => s.heading))).toBeNull();
	});

	it("the snapshot is frozen at both levels", () => {
		const snap = snapshotCheckpointSections(VIDEO)!;
		expect(Object.isFrozen(snap)).toBe(true);
		expect(snap.every((s) => Object.isFrozen(s))).toBe(true);
		expect(snap).not.toBe(VIDEO);
	});
});
