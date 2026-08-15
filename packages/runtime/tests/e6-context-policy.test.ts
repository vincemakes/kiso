/**
 * E6 (context policy) — the run-start policy machinery:
 *   A — auto-summary: at run start, when the projected context crosses
 *       the policy's triggerTokens AND enough uncovered rounds exist
 *       (keepRounds), the runtime fires the EXISTING summarize() path —
 *       one durable `summarized` fact, persisted BEFORE this run's
 *       user_input, riding the LAST recorded run (a summarized fact never
 *       opens a run of its own). The projection compresses; the loop's
 *       first request of the run sees the compressed view.
 *   B — session-aware microcompact: the policy's threshold override wins
 *       over the session's own, and the minTurns no-fire guard omits the
 *       config below the floor (a short task never pays the break).
 *   C — the crux drop arm (experiment-only): the SAME trigger persists a
 *       fixed placeholder with NO model call — the covered turns leave
 *       the sent context at zero generation cost.
 * Plus the honest-accounting fix: the summary call's usage rides the
 * trace ledger as a `kind: "summary"` line (both the manual /compact
 * path and the auto path) — the blind spot the E5 baseline carried.
 *
 * Red before green: these gates fail against the pre-E6 runtime (no
 * contextPolicy surface, no summary-usage ledger line).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, estimateTokens, projectMessages, type Adapter, type AdapterEvent, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { DROP_PLACEHOLDER } from "../src/summarize.js";

/** 7 chunky rounds, the shape of a long session (user + read + result),
 *  COMPLETED with a terminal so later runs() pass the open-run gate.
 *  Round i's input sits at seq 3i; the "final" input (seq 21) counts as a
 *  user input too. With keepRounds=2 the ADR-0044 formula keeps the last
 *  2 uncovered inputs (turn 6 at 18, "final" at 21) and the boundary is
 *  the first kept input minus one = 18−1 = 17 (covered turns 0-5). */
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

const ONE_TURN: FauxScript = [
	{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] },
];

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

/** A counting adapter: every stream call is countable, and an optional
 *  usage event rides each stream (the summary-usage ledger line's source). */
class CountingAdapter implements Adapter {
	calls = 0;
	/** The FIRST stream call's options — E6 (g): on the auto path the
	 *  policy's summarize call is the FIRST adapter call (it fires
	 *  BEFORE the run's loop requests); the loop's turn is the last. */
	firstOpts?: StreamOptions;
	constructor(readonly usage: { input: number; cacheRead: number; output: number } | null = null) {}
	async *stream(opts: StreamOptions): AsyncIterable<AdapterEvent> {
		this.calls += 1;
		if (this.firstOpts === undefined) this.firstOpts = opts;
		let seq = 0;
		yield { type: "text_delta", text: VALID_SUMMARY, seq: seq++ };
		if (this.usage !== null) {
			yield {
				type: "usage",
				inputTokens: this.usage.input,
				outputTokens: this.usage.output,
				cacheRead: this.usage.cacheRead,
				cacheWrite: null,
				known: true,
				seq: seq++,
			};
		}
		yield { type: "stop", reason: "end_turn", seq };
	}
}

