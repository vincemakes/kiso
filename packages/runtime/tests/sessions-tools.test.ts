// ADR-0062 PR 1: the sessions tools' mark (a sidecar tenant), carried by a fork; the lock probe; the terminal's refusing twin.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore } from "../src/index.js";
import { hasSessionsTools, markSessionsTools, readSessionName, readStartedBy, writeSessionName, writeStartedBy } from "../src/profile.js";
import { ChainBudget } from "../src/chains.js";
import { peerMessageId, readInbox, writeMessage } from "../src/inbox.js";
import { heldElsewhere } from "../src/lock-adapter.js";
import { LIST_SESSIONS, SESSIONS_REFUSAL, refusingSessionsExtension, shortRefs } from "../src/sessions-tools.js";

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
		expect(await tool.execute({}, {} as never), "a precondition: nothing ran").toEqual({ content: SESSIONS_REFUSAL, isError: true, errorKind: "precondition" });
	});
});

// § 14 test 2: two folders mint session ids alone, so one id can be two Works: refs, ids, inboxes, parent links and chains
// stay apart (the address is `<folder key>/<session id>`)
describe("one session id in two folders", () => {
	it("each is listed as folder/id; an id listed once keeps its short suffix", () => {
		const refs = shortRefs([{ id: "w-1a2b3c4d", folder: "api" }, { id: "w-1a2b3c4d", folder: "web" }, { id: "w-9f8e7d6c", folder: "api" }]);
		expect(refs.get("api/w-1a2b3c4d")).toBe("api/w-1a2b3c4d");
		expect(refs.get("web/w-1a2b3c4d")).toBe("web/w-1a2b3c4d");
		expect(refs.get("api/w-9f8e7d6c")).toBe("7d6c");
	});

	it("the same send to each is two messages, each in its own folder's inbox; a replay is a duplicate in its own only", async () => {
		const [api, web] = [mkdtempSync(join(tmpdir(), "kiso-2f-")), mkdtempSync(join(tmpdir(), "kiso-2f-"))];
		const send = (to: string) => ({ messageId: peerMessageId("kA/s", "c1", to, "hi"), from: "kA/s", fromTitle: "S", text: "hi", files: [], rootId: "kA/s#0", at: 1 });
		expect(send("kApi/w").messageId).not.toBe(send("kWeb/w").messageId);
		expect(await writeMessage(api, "w", send("kApi/w"))).toBe("written");
		expect(await writeMessage(web, "w", send("kWeb/w"))).toBe("written");
		expect(await writeMessage(api, "w", send("kApi/w"))).toBe("duplicate");
		expect(readInbox(api, "w").map((m) => m.messageId)).toEqual([send("kApi/w").messageId]);
		expect(readInbox(web, "w").map((m) => m.messageId)).toEqual([send("kWeb/w").messageId]);
	});

	it("parent links name the folder, and chains through each are counted apart", () => {
		const [api, web, home] = [mkdtempSync(join(tmpdir(), "kiso-2f-")), mkdtempSync(join(tmpdir(), "kiso-2f-")), mkdtempSync(join(tmpdir(), "kiso-2f-"))];
		writeStartedBy(api, "child", "kApi/w");
		writeStartedBy(web, "child", "kWeb/w");
		expect([readStartedBy(api, "child"), readStartedBy(web, "child")]).toEqual(["kApi/w", "kWeb/w"]);
		const budget = new ChainBudget(home, 1);
		expect(budget.take("kApi/w#0")).toBe(true);
		expect(budget.take("kWeb/w#0"), "the other folder's chain has its own budget").toBe(true);
		expect(budget.take("kApi/w#0")).toBe(false);
	});
});
