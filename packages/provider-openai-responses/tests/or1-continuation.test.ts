/**
 * OR-1 gate 5 — the continuation under `store: false`.
 *
 * The ChatGPT backend stores nothing, so the reasoning items it produced
 * have to travel back on the NEXT request or the model resumes a turn it
 * cannot see the reasoning of. kiso already has the mechanism for exactly
 * this (MG-1 / ADR-0051 Amendment 5): the adapter emits opaque
 * `stop.continuation` entries, the kernel stamps the scope, and the
 * scope-matched adapter replays them verbatim.
 *
 * Two halves, and the second is the one that matters: replay happens ONLY
 * on a scope match. A reasoning item from another model (or another
 * provider identity, or another dialect) is withheld — it is signed
 * against the binding that produced it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterEvent, Continuation, Message } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { type Rig, sseReply, startRig } from "./helpers/rig.js";

const REASONING_ITEM = { type: "reasoning", id: "rs_7", summary: [], encrypted_content: "ENCRYPTED-PAYLOAD-7" };
const BARE_REASONING_ITEM = { type: "reasoning", id: "rs_8", summary: [] };

function script(items: readonly unknown[]): unknown[] {
	return [
		...items.flatMap((item, i) => [
			{ type: "response.output_item.added", output_index: i, item: { type: "reasoning", id: (item as { id: string }).id, summary: [] } },
			{ type: "response.reasoning_text.delta", output_index: i, delta: "thinking" },
			{ type: "response.output_item.done", output_index: i, item },
		]),
		{ type: "response.completed", response: { id: "resp", status: "completed", output: items, usage: { input_tokens: 1, output_tokens: 1 } } },
	];
}

const OAUTH = { oauth: async () => ({ access: "tok", accountId: "acct" }) };

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply(script([REASONING_ITEM])));
});
afterEach(async () => {
	await rig.close();
});

async function run(messages: Message[]): Promise<AdapterEvent[]> {
	const adapter = createOpenAIResponsesProvider({ ...OAUTH, baseUrl: rig.baseUrl });
	const out: AdapterEvent[] = [];
	for await (const ev of adapter.stream({ model: "gpt-5.5", messages })) out.push(ev);
	return out;
}

describe("OR-1 continuation — the reasoning item comes back", () => {
	it("the stop carries one entry per reasoning item, serialized verbatim and marked required", async () => {
		const events = await run([{ role: "user", content: "go" }]);
		const stop = events[events.length - 1] as { continuation?: Continuation };
		expect(stop.continuation).toBeDefined();
		expect(stop.continuation!.scope).toEqual({ providerId: "chatgpt", apiId: "openai-responses", modelId: "gpt-5.5" });
		expect(stop.continuation!.entries).toHaveLength(1);
		const entry = stop.continuation!.entries[0]!;
		expect(entry.kind).toBe("openai-responses.item");
		// `required`: under store:false the next request is INVALID without
		// it — the encrypted payload IS the model's state.
		expect(entry.required).toBe(true);
		expect(JSON.parse(entry.data)).toEqual(REASONING_ITEM);
	});

	it("a reasoning item with NO encrypted content produces no entry — there is nothing to replay", async () => {
		rig.reply = sseReply(script([BARE_REASONING_ITEM]));
		const events = await run([{ role: "user", content: "go" }]);
		const stop = events[events.length - 1] as { continuation?: Continuation };
		expect(stop.continuation).toBeUndefined();
	});

	it("the next turn's input replays the item BEFORE the assistant's own blocks", async () => {
		const first = await run([{ role: "user", content: "go" }]);
		const continuation = (first[first.length - 1] as { continuation?: Continuation }).continuation!;
		rig.reply = sseReply(script([]));
		await run([
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "done" }], reasoning: "thinking", continuation },
		]);
		const input = JSON.parse(rig.requests[1]!.body).input as Record<string, unknown>[];
		expect(input[1]).toEqual(REASONING_ITEM);
		expect(input[2]).toMatchObject({ type: "message", role: "assistant" });
	});

	it("a scope change withholds it: another model, another dialect, another provider identity", async () => {
		const first = await run([{ role: "user", content: "go" }]);
		const c = (first[first.length - 1] as { continuation?: Continuation }).continuation!;
		const withScope = (scope: Continuation["scope"]): Message[] => [
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "done" }], continuation: { ...c, scope } },
		];
		rig.reply = sseReply(script([]));
		await run(withScope({ providerId: "chatgpt", apiId: "openai-responses", modelId: "gpt-5.4" }));
		await run(withScope({ providerId: "openai", apiId: "openai-responses", modelId: "gpt-5.5" }));
		await run(withScope({ providerId: "chatgpt", apiId: "openai-chat", modelId: "gpt-5.5" }));
		for (const req of rig.requests.slice(1)) {
			expect(req.body).not.toContain("ENCRYPTED-PAYLOAD-7");
		}
		// …and the matching scope still replays, so the three misses above
		// are the scope check and not a broken replay path.
		await run(withScope(c.scope));
		expect(rig.requests[4]!.body).toContain("ENCRYPTED-PAYLOAD-7");
	});

	it("an injected scope OVERRIDES the target's own identity — the runtime's stamping identity is the one that matters", async () => {
		// The runtime resolves the scope from the binding and hands it in;
		// the adapter must stamp and match with THAT, not with the endpoint
		// it happens to be calling. Without this, an identity the two sides
		// disagree on (an API key configured against the ChatGPT origin)
		// would silently never replay its reasoning.
		const adapter = createOpenAIResponsesProvider({ ...OAUTH, baseUrl: rig.baseUrl, scope: { providerId: "openai" } });
		const events: AdapterEvent[] = [];
		for await (const ev of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }] })) events.push(ev);
		const stop = events[events.length - 1] as { continuation?: Continuation };
		expect(stop.continuation!.scope.providerId).toBe("openai");
	});

	it("an entry whose bytes no longer parse is skipped, never a crashed request", async () => {
		rig.reply = sseReply(script([]));
		const broken: Continuation = {
			scope: { providerId: "chatgpt", apiId: "openai-responses", modelId: "gpt-5.5" },
			entries: [{ kind: "openai-responses.item", required: true, data: "{not json" }],
		};
		await run([
			{ role: "user", content: "go" },
			{ role: "assistant", blocks: [{ type: "text", text: "done" }], continuation: broken },
		]);
		expect(rig.requests).toHaveLength(1);
		expect(rig.requests[0]!.body).not.toContain("not json");
	});
});
