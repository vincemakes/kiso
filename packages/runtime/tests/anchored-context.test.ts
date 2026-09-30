/**
 * 0.40.0 item 8 — the context is anchored on the last BILLED request.
 *
 * The owner's session: the provider billed 732,448 input tokens on a 1M
 * window while chars/4 read the Chinese-heavy context as ~470k, so the
 * microcompact trigger (window/2) never fired and the ctx row said "~53%
 * left". These gates build that shape small: a CJK log whose estimate is
 * a few thousand tokens, with a bill far over the threshold. Red on the
 * estimate-only code: neither trigger fires. Green: both do, and every
 * event that makes the bill stale refuses the anchor.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event, Usage } from "@vincemakes/kiso-core";
import { estimateTokens } from "../src/estimate-tokens.js";
import { createAgent, SessionStore } from "../src/index.js";
import { contextAnchor } from "../src/context-anchor.js";

/** Chinese text, written as escapes: the tracked tree stays CJK-free. */
const HAN = "\u4e2d\u6587\u5185\u5bb9";

/** Seven rounds of CJK tool output, then ONE billed request of `billed`
 *  input tokens, then whatever `after` appends. */
async function seed(store: SessionStore, billed: number, after: readonly Record<string, unknown>[] = []): Promise<void> {
	let seq = 0;
	for (let i = 0; i < 7; i++) {
		await store.append("s", "r1", { seq: seq++, type: "user_input", content: `turn ${i}` });
		await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.md` } });
		await store.append("s", "r1", { seq: seq++, type: "tool_result", callId: `r${i}`, content: HAN.repeat(50), isError: false });
	}
	await store.append("s", "r1", { seq: seq++, type: "usage", inputTokens: billed, outputTokens: 1_000, cacheRead: billed - 300, cacheWrite: null, known: true });
	await store.append("s", "r1", { seq: seq++, type: "stop", reason: "end_turn" });
	for (const e of after) await store.append("s", "r1", { ...e, seq: seq++ } as never);
	await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } });
}

const ONE_TURN: FauxScript = [{ events: [{ type: "text_delta", text: "done." }, { type: "stop", reason: "end_turn" }] }];
const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");

async function drain(it: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of it) {
		// the run lands in the log and the store
	}
}

describe("the estimate undercounts; the bill does not", () => {
	it("the seeded CJK context estimates in the low thousands — the gap these gates live in", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-anchor-est-")));
		await seed(store, 600_000);
		const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(ONE_TURN) });
		const session = await agent.session({ id: "s" });
		expect(estimateTokens(session.projected())).toBeLessThan(5_000);
		// the openai-compat convention: input INCLUDES the cache read, so the
		// prompt is 600,000 — never 600,000 + 599,700 — plus the 1,000 output
		expect(session.contextAnchor()).toBe(601_000);
		expect(session.contextUsed()).toBe(601_000);
	});

	it("CJK counts one token a character; text without CJK scores exactly what chars/4 did", () => {
		const han = estimateTokens([{ role: "user", content: HAN.repeat(250) }]);
		expect(han).toBe(1_000);
		expect(estimateTokens([{ role: "user", content: "a".repeat(1_000) }])).toBe(250);
		expect(estimateTokens([{ role: "user", content: `${HAN}abcd` }])).toBe(5);
	});
});

describe("both triggers read the anchored figure", () => {
	it("the auto-summary policy FIRES on a bill over its trigger, though the estimate is far under it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-anchor-policy-")));
		await seed(store, 600_000);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider([{ events: [{ type: "text_delta", text: VALID_SUMMARY }, { type: "stop", reason: "end_turn" }] }, ...ONE_TURN]),
			contextPolicy: { summary: { triggerTokens: 500_000, keepRounds: 2, keepTokens: 50 } },
		});
		const session = await agent.session({ id: "s" });
		await drain(session.run("more"));
		expect(store.load("s").filter((r) => r.event.type === "summarized")).toHaveLength(1);
	});

	it("...and stays quiet on a bill under it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-anchor-policy-q-")));
		await seed(store, 400_000);
		const agent = createAgent({
			model: "faux",
			store,
			tools: [],
			adapter: createFauxProvider(ONE_TURN),
			contextPolicy: { summary: { triggerTokens: 500_000, keepRounds: 2, keepTokens: 50 } },
		});
		const session = await agent.session({ id: "s" });
		await drain(session.run("more"));
		expect(store.load("s").some((r) => r.event.type === "summarized")).toBe(false);
	});

	it("the kernel's microcompact trigger FIRES on a bill over window/2, and stays quiet under it", async () => {
		for (const [billed, fires] of [[600_000, true], [400_000, false]] as const) {
			const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-anchor-mc-")));
			await seed(store, billed);
			const agent = createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(ONE_TURN), microcompact: { thresholdTokens: 500_000 } });
			const session = await agent.session({ id: "s" });
			await drain(session.run("more"));
			expect(store.load("s").some((r) => r.event.type === "microcompacted"), `billed ${billed}`).toBe(fires);
		}
	});
});

describe("the anchor, and every reason to refuse it", () => {
	const total = (u: Usage): number => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
	const usage = (seq: number, known = true): Event => ({ seq, type: "usage", inputTokens: known ? 1_000 : null, outputTokens: known ? 10 : null, cacheRead: null, cacheWrite: null, known });

	it("the bill plus the estimate of what the log appended after it", () => {
		const events: Event[] = [
			usage(0),
			{ seq: 1, type: "stop", reason: "tool_use" },
			{ seq: 2, type: "tool_result", callId: "c", content: HAN.repeat(25), isError: false },
			{ seq: 3, type: "user_input", content: "a".repeat(40) },
		];
		// 1,010 billed + (100 CJK + 10 tool overhead) + 10
		expect(contextAnchor(events, total)).toBe(1_130);
	});

	it("no usage, an unreported usage, or a usage at the floor — no anchor", () => {
		expect(contextAnchor([{ seq: 0, type: "user_input", content: "hi" }], total)).toBeUndefined();
		expect(contextAnchor([usage(0, false)], total)).toBeUndefined();
		expect(contextAnchor([usage(4)], total, 4)).toBeUndefined();
		expect(contextAnchor([usage(5)], total, 4)).toBe(1_010);
	});

	it.each([
		{ seq: 1, type: "compacted" },
		{ seq: 1, type: "microcompacted", beforeSeq: 0 },
		{ seq: 1, type: "summarized", coversToSeq: 0, summary: "s" },
		{ seq: 1, type: "user_input_replaced" },
		{ seq: 1, type: "model_output_abandoned", voidFromSeq: 0, reason: "r" },
	])("a $type after the bill makes it stale — no anchor", (stale) => {
		expect(contextAnchor([usage(0), stale as unknown as Event], total)).toBeUndefined();
		// ...but one BEFORE the bill is history the bill already measured
		expect(contextAnchor([{ ...(stale as object), seq: 0 } as unknown as Event, usage(1)], total)).toBe(1_010);
	});

	it("a model switch floors the anchor until the new model sends a bill; the same model rebound keeps it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-anchor-switch-")));
		await seed(store, 600_000);
		const adapter = createFauxProvider(ONE_TURN);
		const agent = createAgent({ model: "faux", store, tools: [], adapter });
		const session = await agent.session({ id: "s" });
		session.setModelBinding({ adapter, model: "faux" });
		expect(session.contextAnchor()).toBe(601_000);
		session.setModelBinding({ adapter, model: "another-model" });
		expect(session.contextAnchor()).toBeUndefined();
		expect(session.contextUsed()).toBe(estimateTokens(session.projected()));
	});
});
