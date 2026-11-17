// ADR-0062 § 10b (PR 6): rewind takes back the line just sent, without spending the cache. A: a line aborted at once and
// rewound, then the fixed line; B: the fixed line alone. A's next request equals B's byte for byte, and the rewound text is in
// no request after the rewind. C: without rewind nothing changes, the aborted line stays a message of its own. And the rule:
// only the last line, only a run that was aborted and did nothing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Adapter, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { sessionTitle } from "../src/store.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "delay", ms: 3000 }, { type: "text_delta", text: "never" }, { type: "stop", reason: "end_turn" }] };
const call = { events: [{ type: "tool_call_end", callId: "c1", name: "noop", input: {} }, { type: "stop", reason: "tool_use" }] };
const noop = defineTool({ name: "noop", description: "does nothing", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: "done", isError: false }) });

async function work(script: unknown[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-rw-")));
	const faux = createFauxProvider(script as never);
	const seen: StreamOptions[] = [];
	const adapter: Adapter = { stream: (o) => (seen.push(o), faux.stream(o)) };
	const session = await createAgent({ model: "m", store, systemPrompt: "you are a test", tools: [noop], adapter }).session({ id: "w" });
	const run = async (text: string, abortAfterMs?: number): Promise<void> => {
		const r = session.run(text);
		if (abortAfterMs !== undefined) setTimeout(() => r.abort(), abortAfterMs);
		for await (const _ of r) void _;
	};
	return { store, session, seen, run };
}
const bytes = (o: StreamOptions): string => JSON.stringify({ system: (o as { systemPrompt?: unknown }).systemPrompt, tools: o.tools, messages: o.messages });

describe("rewind keeps the cache", () => {
	it("A (a line aborted and rewound, then the fixed one) sends B's request (the fixed one alone), byte for byte", async () => {
		const a = await work([say("One."), slow, say("Fixed.")]);
		await a.run("first");
		await a.run("typo line", 50);
		expect(await a.session.rewind()).toBe("typo line");
		const after = a.seen.length;
		await a.run("fixed line");
		const b = await work([say("One."), say("Fixed.")]);
		await b.run("first");
		await b.run("fixed line");
		expect(bytes(a.seen.at(-1)!)).toBe(bytes(b.seen.at(-1)!));
		expect(a.seen.slice(after).some((o) => JSON.stringify(o).includes("typo line")), "the rewound text is in no later request").toBe(false);
	});

	it("C: without rewind the aborted line stays, a message of its own before the next", async () => {
		const c = await work([say("One."), slow, say("Second.")]);
		await c.run("first");
		await c.run("typo line", 50);
		await c.run("second line");
		const users = c.seen.at(-1)!.messages.filter((m) => m.role === "user").map((m) => m.content);
		expect(users).toEqual(["first", "typo line", "second line"]);
	});
});

describe("what can be rewound", () => {
	it("only an aborted run that did nothing: a finished run, a run that called a tool, or a busy session cannot", async () => {
		const done = await work([say("One.")]);
		await done.run("first");
		expect(done.session.rewindable(), "a run that finished").toBeNull();
		const tool = await work([call, slow]);
		await tool.run("use the tool", 200);
		expect(tool.session.rewindable(), "a run that executed a tool").toBeNull();
		const busy = await work([slow]);
		const r = busy.session.run("going");
		const going = (async () => {
			for await (const _ of r) void _;
		})();
		await new Promise((ok) => setTimeout(ok, 30));
		expect(busy.session.rewindable(), "a session that is running").toBeNull();
		r.abort();
		await going;
		expect(busy.session.rewindable()?.content, "once aborted, it can").toBe("going");
	}, 20_000); // the scripted model's delay does not end early on an abort: two of them here

	it("only the last line: after a rewind there is nothing more to take back, and the title skips the vetoed line", async () => {
		const w = await work([slow]);
		await w.run("oops", 50);
		expect(await w.session.rewind()).toBe("oops");
		expect(w.session.rewindable()).toBeNull();
		expect(await w.session.rewind()).toBeNull();
		expect(sessionTitle(w.store.load("w"))).toBe("(no prompt)");
	});
});
