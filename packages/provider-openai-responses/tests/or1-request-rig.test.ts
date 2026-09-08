/**
 * OR-1 gate 1 — the request byte rig.
 *
 * The claim under test is "what this adapter puts on the wire", so the
 * assertion is over the RAW body string, not a parsed object: key order,
 * quoting and the absence of a field are all part of a request's identity
 * (the prefix cache reads bytes, not JSON). Four shapes are frozen — a
 * plain turn, a turn carrying tool results, a turn with a reasoning
 * level, and the ChatGPT target — plus the negative half of the fourth:
 * the ChatGPT-only headers and body fields are ABSENT on the first-party
 * target. The last case is the rig's own control: a different system
 * prompt must produce different bytes, or the rig is reading a fixture
 * instead of the wire.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, StreamOptions, ToolSpec } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { type Rig, sseReply, startRig } from "./helpers/rig.js";

/** The shortest script that lets the adapter reach its terminal event. */
const DONE = [
	{ type: "response.created", response: { id: "resp_rig" } },
	{ type: "response.completed", response: { id: "resp_rig", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
];

const PLAIN: Message[] = [{ role: "user", content: "go" }];

const TOOL_TURN: Message[] = [
	{ role: "user", content: "go" },
	{
		role: "assistant",
		blocks: [
			{ type: "text", text: "I will use the tool." },
			{ type: "tool_use", callId: "c1", name: "web_search", input: { q: "k" } },
		],
	},
	{ role: "tool", callId: "c1", content: "results", isError: false },
];

const TOOLS: ToolSpec[] = [
	{
		name: "web_search",
		description: "search the web",
		inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
	},
];

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply(DONE));
});
afterEach(async () => {
	await rig.close();
});

async function sendKey(options: Partial<StreamOptions>): Promise<void> {
	const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
	for await (const _ of adapter.stream({ model: "gpt-5.5", messages: PLAIN, ...options })) void _;
}

async function sendOauth(options: Partial<StreamOptions>, promptCacheKey?: string): Promise<void> {
	const adapter = createOpenAIResponsesProvider({
		oauth: async () => ({ access: "tok-abc", accountId: "acct-42" }),
		baseUrl: rig.baseUrl,
		...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
	});
	for await (const _ of adapter.stream({ model: "gpt-5.5", messages: PLAIN, ...options })) void _;
}

describe("OR-1 request rig — the frozen shapes", () => {
	it("shape 1: a plain turn on the first-party target", async () => {
		await sendKey({ systemPrompt: "sys" });
		expect(rig.requests).toHaveLength(1);
		const req = rig.requests[0]!;
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/responses");
		expect(req.headers.authorization).toBe("Bearer sk-rig");
		expect(req.body).toBe(
			'{"model":"gpt-5.5","stream":true,"instructions":"sys","input":[{"role":"user","content":[{"type":"input_text","text":"go"}]}]}',
		);
	});

	it("shape 2: a turn carrying a tool call and its result", async () => {
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		for await (const _ of adapter.stream({ model: "gpt-5.5", messages: TOOL_TURN, systemPrompt: "sys", tools: TOOLS })) void _;
		expect(rig.requests[0]!.body).toBe(
			'{"model":"gpt-5.5","stream":true,"instructions":"sys","input":[' +
				'{"role":"user","content":[{"type":"input_text","text":"go"}]},' +
				'{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will use the tool.","annotations":[]}],"status":"completed"},' +
				'{"type":"function_call","call_id":"c1","name":"web_search","arguments":"{\\"q\\":\\"k\\"}"},' +
				'{"type":"function_call_output","call_id":"c1","output":"results"}' +
				'],"tools":[{"type":"function","name":"web_search","description":"search the web","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}}]}',
		);
		// `strict` is not sent: the kernel's schemas are already closed
		// worlds (PH-1a.1) and the flag changes the provider's own
		// validation semantics — a claim this adapter does not make.
		expect(rig.requests[0]!.body).not.toContain('"strict"');
	});

	it("shape 3: a reasoning level and an output cap", async () => {
		await sendKey({ systemPrompt: "sys", reasoning: { effort: "high" }, maxTokens: 4096, temperature: 0.5 });
		expect(rig.requests[0]!.body).toBe(
			'{"model":"gpt-5.5","stream":true,"instructions":"sys","input":[{"role":"user","content":[{"type":"input_text","text":"go"}]}],' +
				'"reasoning":{"effort":"high"},"max_output_tokens":4096,"temperature":0.5}',
		);
	});

	it("shape 4: the ChatGPT target — path, headers, and the three body fields", async () => {
		await sendOauth({ systemPrompt: "sys" }, "sess-7");
		const req = rig.requests[0]!;
		expect(req.path).toBe("/codex/responses");
		expect(req.headers.authorization).toBe("Bearer tok-abc");
		expect(req.headers["chatgpt-account-id"]).toBe("acct-42");
		expect(req.headers.originator).toBe("kiso");
		expect(req.headers["openai-beta"]).toBe("responses=experimental");
		expect(req.headers.accept).toBe("text/event-stream");
		expect(req.body).toBe(
			'{"model":"gpt-5.5","stream":true,"instructions":"sys","input":[{"role":"user","content":[{"type":"input_text","text":"go"}]}],' +
				'"store":false,"include":["reasoning.encrypted_content"],"prompt_cache_key":"sess-7"}',
		);
	});

	it("the ChatGPT-only headers and body fields are ABSENT on the first-party target", async () => {
		await sendKey({ systemPrompt: "sys" });
		const req = rig.requests[0]!;
		expect(req.headers["chatgpt-account-id"]).toBeUndefined();
		expect(req.headers.originator).toBeUndefined();
		expect(req.headers["openai-beta"]).toBeUndefined();
		expect(req.body).not.toContain("store");
		expect(req.body).not.toContain("include");
		expect(req.body).not.toContain("prompt_cache_key");
	});

	it("no system prompt sends no instructions — a default prompt is never invented", async () => {
		await sendKey({});
		expect(rig.requests[0]!.body).not.toContain("instructions");
	});

	it("negative control: the rig reads the wire — a different system prompt is different bytes", async () => {
		await sendKey({ systemPrompt: "alpha" });
		await sendKey({ systemPrompt: "beta" });
		expect(rig.requests).toHaveLength(2);
		expect(rig.requests[0]!.body).toContain('"instructions":"alpha"');
		expect(rig.requests[1]!.body).toContain('"instructions":"beta"');
		expect(rig.requests[0]!.body).not.toBe(rig.requests[1]!.body);
	});

	it("max_output_tokens under the provider's floor is refused BEFORE the request, never clamped", async () => {
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		await expect(async () => {
			for await (const _ of adapter.stream({ model: "gpt-5.5", messages: PLAIN, maxTokens: 8 })) void _;
		}).rejects.toMatchObject({ code: "invalid_request", retryable: false });
		expect(rig.requests).toHaveLength(0);
	});
});