const ledgerLines = (dir: string, sid = "s"): Record<string, unknown>[] =>
	readFileSync(join(dir, "traces", `${sid}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("E6 context policy — the auto-summary (candidate A)", () => {
	it("fires at run start when the projected context crosses the trigger, and the summary rides the LAST recorded run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-a1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			// The summary call plays the FIRST script turn — it must emit a
			// valid checkpoint (the (b) validation); the loop's turn is the second.
			adapter: createFauxProvider([
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain — the turn lands in the log + store
		}

		const durable = store.load("s");
		const summaries = durable.filter((r) => r.event.type === "summarized");
		expect(summaries).toHaveLength(1);
		const s = summaries[0]!.event as { coversToSeq: number; seq: number };
		expect(s.coversToSeq).toBe(17); // covered turns 0-5; turns 6 + "final" kept (the last 2 inputs)
		// The policy fired BEFORE this run's user_input — the summarized
		// event precedes it in seq order.
		const input = durable.find((r) => r.event.type === "user_input" && r.event.content === "more")!;
		expect(s.seq).toBeLessThan((input.event as { seq: number }).seq);
		// A summarized fact never opens a run of its own: it rides the
		// LAST recorded run (the seeded "r1"), never this run's id.
		expect(summaries[0]!.runId).toBe("r1");
		// The projection excludes the covered rounds and shows the summary.
		const msgs = projectMessages(durable.map((r) => r.event));
		expect(msgs.some((m) => m.role === "user" && m.content === "turn 0")).toBe(false);
		// The boundary's edge: turn 5 (seq 15) is covered, turn 6 (seq 18) kept.
		expect(msgs.some((m) => m.role === "user" && m.content === "turn 5")).toBe(false);
		expect(msgs.some((m) => m.role === "user" && m.content === "turn 6")).toBe(true);
	});

	it("restraint: a short session below the trigger never fires, and the turn still runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-a2-"));
		const store = new SessionStore(dir);
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "hi" });
		await store.append("s", "r1", { seq: 1, type: "terminal", outcome: { kind: "completed" } });
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider(ONE_TURN),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("again")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
		// The run completed normally.
		const terminal = store.load("s").find((r) => r.event.type === "terminal" && r.runId !== "r1");
		expect(terminal).toBeDefined();
	});

	it("the keepRounds gate: a crossed trigger with too few uncovered rounds fires nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-a3-"));
		const store = new SessionStore(dir);
		// Two BIG rounds — the projected context crosses the trigger, but
		// uncovered rounds (2) never exceed keepRounds (2).
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "turn 0" });
		await store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "r0", name: "read_file", input: { path: "f0.ts" } });
		await store.append("s", "r1", { seq: 2, type: "tool_result", callId: "r0", content: "line\n".repeat(200), isError: false });
		await store.append("s", "r1", { seq: 3, type: "user_input", content: "turn 1" });
		await store.append("s", "r1", { seq: 4, type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "f1.ts" } });
		await store.append("s", "r1", { seq: 5, type: "tool_result", callId: "r1", content: "line\n".repeat(200), isError: false });
		await store.append("s", "r1", { seq: 6, type: "terminal", outcome: { kind: "completed" } });
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider(ONE_TURN),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
	});

	it("a policy summary failure never fails the user's turn (nothing happened, the run proceeds)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-a4-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		// Script turn 1 = the summary call: empty text → throws; turn 2 =
		// the loop's turn: normal. The policy must swallow the summary
		// failure and let the run complete.
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{ events: [{ type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] },
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain — must NOT throw
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
		expect(store.load("s").some((r) => r.event.type === "user_input" && r.event.content === "more")).toBe(true);
	});
});

describe("E6 context policy — the drop arm (candidate C, crux experiment only)", () => {
	it("persists the placeholder with ZERO model calls, and the run still completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-c1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingAdapter();
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			contextPolicy: { drop: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		const summaries = store.load("s").filter((r) => r.event.type === "summarized");
		expect(summaries).toHaveLength(1);
		expect((summaries[0]!.event as { summary: string }).summary).toBe(DROP_PLACEHOLDER);
		// ONLY the loop's turn called the adapter — the drop is mechanical,
		// no summary call, no usage ledger line.
		expect(adapter.calls).toBe(1);
		const summaryLines = ledgerLines(dir).filter((l) => l.kind === "summary");
		expect(summaryLines).toHaveLength(0);
		expect(store.load("s").some((r) => r.event.type === "user_input" && r.event.content === "more")).toBe(true);
	});
});

describe("E6 context policy — the summary usage rides the ledger (the honest accounting fix)", () => {
	it("the MANUAL /compact path records the summary call's usage as a kind:summary line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-usage1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingAdapter({ input: 1200, cacheRead: 300, output: 250 });
		const agent = createAgent({ model: "faux", store, tools: [], adapter });
		const session = await agent.session({ id: "s" });

		await session.summarize();

		const lines = ledgerLines(dir).filter((l) => l.kind === "summary");
		expect(lines).toHaveLength(1);
		const c = lines[0]!.canonical as { input: number; cacheRead: number; output: number };
		// The "adapter" route rides the total convention (the pinned
		// canonicalizeUsage formula): input = fresh = raw − cacheRead.
		expect(c.input).toBe(900);
		expect(c.cacheRead).toBe(300);
		expect(c.output).toBe(250);
	});

	it("the AUTO path records it too, BEFORE the run's loop requests", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-usage2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingAdapter({ input: 1200, cacheRead: 300, output: 250 });
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		const lines = ledgerLines(dir);
		const summaryLines = lines.filter((l) => l.kind === "summary");
		expect(summaryLines).toHaveLength(1); // the policy's call — never a second one
		// The request lines (the loop's) exist alongside.
		expect(lines.some((l) => l.kind === "request")).toBe(true);
	});
});

describe("E6 context policy — the session-aware microcompact (candidate B)", () => {
	it("the policy's threshold override wins over the session's own, and minTurns holds the no-fire guard", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-b1-"));
		const store = new SessionStore(dir);
		// Two seeded rounds with compactable results.
		await store.append("s", "r1", { seq: 0, type: "user_input", content: "turn 0" });
		await store.append("s", "r1", { seq: 1, type: "tool_call_end", callId: "r0", name: "read_file", input: { path: "f0.ts" } });
		await store.append("s", "r1", { seq: 2, type: "tool_result", callId: "r0", content: "line\n".repeat(200), isError: false });
		await store.append("s", "r1", { seq: 3, type: "user_input", content: "turn 1" });
		await store.append("s", "r1", { seq: 4, type: "tool_call_end", callId: "r1", name: "read_file", input: { path: "f1.ts" } });
		await store.append("s", "r1", { seq: 5, type: "tool_result", callId: "r1", content: "line\n".repeat(200), isError: false });
		await store.append("s", "r1", { seq: 6, type: "terminal", outcome: { kind: "completed" } });
		// The session's own microcompact is huge (never fires); the policy's
		// override is tiny (fires) — the override must WIN. minTurns=3: the
		// guard blocks below 3 completed user inputs. keepResults=1: the
		// kernel's frozen keep-4 default needs 5+ compactable results; with
		// 2 seeded results the override's keepResults is the honest way to
		// exercise the boundary (the passthrough is part of the surface).
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([...ONE_TURN, ...ONE_TURN]),
			microcompact: { thresholdTokens: 1e12 },
			contextPolicy: { microcompact: { thresholdTokens: 10, keepResults: 1, minTurns: 3 } },
		});
		const session = await agent.session({ id: "s" });
		const compacted = () => store.load("s").filter((r) => r.event.type === "microcompacted");
		expect(compacted()).toHaveLength(0); // the seed's runs never compacted

		// Turn 3's run: user_input count 2 < minTurns 3 → no fire.
		for await (const _ev of session.run("more1")) {
			// drain
		}
		expect(compacted()).toHaveLength(0);

		// Turn 4's run: 3 >= 3 → the override fires (the tiny threshold).
		for await (const _ev of session.run("more2")) {
			// drain
		}
		expect(compacted().length).toBeGreaterThan(0);
	});
});

describe("E6 hardening (b) — the auto path REJECTS the DSML body (the auto-T5-1 regression)", () => {
	it("a summary call emitting tool-call markup persists NOTHING — the safe catch, the run proceeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-b2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		// Script turn 1 = the summary call: the auto-T5-1-shaped garbage —
		// tool-call markup as text (the finding E6-F4/F5 signature), no
		// checkpoint sections. Turn 2 = the loop's turn: normal.
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{
					events: [
						{
							type: "text_delta",
							text: '{"type":"tool_call_end","name":"read_file","input":{"path":"src/cli.js"}}',
						},
						{ type: "stop", reason: "end_turn" },
					],
				},
				{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] },
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain — must NOT throw
		}
		// REJECTED: nothing persisted, nothing projected — "nothing happened".
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
		expect(store.load("s").some((r) => r.event.type === "user_input" && r.event.content === "more")).toBe(true);
	});

	it("a truncated summary (no Next steps) is rejected the same way", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-b3-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{
					events: [
						{
							type: "text_delta",
							text: "## Goal\nwire the flags\n## Current work\nhalf done",
						},
						{ type: "stop", reason: "end_turn" },
					],
				},
				{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] },
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
		expect(store.load("s").some((r) => r.event.type === "user_input" && r.event.content === "more")).toBe(true);
	});
});

describe("E6 hardening (f) — the policy's keep-token floor", () => {
	it("a floor the session cannot meet blocks the fire — the auto path never pays a break it cannot amortize", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-f1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store); // ~7 small rounds ≈ a few hundred tokens
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 10_000 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		// The 10k floor exceeds the whole session — no fire, nothing persisted.
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
	});

	it("a small floor lets the same session fire — the env-overridable floor works", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-f2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
			]),
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 50 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(true);
	});
});

describe("E6 (g) — the trigger is window minus the reserve, and the summarize call carries the explicit max-output", () => {
	it("the window-armed mode fires at window minus the reserve (the runtime owns the arithmetic)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-g1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
			]),
			// 34000 − 32000 = 2000 — the pre-registered decisive-experiment
			// arming point. The seeded session (~2.3k tokens) crosses it.
			contextPolicy: { summary: { windowTokens: 34000, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(1);
	});

	it("the window-armed mode stays INERT below window minus the reserve — the undefined-trigger fall-through never happens", async () => {
		// Six small rounds ≈ 320 projected tokens — enough uncovered rounds
		// to fire, but far below the window-derived trigger 2000. An
		// unresolved windowTokens must NOT fire — the `projected <=
		// undefined` comparison is always false, and a naive gate lets
		// that fall THROUGH to a fire. This is the red-crucial
		// discriminator: the positive fire alone cannot tell the
		// arithmetic from the fall-through (the round gate below cannot
		// either — the session must clear it).
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-g3-"));
		const store = new SessionStore(dir);
		let seq = 0;
		for (let i = 0; i < 6; i++) {
			await store.append("s", "r1", { seq: seq++, type: "user_input", content: `turn ${i}` });
			await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			await store.append("s", "r1", { seq: seq++, type: "tool_result", callId: `r${i}`, content: "x".repeat(100), isError: false });
		}
		await store.append("s", "r1", { seq: seq++, type: "user_input", content: "final" });
		await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
			]),
			contextPolicy: { summary: { windowTokens: 34000, keepTokens: 50 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
	});

	it("the auto-fire's summarize call carries the explicit output budget (the adapter maxTokens)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-g2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingAdapter();
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("more")) {
			// drain
		}
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(true);
		expect(adapter.firstOpts?.maxTokens).toBe(4000);
	});
});

