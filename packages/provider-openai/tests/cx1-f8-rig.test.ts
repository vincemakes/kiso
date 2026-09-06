/**
 * CX-1 F8 — the differential rig, openai-compat: a local HTTP endpoint
 * that answers 429 + Retry-After counts the requests the REAL SDK client
 * makes. With one retry authority (the kernel), the kernel's maxRetries
 * IS the request count minus one — the SDK's implicit two retries are
 * off (audit F8 measured three requests at maxRetries = 0).
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";

let server: Server;
let port = 0;
let hits: number[] = [];

beforeEach(async () => {
	hits = [];
	server = createServer((req, res) => {
		hits.push(Date.now());
		req.resume();
		res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
		res.end(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

async function drive(maxRetries: number): Promise<Event[]> {
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "rig-model", registry: new ToolRegistry(), messages: [{ role: "user", content: "go" }], maxRetries })) out.push(ev);
	return out;
}

describe("CX-1 F8 rig (openai-compat) — the request count is the kernel's, not the SDK's", () => {
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
