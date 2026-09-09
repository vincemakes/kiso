/**
 * OR-1 follow-up — the ENDPOINT travels with the live binding, so the
 * cost path never prices a subscription run at the first-party rate.
 *
 * The registry gives gpt-5.5 two rows (a93d9d3): the first-party API with
 * a dated per-token price, and the ChatGPT backend with `pricing: null`
 * because a subscription is not billed per token. The first-party row is
 * listed first ON PURPOSE (the run-side reasoning resolver passes no
 * endpoint and must land on the superset). The cost path paid for that
 * ordering: every runtime caller of canonicalizeUsageForModel passed
 * `undefined` as the endpoint, so a subscription run resolved to the
 * priced row and the status row showed a first-party dollar figure — the
 * exact "a rate pretending to be a bill" the row's comment forbids. The
 * unit test only ever passed the endpoint explicitly, so it never saw
 * the call shape the runtime actually used.
 *
 * The fix is the PH-F8 discipline one passenger wider: the endpoint moves
 * WITH the adapter, the model id and the provider route (SessionConfig
 * and setModelBinding both carry `baseUrl`), the tracer is handed it at
 * run construction, and the CLI reads `session.baseUrl` exactly as it
 * reads `session.provider`.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { RequestTracer } from "../src/trace/guard.js";

const CHATGPT = "https://chatgpt.com/backend-api";
const FIRST_PARTY = "https://api.openai.com/v1";
/** 1M in + 1M out at the gpt-5.5 page's rates ($5 + $30) = $35. */
const FIRST_PARTY_USD = 35;
const RAW = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };

/** One turn, one usage event — the shape both the tracer and the CLI price. */
class UsageAdapter implements Adapter {
	async *stream(_opts: StreamOptions): AsyncIterable<AdapterEvent> {
		yield { type: "text_delta", text: "ok", seq: 0 };
		yield { type: "usage", ...RAW, known: true, seq: 1 };
		yield { type: "stop", reason: "end_turn", seq: 2 };
	}
}

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

async function requestCosts(root: string, sessionId: string): Promise<(number | null)[]> {
	await nextImmediate();
	return readFileSync(join(root, "traces", `${sessionId}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { kind: string; canonical?: { costUsd: number | null } })
		.filter((l) => l.kind === "request")
		.map((l) => l.canonical!.costUsd);
}

const streamOptions: StreamOptions = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }], systemPrompt: "sys" };

describe("OR-1 — the endpoint decides the price the ledger and the status row carry", () => {
	it("the tracer prices by the endpoint it is handed: the subscription backend → null, the first-party API → the dated rate", async () => {
		const priceAt = async (endpoint: string): Promise<number | null> => {
			const root = mkdtempSync(join(tmpdir(), "kiso-or1-cost-"));
			const tracer = new RequestTracer({
				root,
				sessionId: "s",
				runId: "run-1",
				provider: "openai-responses",
				model: "gpt-5.5",
				endpoint,
				log: [{ seq: 1, type: "user_input", content: "hi" }],
			});
			tracer.init();
			for await (const _ev of tracer.wrap(streamOptions, new UsageAdapter().stream(streamOptions))) {
				// drain — the record settles at the stream's end
			}
			tracer.finishRun();
			const [cost] = await requestCosts(root, "s");
			return cost!;
		};
		expect(await priceAt(CHATGPT)).toBeNull();
		expect(await priceAt(FIRST_PARTY)).toBeCloseTo(FIRST_PARTY_USD, 9);
	});

	it("an agent bound to the ChatGPT backend writes a null cost; the same model at the first-party API writes the rate", async () => {
		const costFor = async (baseUrl: string): Promise<number | null> => {
			const dir = mkdtempSync(join(tmpdir(), "kiso-or1-agent-"));
			const agent = createAgent({
				model: "gpt-5.5",
				provider: "openai-responses",
				baseUrl,
				adapter: new UsageAdapter(),
				store: new SessionStore(dir),
				tools: [],
			});
			const session = await agent.session({ id: "s" });
			expect(session.baseUrl).toBe(baseUrl);
			for await (const _ev of session.run("hi")) {
				// drain
			}
			const [cost] = await requestCosts(dir, "s");
			return cost!;
		};
		expect(await costFor(CHATGPT)).toBeNull();
		expect(await costFor(FIRST_PARTY)).toBeCloseTo(FIRST_PARTY_USD, 9);
	});

	it("setModelBinding moves the endpoint WITH the adapter: a session that switches to the subscription prices its next run null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-or1-switch-"));
		const agent = createAgent({
			model: "gpt-5.5",
			provider: "openai-responses",
			baseUrl: FIRST_PARTY,
			adapter: new UsageAdapter(),
			store: new SessionStore(dir),
			tools: [],
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("first-party turn")) {
			// drain
		}
		session.setModelBinding({
			adapter: new UsageAdapter(),
			model: "gpt-5.5",
			provider: "openai-responses",
			baseUrl: CHATGPT,
			scope: { providerId: "chatgpt", apiId: "openai-responses", modelId: "gpt-5.5" },
		});
		expect(session.baseUrl).toBe(CHATGPT);
		for await (const _ev of session.run("subscription turn")) {
			// drain
		}
		const costs = await requestCosts(dir, "s");
		expect(costs).toHaveLength(2);
		expect(costs[0]).toBeCloseTo(FIRST_PARTY_USD, 9);
		expect(costs[1]).toBeNull();
	});
});