describe("E6 (h) — the circuit breaker: ≤3 summary failures stand the auto policy down", () => {
	const FAIL_TURN: FauxScript = [{ events: [{ type: "stop", reason: "end_turn" }] }];

	/** A call-counting pass-through — the faux provider carries the
	 *  scripted failure/success turns, the wrapper counts every stream
	 *  call (the breaker assertions are about HOW MANY calls happen). */
	class CountingFaux implements Adapter {
		calls = 0;
		constructor(private readonly inner: Adapter) {}
		async *stream(opts: StreamOptions): AsyncIterable<AdapterEvent> {
			this.calls += 1;
			yield* this.inner.stream(opts);
		}
	}

	it("three consecutive failures stand the policy down for the rest of the session — the fourth fire is never attempted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-h1-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingFaux(
			createFauxProvider([FAIL_TURN, ONE_TURN, FAIL_TURN, ONE_TURN, FAIL_TURN, ONE_TURN, ONE_TURN]),
		);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			// Each run: the policy fires FIRST (a failing summary call — the
			// empty-text rejection throws through the safe catch), then the
			// loop's turn. Fire 4 is skipped by the breaker.
			adapter,
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250 } },
		});
		const session = await agent.session({ id: "s" });
		for (let i = 0; i < 4; i++) {
			for await (const _ev of session.run(`more ${i}`)) {
				// drain — must NOT throw
			}
		}
		// NOTHING persisted — every fire failed ("nothing happened"), and
		// the breaker skipped the fourth attempt.
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(0);
		// 3 summary calls (the breaker held the 4th) + 4 loop turns.
		expect(adapter.calls).toBe(7);
	});

	it("a successful fire resets the breaker — the failure budget starts fresh", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-h2-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingFaux(
			createFauxProvider([
				FAIL_TURN,
				ONE_TURN,
				FAIL_TURN,
				ONE_TURN,
				{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] },
				ONE_TURN,
				FAIL_TURN,
				ONE_TURN,
				FAIL_TURN,
				ONE_TURN,
				FAIL_TURN,
				ONE_TURN,
			]),
		);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			// keepRounds 1: a successful compact leaves only the kept rounds
			// uncovered — the round gate would silence the fail-after-success
			// arc with any larger keep. keepTokens 0: the post-compact
			// session (~350 tokens) cannot keep ANY floor AND cover a whole
			// round — the floor walk's boundary lands below the first
			// uncovered input, "nothing to compact" (the amortization guard,
			// by design) — the reset arc needs the floor off. triggerTokens
			// 10: the post-fire projection must still cross it.
			contextPolicy: { summary: { triggerTokens: 10, keepRounds: 1, keepTokens: 0 } },
		});
		const session = await agent.session({ id: "s" });
		for (let i = 0; i < 6; i++) {
			for await (const _ev of session.run(`more ${i}`)) {
				// drain
			}
		}
		// Fire 3 persisted; fires 1-2, 4-5 failed; fire 6 stood down —
		// 6 summary attempts + 6 loop turns = 12 adapter calls (a broken
		// reset would stand down at fire 5 → 10).
		const summaries = store.load("s").filter((r) => r.event.type === "summarized");
		expect(summaries).toHaveLength(1);
		expect((summaries[0]!.event as { summary: string }).summary).toBe(VALID_SUMMARY);
		expect(adapter.calls).toBe(12);
	});

	it("the configurable limit: maxFailures 1 stands the policy down after ONE failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-e6-h3-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new CountingFaux(createFauxProvider([FAIL_TURN, ONE_TURN, ONE_TURN, ONE_TURN]));
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter,
			contextPolicy: { summary: { triggerTokens: 100, keepRounds: 2, keepTokens: 250, maxFailures: 1 } },
		});
		const session = await agent.session({ id: "s" });
		for (let i = 0; i < 2; i++) {
			for await (const _ev of session.run(`more ${i}`)) {
				// drain
			}
		}
		// ONE summary attempt (failed) — the second fire is skipped.
		expect(adapter.calls).toBe(3); // 1 summary + 2 loop turns
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(0);
	});
});
