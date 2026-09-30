/**
 * ADR-0058 (3c) contract — a task notice (the runtime's input) and a
 * person's steer can land at one admission site as two user-role messages
 * in a row. This pins what the adapter sends: both, in arrival order, each
 * its own message, neither dropped nor merged on the wire. The dialect: input items may hold consecutive user messages; each stays its own item.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Message } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";

const NOTICE = '<kiso-task id="t1" status="exited" code="0"/>\nRuntime notice — not the user.';
const HISTORY: Message[] = [
	{ role: "user", content: "go" },
	{ role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "work", input: {} }] },
	{ role: "tool", callId: "c1", content: "worked", isError: false },
	{ role: "user", content: NOTICE, source: "system" },
	{ role: "user", content: "only the editor tests" },
];

let server: Server;
let port = 0;
let body: Record<string, unknown> | null = null;
beforeEach(async () => {
	body = null;
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d: Buffer) => (raw += d.toString()));
		req.on("end", () => {
			body = JSON.parse(raw) as Record<string, unknown>;
			res.writeHead(400, { "content-type": "application/json" });
			res.end("{}"); // the request is the evidence; the reply only ends the call
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

it("a notice then a steer go out as two user messages, in that order, after the tool's result", async () => {
	const adapter = createOpenAIResponsesProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	try {
		for await (const _ of adapter.stream({ model: "m", messages: HISTORY })) void _;
	} catch {
		// the rig answers 400: only the request matters here
	}
	const list = ((body as Record<string, unknown> | null)?.input ?? []) as { role?: string; content?: unknown }[];
	const users = list.filter((m) => m.role === "user");
	const text = (m: { content?: unknown }): string =>
		typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((c) => c.text ?? "").join("");
	expect(users.slice(-2).map(text)).toEqual([NOTICE, "only the editor tests"]);
	expect(list.at(-1)!.role).toBe("user");
	expect(list.at(-2)!.role).toBe("user");
});
