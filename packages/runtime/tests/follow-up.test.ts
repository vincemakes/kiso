/**
 * The follow-up (the web app's next-message suggestion, owner 2026-11-03): the last run's request sent again, byte for
 * byte, with messages appended. Its value rests on the prefix being the run's own (a caching route then reads nearly all
 * of it from the cache), so the first test compares the two requests the provider adapter received. Like a side query it
 * writes nothing durable and is marked in the trace; with no request to repeat, or another model bound, it sends nothing.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { FOLLOW_UP_ASK } from "../src/session.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const ADD = defineTool({
	name: "add",
	description: "add two numbers",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: "3", isError: false as const }),
});
const ASK = "Write the line the person may send next.";

async function fixture(script: unknown[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fu-")));
	const faux = createFauxProvider(script as never);
	const seen: StreamOptions[] = [];
	const adapter: Adapter = { stream: (options) => (seen.push(options), faux.stream(options)) };
	const agent = createAgent({ model: "m", store, systemPrompt: "you are a test", tools: [ADD], adapter });
	const session = await agent.session({ id: "fu" });
	return { store, session, seen, faux };
}

const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run);
};

describe("followUp", () => {
	it("sends the last run's request again, byte for byte, with the messages appended", async () => {
		const { session, seen } = await fixture([say("First answer."), say("fix the sub bug")]);
		await drain(session.run("look at calc.js"));
		const line = await session.followUp({ ask: ASK, maxTokens: 200 });
		expect(line).toBe("fix the sub bug");
		expect(seen).toHaveLength(2);
		const [run, follow] = seen as [StreamOptions, StreamOptions];
		const { signal: _a, messages: runMessages, ...runRest } = run;
		const { signal: _b, messages, maxTokens, ...followRest } = follow;
		expect(followRest, "the system prompt, the tools, the model and the reasoning are the run's own").toEqual(runRest);
		expect(JSON.stringify(messages.slice(0, runMessages.length)), "the run's messages, byte for byte").toBe(JSON.stringify(runMessages));
		expect(messages.slice(runMessages.length), "then the run's last reply and the ask").toEqual([
			{ role: "assistant", blocks: [{ type: "text", text: "First answer." }] },
			{ role: "user", content: ASK },
		]);
		expect(maxTokens).toBe(200);
		expect(followRest.tools?.map((t) => t.name), "the tools stay: they are part of the prefix").toEqual(["add"]);
	});

	it("after a run that called a tool: the prefix is the last request's, then the final reply", async () => {
		const call = { events: [{ type: "tool_call_end", callId: "c1", name: "add", input: {} }, { type: "stop", reason: "tool_use" }] };
		const { session, seen } = await fixture([call, say("It is 3."), say("add two more")]);
		await drain(session.run("add them"));
		expect(await session.followUp({ ask: ASK })).toBe("add two more");
		expect(seen).toHaveLength(3);
		const last = seen[1]!.messages;
		const follow = seen[2]!.messages;
		expect(last.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
		expect(JSON.stringify(follow.slice(0, last.length))).toBe(JSON.stringify(last));
		expect(follow.slice(last.length)).toEqual([{ role: "assistant", blocks: [{ type: "text", text: "It is 3." }] }, { role: "user", content: ASK }]);
	});

	it("with no ask: the built-in one, and the answer comes back as one clean line", async () => {
		const { session, seen } = await fixture([say("First answer."), say('  "fix it"\nand more')]);
		await drain(session.run("look at calc.js"));
		expect(await session.followUp({})).toBe("fix it");
		expect(seen[1]!.messages.at(-1)).toEqual({ role: "user", content: FOLLOW_UP_ASK });
	});

	it("writes nothing durable and is marked in the trace", async () => {
		const { store, session } = await fixture([say("First answer."), say("next")]);
		await drain(session.run("hello"));
		const before = readFileSync(join(store.root, "fu.jsonl"), "utf8");
		expect(await session.followUp({ ask: ASK })).toBe("next");
		expect(readFileSync(join(store.root, "fu.jsonl"), "utf8")).toBe(before);
		// the ledger is appended as the request settles: read it once both lines are there
		const purposes = (): (string | null)[] => readFileSync(join(store.root, "traces", "fu.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "request").map((r) => r.purpose ?? null);
		await expect.poll(purposes, { timeout: 2000 }).toEqual([null, "follow-up"]);
	});

	it("sends nothing before any run, and nothing for a prefix of another model", async () => {
		const { session, seen, faux } = await fixture([say("First answer.")]);
		expect(await session.followUp({ ask: ASK })).toBe("");
		expect(seen).toHaveLength(0);
		await drain(session.run("hello"));
		session.setModelBinding({ adapter: faux, model: "other" });
		expect(await session.followUp({ ask: ASK })).toBe("");
		expect(seen).toHaveLength(1);
	});
});

describe("followUp's built-in line asks for no thinking where it can (every model still answers)", () => {
	async function bound(model: string, provider?: "anthropic" | "openai-compat", script: unknown[] = [say("First answer."), say("next")]) {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fu-")));
		const faux = createFauxProvider(script as never);
		const seen: StreamOptions[] = [];
		const adapter: Adapter = { stream: (options) => (seen.push(options), faux.stream(options)) };
		const agent = createAgent({ model, store, systemPrompt: "you are a test", tools: [ADD], adapter, ...(provider !== undefined ? { provider } : {}) });
		const session = await agent.session({ id: "fu" });
		await drain(session.run("hello"));
		return { session, seen };
	}

	it("a model the table can quiet: thinking disabled, the host's budget, the run's prefix otherwise", async () => {
		const { session, seen } = await bound("deepseek-flash", "openai-compat");
		expect(await session.followUp({ maxTokens: 200 })).toBe("next");
		const [run, follow] = seen as [StreamOptions, StreamOptions];
		expect(follow.reasoning).toEqual({ thinking: "disabled" });
		expect(follow.maxTokens).toBe(200);
		expect(follow.systemPrompt).toBe(run.systemPrompt);
		expect(JSON.stringify(follow.messages.slice(0, run.messages.length))).toBe(JSON.stringify(run.messages));
	});

	it("a model the table does not know keeps its own setting and gets room for its thinking", async () => {
		const { session, seen } = await bound("some-unknown-model", "openai-compat");
		expect(await session.followUp({ maxTokens: 200 })).toBe("next");
		const [run, follow] = seen as [StreamOptions, StreamOptions];
		expect(follow.reasoning).toEqual(run.reasoning);
		expect(follow.maxTokens).toBe(600);
	});

	it("the anthropic route keeps the run's thinking setting: changing it would drop the cached prefix", async () => {
		const { session, seen } = await bound("deepseek-flash", "anthropic");
		await session.followUp({ maxTokens: 200 });
		expect(seen[1]!.reasoning).toEqual(seen[0]!.reasoning);
	});

	it("a host's own ask is sent exactly as before", async () => {
		const { session, seen } = await bound("deepseek-flash", "openai-compat");
		await session.followUp({ ask: ASK, maxTokens: 200 });
		expect(seen[1]!.reasoning).toEqual(seen[0]!.reasoning);
		expect(seen[1]!.maxTokens).toBe(200);
	});

	it("a line over 200 characters is dropped, not cut", async () => {
		const { session } = await bound("m", undefined, [say("First answer."), say("x".repeat(201))]);
		expect(await session.followUp({})).toBe("");
	});
});
