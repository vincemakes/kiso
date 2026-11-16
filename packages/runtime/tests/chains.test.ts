// ADR-0062 PR 3: the causal chain read from a log, its durable wake budget, the completion notice, held messages.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { ChainBudget, completionNotice, currentChain, reachesFurther } from "../src/chains.js";
import { writeMessage, type PeerMessage } from "../src/inbox.js";

const u = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, type: "user_input", content: "x", ...extra }) as unknown as Event;
const peer = (seq: number, rootId: string, from = "k/p", event = "message") => u(seq, { source: "system", via: { kind: "peer", event, from, messageId: `m${seq}`, rootId } });
const tasks = (seq: number) => u(seq, { source: "system", via: { kind: "tasks", items: [{ taskId: "t", transition: "exited" }] } });
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

describe("currentChain", () => {
	it("a person's line opens a chain; a message carries its chain; a task notice keeps the one before", () => {
		expect(currentChain([], "k/a")).toBe("k/a#0");
		expect(currentChain([u(0)], "k/a")).toBe("k/a#0");
		expect(currentChain([u(0), peer(4, "k/b#2")], "k/a")).toBe("k/b#2");
		expect(currentChain([u(0), peer(4, "k/b#2"), tasks(9)], "k/a")).toBe("k/b#2");
		expect(currentChain([peer(4, "k/b#2"), u(7)], "k/a"), "the person speaks: a new chain").toBe("k/a#7");
	});
});

describe("reachesFurther (the hold)", () => {
	const at = (tier: string, added: string[] = []) => ({ tier, added });
	it("two sessions in full access are never held, whatever folders either was given (owner, 2026-11-16)", () => {
		expect(reachesFurther(at("full-access"), at("full-access"))).toBe(false);
		expect(reachesFurther(at("full-access"), at("full-access", ["/elsewhere"]))).toBe(false);
		expect(reachesFurther(at("full-access", ["/a"]), at("full-access", ["/b", "/c"]))).toBe(false);
	});
	it("held when the receiver's mode is wider, or it has a folder the sender lacks, or its mode is unknown", () => {
		expect(reachesFurther(at("default"), at("full-access"))).toBe(true);
		expect(reachesFurther(at("plan"), at("accept-edits"))).toBe(true);
		expect(reachesFurther(at("default"), at("default", ["/x"]))).toBe(true);
		expect(reachesFurther(at("default"), at("mystery"))).toBe(true);
	});
	it("not held when the receiver reaches no further", () => {
		expect(reachesFurther(at("full-access"), at("default"))).toBe(false);
		expect(reachesFurther(at("default", ["/x"]), at("default", ["/x"]))).toBe(false);
	});
});

describe("ChainBudget", () => {
	it("allows 20 wakes per chain, then none, and a new instance (a restart) does not refill it", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-cb-"));
		const b = new ChainBudget(dir);
		for (let i = 0; i < 20; i++) expect(b.take("k/a#0")).toBe(true);
		expect(b.take("k/a#0")).toBe(false);
		expect(new ChainBudget(dir).take("k/a#0"), "after a restart").toBe(false);
		expect(new ChainBudget(dir).take("k/a#9"), "another chain has its own").toBe(true);
	});
});

describe("completionNotice", () => {
	const end = (kind: string) => ({ seq: 99, type: "terminal", outcome: { kind } }) as unknown as Event;
	const reply = (text: string) => [{ seq: 50, type: "assistant_start" }, { seq: 51, type: "text_delta", text }] as unknown as Event[];
	it("owed for the first run and for a run that took the parent's message; not for the person's own runs", () => {
		const base = { parent: "k/p", tasksRunning: false, waiting: false };
		expect(completionNotice({ ...base, run: [u(0), ...reply("done"), end("completed")], firstRun: true })).toEqual({ state: "finished", excerpt: "done" });
		expect(completionNotice({ ...base, run: [u(10), ...reply("x"), end("completed")], firstRun: false })).toBeNull();
		expect(completionNotice({ ...base, run: [u(10), peer(11, "k/p#0"), ...reply("x"), end("completed")], firstRun: false })?.state).toBe("finished");
		expect(completionNotice({ ...base, run: [u(10), peer(11, "k/q#0", "k/q"), ...reply("x"), end("completed")], firstRun: false }), "another session's message: no").toBeNull();
	});
	it("says how the run ended, never 'finished' for a failure or work left running; the excerpt is 400 characters at most", () => {
		const base = { parent: "k/p", firstRun: true, waiting: false };
		expect(completionNotice({ ...base, tasksRunning: false, run: [u(0), end("error")] })?.state).toBe("failed");
		expect(completionNotice({ ...base, tasksRunning: true, run: [u(0), end("completed")] })?.state).toBe("ended with tasks still running");
		expect(completionNotice({ ...base, tasksRunning: false, waiting: true, run: [u(0), end("completed")] })?.state).toBe("waiting on you");
		expect(completionNotice({ ...base, tasksRunning: false, run: [u(0), ...reply("y".repeat(500)), end("completed")] })?.excerpt).toHaveLength(401);
	});
});

describe("delivery with a budget and a hold", () => {
	const msg = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "S", text: id, files: [], rootId: "k/s#0", at: 1, ...extra });
	it("a held message is never delivered; a spent chain does not wake, its message waits for the next run", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-cd-")));
		const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("One.")] as never) });
		const session = await agent.session({ id: "r" });
		await writeMessage(store.root, "r", msg("held", { held: true }));
		await writeMessage(store.root, "r", msg("waits"));
		let woke = false;
		session.usePeers({ root: store.root, onWake: () => (woke = true), mayWake: () => false });
		expect(woke, "the chain's budget is spent").toBe(false);
		expect(session.pokePeers(), "and the sender is told it waits").toBe("waiting");
		for await (const _ of session.run("the person speaks")) void _;
		const ids = session.log.all.flatMap((e) => (e.type === "user_input" && e.via?.kind === "peer" ? [e.via.messageId] : []));
		expect(ids, "the waiting one rode the person's run; the held one did not").toEqual(["waits"]);
	});
});
