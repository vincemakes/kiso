/**
 * The error label names the endpoint a request actually went to: a gateway
 * serving another vendor's model is named by its host, the model's vendor
 * beside it (a "[deepseek]" label on a gateway's refusal sent the person to
 * the wrong key). A refusal for spent credit says which key and where to
 * store a new one.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";

let server: Server;
let port = 0;
let answer: { status: number; message: string } = { status: 400, message: "You have insufficient credits. Please top up." };

beforeEach(async () => {
	server = createServer((req, res) => {
		req.resume();
		res.writeHead(answer.status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: answer.message, type: "invalid_request_error" } }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function failure(config: Parameters<typeof createOpenAICompatProvider>[0], model: string): Promise<string> {
	const adapter = createOpenAICompatProvider(config);
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model, registry: new ToolRegistry(), messages: [{ role: "user", content: "go" }], maxRetries: 0 })) out.push(ev);
	const term = out.find((e) => e.type === "terminal") as { outcome: { kind: string; error?: { message: string } } };
	expect(term.outcome.kind).toBe("error");
	return term.outcome.error?.message ?? "";
}

describe("the error label names the endpoint", () => {
	it("a gateway serving another vendor's model: its host, then the vendor; spent credit says where the new key goes", async () => {
		const message = await failure({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/provider/v1` }, "deepseek/deepseek-v4.1-flash");
		expect(message).toContain(`[127.0.0.1:${port} · deepseek] request failed: 400 You have insufficient credits`);
		expect(message).toContain(`the key for 127.0.0.1:${port} has no credit left: store a new one (kiso web: Settings; the terminal: \`kiso login --endpoint http://127.0.0.1:${port}\`)`);
	});

	it("a vendor's own endpoint keeps the vendor's label, and its login names the vendor", async () => {
		const message = await failure({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1`, scope: { providerId: "deepseek" } }, "deepseek-v4.1-flash");
		expect(message).toContain("[deepseek] request failed: 400 You have insufficient credits");
		expect(message).toContain("the deepseek key has no credit left: store a new one (kiso web: Settings; the terminal: `kiso login deepseek`)");
	});

	it("any other refusal carries no credit note", async () => {
		answer = { status: 400, message: "bad request: messages is empty" };
		const message = await failure({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` }, "deepseek/deepseek-v4.1-flash");
		expect(message).not.toContain("no credit left");
	});
});
