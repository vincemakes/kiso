/**
 * OR-1 follow-up (the second review, 2026-09-09) — two places where the
 * endpoint that bf962bc threaded through still did not govern:
 *
 * ① THE SUMMARY IS PRICED BY THE BINDING THAT MADE THE REQUEST. The
 *    summary call read `#adapter`/`#model` when it started and priced
 *    the usage from `#model`/`#baseUrl`/`#provider` when it ended. A
 *    /model switch DURING the call (the compaction is the session's
 *    longest single request) moved those fields under it: a subscription
 *    summary, priced after a switch to the first-party API, landed in the
 *    ledger at $5/$30. One snapshot, taken before the call, serves the
 *    request and the ledger line — the same "adapter, model, provider
 *    move together" law the run has always had (PH-F8), applied to the
 *    one off-loop call.
 *
 * ② THE RUN REFUSES BY ENDPOINT, NOT BY THE SUPERSET. The run-side
 *    resolver resolved reasoning by model id alone; the first-party row
 *    is listed first, so `none` — which the ChatGPT backend does not
 *    offer — resolved and reached the adapter for a subscription
 *    binding. The CLI refuses that pair at /model time (it passes the
 *    profile's endpoint), but the CLI's pre-check is not the runtime's
 *    guarantee: a direct setModelBinding, a recorded profile, an SDK
 *    caller all reach the run without it. The run now resolves against
 *    the binding's endpoint and refuses, by name, before any request.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const CHATGPT = "https://chatgpt.com/backend-api";
const FIRST_PARTY = "https://api.openai.com/v1";
/** 1M in + 1M out at the gpt-5.5 page's rates ($5 + $30) = $35. */
const FIRST_PARTY_USD = 35;
const RAW = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };

/** A valid checkpoint body — the (b) validation rejects anything less. */
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

/** 7 chunky rounds, completed with a terminal (the compact tests' seed). */
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

/** An adapter whose stream WAITS at a gate before it answers, so a binding
 *  switch can land in the middle of the one call it serves. */
class GatedAdapter implements Adapter {
	calls = 0;
	entered!: Promise<void>;
	#enter!: () => void;
	#release!: () => void;
	readonly gate: Promise<void>;
	constructor(readonly text: string) {
		this.entered = new Promise<void>((r) => (this.#enter = r));
		this.gate = new Promise<void>((r) => (this.#release = r));
	}
	release(): void {
		this.#release();
	}
	async *stream(_opts: StreamOptions): AsyncIterable<AdapterEvent> {
		this.calls += 1;
		this.#enter();
		await this.gate;
		yield { type: "text_delta", text: this.text, seq: 0 };
		yield { type: "usage", ...RAW, known: true, seq: 1 };
		yield { type: "stop", reason: "end_turn", seq: 2 };
	}
}

/** An adapter that records the options it was handed and answers one turn. */
class RecordingAdapter implements Adapter {
	calls = 0;
	last: StreamOptions | undefined;
	async *stream(opts: StreamOptions): AsyncIterable<AdapterEvent> {
		this.calls += 1;
		this.last = opts;
		yield { type: "text_delta", text: "ok", seq: 0 };
		yield { type: "stop", reason: "end_turn", seq: 1 };
	}
}

const ledger = (dir: string, sid = "s"): { kind: string; canonical?: { costUsd: number | null } }[] =>
	readFileSync(join(dir, "traces", `${sid}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { kind: string; canonical?: { costUsd: number | null } });

const drain = async (iter: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ev of iter) {
		// drain
	}
};

describe("OR-1 ① — the summary is priced by the binding that made the request", () => {
	it("a subscription summary whose binding switches to the first-party API mid-call still lands at null — the OLD adapter served it, the OLD endpoint prices it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-or1-summary-race-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const subscription = new GatedAdapter(VALID_SUMMARY);
		const agent = createAgent({
			model: "gpt-5.5",
			provider: "openai-responses",
			baseUrl: CHATGPT,
			adapter: subscription,
			store,
			tools: [],
		});
		const session = await agent.session({ id: "s" });

		const pending = session.summarize();
		await subscription.entered; // the request is in flight on the subscription binding
		const firstParty = new RecordingAdapter();
		session.setModelBinding({ adapter: firstParty, model: "gpt-5.5", provider: "openai-responses", baseUrl: FIRST_PARTY });
		subscription.release();
		const result = await pending;
		expect(result).not.toBeNull();

		expect(subscription.calls).toBe(1); // the in-flight call finished on the adapter that started it
		expect(firstParty.calls).toBe(0); // the switch took effect for the NEXT request, never this one
		const summaryLines = ledger(dir).filter((l) => l.kind === "summary");
		expect(summaryLines).toHaveLength(1);
		// priced by the binding that made the request: the subscription row has no price
		expect(summaryLines[0]!.canonical!.costUsd).toBeNull();
	});

	it("control: the same call with no switch at the first-party API lands at the dated rate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-or1-summary-ctl-"));
		const store = new SessionStore(dir);
		await seedLongSession(store);
		const adapter = new GatedAdapter(VALID_SUMMARY);
		adapter.release();
		const agent = createAgent({ model: "gpt-5.5", provider: "openai-responses", baseUrl: FIRST_PARTY, adapter, store, tools: [] });
		const session = await agent.session({ id: "s" });
		expect(await session.summarize()).not.toBeNull();
		const [line] = ledger(dir).filter((l) => l.kind === "summary");
		expect(line!.canonical!.costUsd).toBeCloseTo(FIRST_PARTY_USD, 9);
	});
});

describe("OR-1 ② — the run resolves reasoning against the binding's endpoint", () => {
	const bind = async (baseUrl: string, effort: "none" | "xhigh") => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-or1-run-resolve-"));
		const adapter = new RecordingAdapter();
		const agent = createAgent({ model: "gpt-5.5", provider: "openai-responses", baseUrl, adapter, store: new SessionStore(dir), tools: [] });
		const session = await agent.session({ id: "s" });
		session.setModelBinding({
			adapter,
			model: "gpt-5.5",
			provider: "openai-responses",
			baseUrl,
			scope: { providerId: baseUrl === CHATGPT ? "chatgpt" : "openai", apiId: "openai-responses", modelId: "gpt-5.5" },
			reasoning: { thinking: "default", effort },
		});
		return { session, adapter };
	};

	it("`none` at the subscription backend is refused BY NAME before any request — the adapter is never called", async () => {
		const { session, adapter } = await bind(CHATGPT, "none");
		await expect(drain(session.run("hi"))).rejects.toThrow(/does not support effort "none" \(native: low\/medium\/high\/xhigh\)/);
		expect(adapter.calls).toBe(0);
	});

	it("controls: `none` at the first-party API reaches the wire; `xhigh` at the subscription reaches the wire", async () => {
		const first = await bind(FIRST_PARTY, "none");
		await drain(first.session.run("hi"));
		expect(first.adapter.calls).toBe(1);
		expect(first.adapter.last?.reasoning).toEqual({ effort: "none" });

		const sub = await bind(CHATGPT, "xhigh");
		await drain(sub.session.run("hi"));
		expect(sub.adapter.calls).toBe(1);
		expect(sub.adapter.last?.reasoning).toEqual({ effort: "xhigh" });
	});
});
