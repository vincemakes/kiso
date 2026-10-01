/**
 * One request, one usage event.
 *
 * A compat channel may report usage more than once in one stream: one
 * sends two identical usage chunks after finish_reason; others put the
 * cumulative usage on every chunk. The adapter yielded one usage event
 * per such chunk, so a host that adds usage events up billed one request
 * two or three times. Usage on this dialect is cumulative, so the stream's
 * LAST report is the request's; the adapter now emits exactly that one,
 * once, before the stop.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEvent } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (extra: Record<string, unknown>): string => sse({ id: "c", object: "chat.completion.chunk", model: "m", ...extra });
const USAGE = { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 30 } };

let server: Server | undefined;
afterEach(async () => {
	if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
	server = undefined;
});

async function streamOf(body: string[], opts: { keepError?: { error?: unknown } } = {}): Promise<AdapterEvent[]> {
	server = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const b of body) res.write(b);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: AdapterEvent[] = [];
	try {
		for await (const ev of adapter.stream({ model: "m", messages: [{ role: "user", content: "go" }] })) out.push(ev);
	} catch (err) {
		if (opts.keepError === undefined) throw err;
		opts.keepError.error = err;
	}
	return out;
}

const usages = (events: AdapterEvent[]) => events.filter((e): e is AdapterEvent & { type: "usage" } => e.type === "usage");

describe("one request, one usage event", () => {
	it("two identical usage chunks after finish_reason yield ONE usage event", async () => {
		const events = await streamOf([
			chunk({ choices: [{ index: 0, delta: { content: "ok" } }] }),
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			chunk({ choices: [], usage: USAGE }),
			chunk({ choices: [], usage: USAGE }),
		]);
		const u = usages(events);
		expect(u).toHaveLength(1);
		expect(u[0]).toMatchObject({ inputTokens: 100, outputTokens: 7, cacheRead: 30, known: true });
	});

	it("cumulative usage on every chunk yields ONE usage event, carrying the last report", async () => {
		const events = await streamOf([
			chunk({ choices: [{ index: 0, delta: { content: "o" } }], usage: { ...USAGE, completion_tokens: 1 } }),
			chunk({ choices: [{ index: 0, delta: { content: "k" } }], usage: { ...USAGE, completion_tokens: 2 } }),
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE }),
		]);
		const u = usages(events);
		expect(u).toHaveLength(1);
		expect(u[0]).toMatchObject({ inputTokens: 100, outputTokens: 7, known: true });
	});

	it("the one usage still precedes the stop", async () => {
		const events = await streamOf([
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			chunk({ choices: [], usage: USAGE }),
			chunk({ choices: [], usage: USAGE }),
		]);
		const types = events.map((e) => e.type);
		expect(types.indexOf("usage")).toBeGreaterThanOrEqual(0);
		expect(types.indexOf("usage")).toBeLessThan(types.indexOf("stop"));
		expect(types.filter((t) => t === "stop")).toHaveLength(1);
	});

	it("a stream cut off with no finish_reason still reports the usage it carried, once, before the failure", async () => {
		const caught: { error?: unknown } = {};
		const events = await streamOf(
			[
				chunk({ choices: [{ index: 0, delta: { content: "o" } }], usage: { ...USAGE, completion_tokens: 1 } }),
				chunk({ choices: [{ index: 0, delta: { content: "k" } }], usage: { ...USAGE, completion_tokens: 2 } }),
			],
			{ keepError: caught },
		);
		expect(caught.error, "a truncated stream is still a failure").toBeDefined();
		const u = usages(events);
		expect(u).toHaveLength(1);
		expect(u[0]).toMatchObject({ inputTokens: 100, outputTokens: 2, known: true });
		expect(events.some((e) => e.type === "tool_call_end" || e.type === "stop")).toBe(false);
	});
});
