/**
 * CX-1 F8 — the differential rig, anthropic: the same local 429 endpoint
 * against the REAL Anthropic SDK client. See the openai-compat rig.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createAnthropicProvider } from "../src/index.js";

let server: Server;
let port = 0;
let hits: number[] = [];

beforeEach(async () => {
	hits = [];
	server = createServer((req, res) => {
		hits.push(Date.now());
		req.resume();
		res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
		res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function drive(maxRetries: number): Promise<Event[]> {
	const adapter = createAnthropicProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "rig-model", registry: new ToolRegistry(), messages: [{ role: "user", content: "go" }], maxRetries })) out.push(ev);
	return out;
}

describe("CX-1 F8 rig (anthropic) — the request count is the kernel's, not the SDK's", () => {
	it("maxRetries = 0 → exactly ONE request", async () => {
		const events = await drive(0);
		expect(hits).toHaveLength(1);
		const term = events.find((e) => e.type === "terminal") as { outcome: { kind: string } };
		expect(term.outcome.kind).toBe("error");
	});

	it("maxRetries = 2 → three requests, the first gap honoring Retry-After: 1", async () => {
		await drive(2);
		expect(hits).toHaveLength(3);
		expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(950);
	});
});
