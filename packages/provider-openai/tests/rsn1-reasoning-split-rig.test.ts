/**
 * RSN-1 — the thinking split comes off the wire, end to end.
 *
 * `canonical.reasoning` sat hardcoded null under a comment saying no
 * provider reports a split. That was true when written and had stopped
 * being true: the vendor reports `completion_tokens_details.reasoning_tokens`
 * in the SAME usage object we already read the cache figure out of.
 *
 * It is a SPLIT of the output, not a fifth quantity — completion tokens
 * have always included reasoning ones, so nothing was ever under-billed.
 * What was missing is which half the money went to, and that is the half
 * the effort knob moves.
 *
 * A rig, because the value has to survive FOUR hops — adapter, event,
 * guard, canonicalization — and a gate that stops at the first one would
 * pass while the trace still wrote null.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loop, ToolRegistry, type Event } from "@vincemakes/kiso-core";
import { createOpenAICompatProvider } from "../src/index.js";
import { seedLog } from "@vincemakes/kiso-runtime";

let server: Server;
let port = 0;
/** what the server puts in completion_tokens_details; null = the key absent */
let reports: number | null = 41;

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeEach(async () => {
	reports = 41;
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
					prompt_tokens: 10,
					completion_tokens: 76,
					prompt_tokens_details: { cached_tokens: 2 },
					...(reports === null ? {} : { completion_tokens_details: { reasoning_tokens: reports } }),
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

async function usageEvent(): Promise<{ reasoningTokens?: number; outputTokens: number | null } | undefined> {
	const adapter = createOpenAICompatProvider({ apiKey: "rig", baseUrl: `http://127.0.0.1:${port}/v1` });
	const out: Event[] = [];
	for await (const ev of loop({ adapter, model: "m", registry: new ToolRegistry(), log: seedLog([{ role: "user", content: "go" }]), maxRetries: 0 })) {
		out.push(ev);
	}
	return out.find((e) => e.type === "usage") as { reasoningTokens?: number; outputTokens: number | null } | undefined;
}

describe("RSN-1 rig — the reported split reaches the event", () => {
	it("a reported split rides the usage event, and it is PART of the output", async () => {
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.reasoningTokens, "the completion side of the object was never read").toBe(41);
		expect(u.outputTokens, "the split is inside the output, not added to it").toBe(76);
		expect(u.reasoningTokens!).toBeLessThan(u.outputTokens!);
	});

	it("no split reported leaves the field ABSENT — never a measured zero", async () => {
		reports = null;
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect("reasoningTokens" in u, "a provider that reports no split has not measured zero thinking").toBe(false);
	});

	it("a REPORTED zero is kept — that provider measured no thinking", async () => {
		reports = 0;
		const u = await usageEvent();
		if (u === undefined) throw new Error("no usage event reached the kernel");
		expect(u.reasoningTokens).toBe(0);
	});
});
