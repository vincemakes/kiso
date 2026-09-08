/**
 * OR-1 gate 6 — the kernel is the sole retry authority (CX-1 F8).
 *
 * The failure this guards is invisible from inside: an adapter that
 * retries once on its own turns the kernel's "3 attempts" budget into six
 * requests, spends money outside the trace, and makes a rate limit last
 * longer than it had to. The gate counts REQUESTS at the rig for every
 * class an implementation is tempted to retry — 429, 503, and a
 * connection that dies mid-stream — and the answer is one, each time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { cutReply, errorReply, type Rig, sseReply, startRig } from "./helpers/rig.js";

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply([]));
});
afterEach(async () => {
	await rig.close();
});

async function attempt(): Promise<void> {
	const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
	for await (const _ of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }] })) void _;
}

describe("OR-1 retry authority — exactly one request per stream", () => {
	it("a 429 makes ONE request", async () => {
		rig.reply = errorReply(429, '{"error":{"message":"slow down"}}', { "retry-after": "1" });
		await attempt().catch(() => {});
		expect(rig.requests).toHaveLength(1);
	});

	it("a 503 makes ONE request", async () => {
		rig.reply = errorReply(503, "down");
		await attempt().catch(() => {});
		expect(rig.requests).toHaveLength(1);
	});

	it("a connection that dies mid-stream makes ONE request", async () => {
		rig.reply = cutReply([{ type: "response.created", response: { id: "r" } }], 1);
		await attempt().catch(() => {});
		expect(rig.requests).toHaveLength(1);
	});

	it("a successful turn makes ONE request", async () => {
		rig.reply = sseReply([{ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: null } }]);
		await attempt();
		expect(rig.requests).toHaveLength(1);
	});
});
