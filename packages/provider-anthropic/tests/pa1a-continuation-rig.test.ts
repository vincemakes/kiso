/**
 * PA-1a (D4) — the continuation rig: what the REAL Anthropic SDK client
 * puts on the wire for a kiso continuation turn, captured by a local
 * HTTP endpoint that speaks just enough SSE for the adapter to finish.
 *
 * MG1-F1 is the claim "the signed blocks sent back verbatim satisfy the
 * real API"; that half needs a credential and stays Track P. This half
 * needs none: the bytes the client SENDS are asserted here — the stored
 * thinking / redacted_thinking blocks first and verbatim, then text and
 * tool_use; output_config.effort and thinking as resolved; cache_control
 * absent by default and at exactly two places when on. A negative
 * control (a different system prompt changes the body) proves the rig
 * reads real bytes rather than a fixture.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Continuation, Message, StreamOptions } from "@vincemakes/kiso-core";
import { createAnthropicProvider } from "../src/index.js";

const THINKING_BLOCK = { type: "thinking", thinking: "let me reason", signature: "sig-abc123" };
const REDACTED_BLOCK = { type: "redacted_thinking", data: "opaque-redacted-bytes" };
function envelope(modelId: string): Continuation {
	return {
		scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId },
		entries: [
			{ kind: "anthropic.content_block", required: true, data: JSON.stringify(THINKING_BLOCK) },
			{ kind: "anthropic.content_block", required: true, data: JSON.stringify(REDACTED_BLOCK) },
		],
	};
}
const MESSAGES: Message[] = [
	{ role: "user", content: "go" },
	{
		role: "assistant",
		blocks: [
			{ type: "text", text: "I will use the tool." },
			{ type: "tool_use", callId: "c1", name: "web_search", input: { q: "k" } },
		],
		reasoning: "let me reason",
		continuation: envelope("claude-opus-5"),
	},
	{ role: "tool", callId: "c1", content: "results", isError: false },
];

const SSE = [
	{ type: "message_start", message: { id: "msg_rig", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

let server: Server;
let port = 0;
let bodies: Record<string, unknown>[] = [];
let headers: Record<string, string | string[] | undefined>[] = [];
beforeEach(async () => {
	bodies = [];
	headers = [];
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => {
			raw += String(d);
		});
		req.on("end", () => {
			bodies.push(JSON.parse(raw) as Record<string, unknown>);
			headers.push(req.headers);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			for (const ev of SSE) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function send(opts: Partial<StreamOptions> & { promptCaching?: boolean }): Promise<Record<string, unknown>> {
	const { promptCaching, ...rest } = opts;
	const adapter = createAnthropicProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}`, ...(promptCaching !== undefined ? { promptCaching } : {}) });
	const events: unknown[] = [];
	for await (const ev of adapter.stream({ model: "claude-opus-5", messages: MESSAGES, ...rest })) events.push(ev);
	expect(events.some((e) => (e as { type: string }).type === "stop")).toBe(true); // the adapter finished on the rig's stream
	return bodies[bodies.length - 1]!;
}

describe("PA-1a rig — the bytes the real SDK client sends for a continuation turn", () => {
	it("stored blocks first and verbatim, then text and tool_use; effort and thinking as resolved; the auth and version headers present", async () => {
		const body = await send({ systemPrompt: "sys", reasoning: { thinking: "adaptive", effort: "high" } });
		expect(bodies).toHaveLength(1);
		expect(headers[0]!["x-api-key"]).toBe("rig");
		expect(headers[0]!["anthropic-version"]).toBeDefined();
		const messages = body.messages as { role: string; content: unknown }[];
		const assistant = messages.find((m) => m.role === "assistant")!;
		const content = assistant.content as Record<string, unknown>[];
		expect(content[0]).toEqual(THINKING_BLOCK);
		expect(content[1]).toEqual(REDACTED_BLOCK);
		expect(content[2]?.type).toBe("text");
		expect(content[3]).toMatchObject({ type: "tool_use", id: "c1", name: "web_search", input: { q: "k" } });
		expect(body.output_config).toEqual({ effort: "high" });
		expect(body.thinking).toEqual({ type: "adaptive" });
		expect(body.system).toBe("sys");
		expect(body.model).toBe("claude-opus-5");
		expect(body.stream).toBe(true);
	});

	it("cache_control: absent by default; with promptCaching on, exactly two — the system block and the last message's last block", async () => {
		const off = await send({ systemPrompt: "sys" });
		expect(JSON.stringify(off)).not.toContain("cache_control");
		const on = await send({ systemPrompt: "sys", promptCaching: true });
		expect((JSON.stringify(on).match(/"cache_control"/g) ?? []).length).toBe(2);
		const system = on.system as { type: string; text: string; cache_control?: unknown }[];
		expect(system[0]).toMatchObject({ type: "text", text: "sys", cache_control: { type: "ephemeral" } });
		const messages = on.messages as { content: Record<string, unknown>[] }[];
		const lastBlocks = messages[messages.length - 1]!.content;
		expect(lastBlocks[lastBlocks.length - 1]).toMatchObject({ cache_control: { type: "ephemeral" } });
	});

	it("negative control: the rig reads the bytes — a different system prompt changes the body, and a model switch withholds the blocks", async () => {
		const a = await send({ systemPrompt: "alpha" });
		const b = await send({ systemPrompt: "beta" });
		expect(a.system).toBe("alpha");
		expect(b.system).toBe("beta");
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
		// MG-1 C: a model-only switch on the same provider withholds the stored blocks
		const switched = await send({ model: "claude-sonnet-5" } as Partial<StreamOptions>);
		expect(JSON.stringify(switched)).not.toContain("sig-abc123");
	});
});
