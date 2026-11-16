// ADR-0062 PR 1: the sessions tools' mark (a sidecar tenant), carried by a fork; the lock probe; the terminal's refusing twin.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { hasSessionsTools, markSessionsTools, readSessionName, writeSessionName } from "../src/profile.js";
import { heldElsewhere } from "../src/lock-adapter.js";
import { LIST_SESSIONS, SESSIONS_REFUSAL, refusingSessionsExtension } from "../src/sessions-tools.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

describe("the sessions tools' mark", () => {
	it("is absent until written, keeps the other tenants, and a fork carries it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-st-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("One.")] as never) });
		const s = await agent.session({ id: "p" });
		for await (const _ of s.run("first")) void _;
		expect(hasSessionsTools(store.root, "p")).toBe(false);
		writeSessionName(store.root, "p", "named");
		markSessionsTools(store.root, "p");
		expect(hasSessionsTools(store.root, "p")).toBe(true);
		expect(readSessionName(store.root, "p"), "the name rides through").toBe("named");
		const { id } = store.fork("p");
		expect(hasSessionsTools(store.root, id), "the fork keeps the parent's table").toBe(true);
	});

	it("an unmarked parent's fork is unmarked", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-st-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("One.")] as never) });
		const s = await agent.session({ id: "q" });
		for await (const _ of s.run("first")) void _;
		expect(hasSessionsTools(store.root, store.fork("q").id)).toBe(false);
	});
});

describe("heldElsewhere", () => {
	it("absent, empty, this process's or a dead holder's lock: not held; a live other process's: held", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-st-"));
		const lock = (body: string) => (writeFileSync(join(dir, "x.lock"), body), join(dir, "x.lock"));
		expect(heldElsewhere(join(dir, "none.lock"))).toBe(false);
		expect(heldElsewhere(lock(""))).toBe(false);
		expect(heldElsewhere(lock(JSON.stringify({ pid: process.pid, token: "t" })))).toBe(false);
		expect(heldElsewhere(lock(JSON.stringify({ pid: 2 ** 22 - 1, token: "t" }))), "no such process").toBe(false);
		expect(heldElsewhere(lock(JSON.stringify({ pid: process.ppid, token: "t" }))), "the parent is alive").toBe(true);
	});
});

describe("the terminal's twin", () => {
	it("has the web's name, schema and description, and refuses with a reason", async () => {
		const tool = refusingSessionsExtension().tools![0]!;
		expect({ name: tool.name, description: tool.description, parameters: tool.parameters }).toEqual(LIST_SESSIONS);
		expect(await tool.execute({}, {} as never)).toEqual({ content: SESSIONS_REFUSAL, isError: true });
	});
});
