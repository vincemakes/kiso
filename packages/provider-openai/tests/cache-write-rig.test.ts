/**
 * 0.42.2 (the products' request #17) — the cache WRITE reaches the event.
 *
 * The adapter had `cacheWrite: null` hardcoded under a comment saying the
 * vendor reports no cache write — true of the first-party API, false of a
 * gateway on the same route, which puts `cache_write_tokens` beside
 * `cached_tokens` in `prompt_tokens_details`. Read when present; an absent
 * value stays null (never a measured zero). The first test is RED on the
 * hardcoded null.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";
import { seedLog } from "@vincemakes/kiso-runtime";

let server: Server;
let port = 0;
/** what the server puts in prompt_tokens_details.cache_write_tokens; null = the key absent */
let writes: number | null = 20;

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeEach(async () => {
	writes = 20;
	server = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(sse({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
		res.write(sse({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		res.write(
			sse({
				id: "c1",
				object: "chat.completion.chunk",
				model: "m",
				choices: [],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 7,
					prompt_tokens_details: { cached_tokens: 30, ...(writes === null ? {} : { cache_write_tokens: writes }) },
				},
			}),
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function usageEvent(): Promise<(Event & { type: "usage" }) | undefined> {
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "m", registry: new ToolRegistry(), log: seedLog([{ role: "user", content: "go" }]), maxRetries: 0 })) out.push(ev);
	return out.find((e) => e.type === "usage") as (Event & { type: "usage" }) | undefined;
}

describe("#17 rig — the cache write reaches the usage event", () => {
	it("a reported cache_write_tokens rides the event as cacheWrite; inputTokens stays the raw prompt count", async () => {
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.cacheWrite, "the write was hardcoded null").toBe(20);
		expect(u.cacheRead).toBe(30);
		expect(u.inputTokens, "the raw count is the provider's; the accounting boundary subtracts").toBe(100);
	});

	it("no cache_write_tokens leaves cacheWrite null — never a measured zero", async () => {
		writes = null;
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.cacheWrite).toBeNull();
		expect(u.cacheRead).toBe(30);
	});

	it("a REPORTED zero is kept — that gateway measured no write", async () => {
		writes = 0;
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.cacheWrite).toBe(0);
	});
});
