/**
 * TRACE-F1 — the adapter reads the id the SERVER states, not the one we
 * asked for.
 *
 * This is the gate that would have caught the alias. The bench asked for
 * `deepseek-v4-flash` for four days; the server answered as
 * `deepseek-flash` in every chunk it sent, and the adapter never looked.
 * A rig that serves a DIFFERENT id than the request is the only shape that
 * discriminates: a rig echoing the requested id back would pass on an
 * adapter that simply copies `options.model`, which is the defect.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";
import { seedLog } from "@vincemakes/kiso-runtime";

const REQUESTED = "deepseek-v4-flash";
const SERVED = "deepseek-flash";

let server: Server;
let port = 0;
/** what the server puts in each chunk's `model`; null = the field is absent */
let serves: string | null = SERVED;

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeEach(async () => {
	serves = SERVED;
	server = createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream" });
		const model = serves === null ? {} : { model: serves };
		res.write(sse({ id: "c1", object: "chat.completion.chunk", ...model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
		res.write(sse({ id: "c1", object: "chat.completion.chunk", ...model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		res.write(sse({ id: "c1", object: "chat.completion.chunk", ...model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function usageEvent(): Promise<{ servedModel?: string } | undefined> {
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: REQUESTED, registry: new ToolRegistry(), log: seedLog([{ role: "user", content: "go" }]), maxRetries: 0 })) {
		out.push(ev);
	}
	return out.find((e) => e.type === "usage") as { servedModel?: string } | undefined;
}

describe("TRACE-F1 rig (openai-compat) — the served id comes off the wire", () => {
	it("the server serving a DIFFERENT id than the request puts ITS id on the usage event", async () => {
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.servedModel, "the adapter reported the id it asked for, not the one it was given").toBe(SERVED);
		expect(u.servedModel).not.toBe(REQUESTED);
	});

	it("a server that states NO model leaves the field absent — never filled with the request", async () => {
		serves = null;
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect("servedModel" in u, "absent means the server said nothing; the requested id is not a substitute").toBe(false);
	});
});
