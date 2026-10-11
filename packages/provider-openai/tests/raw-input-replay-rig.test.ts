/**
 * 0.43.0 (#13) — history replay sends the CANONICAL argument text (0430-B1).
 *
 * A tool_use block's `rawInput` is for the tool and the host; the adapter
 * replays `JSON.stringify(input)` whether or not the block carries it. The
 * raw replay was tried for 0.43.0 and withdrawn before the release: it
 * changed every call's bytes and the paired bench read more requests on
 * that arm (finding 0430-B1). These tests pin the withdrawal.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event, type Message } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";
import { seedLog } from "@vincemakes/kiso-runtime";

let server: Server;
let port = 0;
let bodies: Record<string, unknown>[] = [];
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeEach(async () => {
	bodies = [];
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c: Buffer) => (raw += c.toString()));
		req.on("end", () => {
			bodies.push(JSON.parse(raw) as Record<string, unknown>);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
			res.write(sse({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
			res.write(sse({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function replay(history: Message[]): Promise<string> {
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "m", registry: new ToolRegistry(), log: seedLog(history), maxRetries: 0 })) out.push(ev);
	const msgs = bodies[0]!["messages"] as { role: string; tool_calls?: { function: { arguments: string } }[] }[];
	return msgs.find((m) => m.role === "assistant")!.tool_calls![0]!.function.arguments;
}

describe("0430-B1 rig — the chat adapter replays the canonical arguments", () => {
	it("a block WITH rawInput is still replayed as the canonical text — the raw form stays with the tool and the host", async () => {
		const args = await replay([
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "probe", input: { x: 5 }, rawInput: '{ "x": 5.0 }' }] },
			{ role: "tool", callId: "c1", content: "ok", isError: false },
			{ role: "user", content: "and?" },
		] as Message[]);
		expect(args).toBe('{"x":5}'); // 0430-B1: canonical, not the raw text
	});

	it("a block without rawInput falls back to the stringified parsed input", async () => {
		const args = await replay([
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "probe", input: { x: 5 } }] },
			{ role: "tool", callId: "c1", content: "ok", isError: false },
			{ role: "user", content: "and?" },
		] as Message[]);
		expect(args).toBe('{"x":5}');
	});
});
