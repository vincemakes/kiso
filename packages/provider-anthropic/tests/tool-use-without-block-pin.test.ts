/**
 * #20 (pin only) — stop_reason "tool_use" with text and ZERO tool_use blocks.
 *
 * The OpenAI-compat adapter now ends such a turn as `end_turn` (#20). This
 * adapter has no reproducer of the shape on the wire, so its behaviour is
 * NOT changed; this fixture records what it does today — the stop says
 * `tool_use` and no call is emitted — so that a future change to it is a
 * deliberate one, made with a real reproducer, and this test moves with it.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEvent } from "@vincemakes/kiso-core";
import { createAnthropicProvider } from "../src/index.js";

const SSE = [
	{ type: "message_start", message: { id: "msg_pin", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer is 42." } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
];

let server: Server | undefined;
afterEach(async () => {
	if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
	server = undefined;
});

describe("#20 pin — the Anthropic adapter on tool_use with text and no tool block", () => {
	it("keeps stop tool_use and emits no call (unchanged; a change here needs a real reproducer)", async () => {
		server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				for (const ev of SSE) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
				res.end();
			});
		});
		await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const adapter = createAnthropicProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}` });
		const events: AdapterEvent[] = [];
		for await (const ev of adapter.stream({ model: "claude-opus-5", messages: [{ role: "user", content: "go" }] })) events.push(ev);
		expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("The answer is 42.");
		expect(events.some((e) => e.type === "tool_call_start" || e.type === "tool_call_end")).toBe(false);
		expect(events.filter((e) => e.type === "stop").map((e) => (e as { reason: string }).reason)).toEqual(["tool_use"]);
	});
});
