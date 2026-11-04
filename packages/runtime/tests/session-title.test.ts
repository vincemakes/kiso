/**
 * Session.title (owner 2026-11-03: a session is titled by a summary of its first message, not the message): one side
 * query with its own prompt and that message, no tools, no history. It asks for no thinking where the model table says
 * how (measured on co: 6-10 tokens out instead of 100 cut short), and sends no reasoning field for a model the table
 * does not know. The answer is cleaned to one line; nothing durable is written.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { cleanTitle, TITLE_PROMPT } from "../src/session.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const ADD = defineTool({ name: "add", description: "add", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "3", isError: false as const }) });

async function fixture(script: unknown[], model = "m", baseUrl?: string) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-ti-")));
	const faux = createFauxProvider(script as never);
	const seen: StreamOptions[] = [];
	const adapter: Adapter = { stream: (options) => (seen.push(options), faux.stream(options)) };
	const agent = createAgent({ model, store, systemPrompt: "you are a test", tools: [ADD], adapter, ...(baseUrl !== undefined ? { baseUrl } : {}) });
	const session = await agent.session({ id: "ti" });
	return { store, session, seen };
}

describe("Session.title", () => {
	it("asks once with its own prompt and the message: no tools, no history, no reasoning for an unknown model", async () => {
		const { session, seen } = await fixture([say('"Fix the ledger bug."')]);
		const long = `npm test fails. ${"x".repeat(600)}`;
		expect(await session.title(long)).toBe("Fix the ledger bug");
		expect(seen).toHaveLength(1);
		const r = seen[0]!;
		expect(r.systemPrompt).toBe(TITLE_PROMPT);
		expect(r.messages).toEqual([{ role: "user", content: long.slice(0, 500) }]);
		expect(r.tools).toBeUndefined();
		expect(r.reasoning, "the table does not know model m: nothing is sent").toBeUndefined();
		expect(r.maxTokens).toBe(400);
	});

	it("names the language: the title is written in the language of the message (owner 2026-11-04)", () => {
		// ds, a three-character Chinese greeting, 10 samples each: 5 English titles without the clause, 0 with it
		expect(TITLE_PROMPT).toBe(
			"Write a short title (2 to 8 words) for a conversation that opens with the user's message, in the language of that message. Only the title: no quotes, no punctuation at the end.",
		);
	});

	it("asks for no thinking where the table says how: thinking disabled first-party, effort none (off) on Command Code", async () => {
		const ds = await fixture([say("A title")], "deepseek-flash", "https://api.deepseek.com");
		await ds.session.title("hello there");
		expect(ds.seen[0]!.reasoning).toEqual({ thinking: "disabled" });
		expect(ds.seen[0]!.maxTokens).toBe(100);
		const co = await fixture([say("A title")], "deepseek/deepseek-v4.1-flash", "https://api.commandcode.ai/provider/v1");
		await co.session.title("hello there");
		expect(co.seen[0]!.reasoning).toEqual({ effort: "off" });
		expect(co.seen[0]!.maxTokens).toBe(100);
	});

	it("writes nothing durable and is marked in the trace", async () => {
		const { store, session } = await fixture([say("A title")]);
		await session.title("hello there");
		const purposes = (): (string | null)[] => readFileSync(join(store.root, "traces", "ti.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "request").map((r) => r.purpose ?? null);
		await expect.poll(purposes, { timeout: 2000 }).toEqual(["title"]);
		expect(store.ids()).not.toContain("ti");
	});
});

describe("cleanTitle", () => {
	it("keeps one line: no quotes around it, no punctuation at its end, spaces collapsed, at most 60 characters", () => {
		expect(cleanTitle('  "Fix   the bug."  \nmore')).toBe("Fix the bug");
		expect(cleanTitle("“Fix the bug”")).toBe("Fix the bug");
		expect(cleanTitle("「A title」。")).toBe("A title");
		expect([...cleanTitle("w ".repeat(80))].length).toBe(60);
		expect(cleanTitle("...")).toBe("");
		expect(cleanTitle("")).toBe("");
	});
});
