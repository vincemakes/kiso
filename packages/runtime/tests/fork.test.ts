/**
 * SessionStore.fork (plan fork rev 2, owner 2026-11-03): one rule for the terminal, the web app and the products, a fork
 * starts after a reply. The copy ends at that run's terminal, byte for byte; the sidecar carries the parent's profile,
 * the name "… (fork)" and the origin, never the parent's summary. The fork note rides with the fork's FIRST input,
 * after the copied history, so the first request's prefix is the parent's (measured on co: 88% cache hit against 0%
 * with the note in the system prompt); later inputs never carry it.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, ForkRefusedError, SessionStore } from "../src/index.js";
import { readForkOrigin, readSessionName, readSummary } from "../src/profile.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run);
};

async function fixture(script: unknown[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fk-")));
	const faux = createFauxProvider(script as never);
	const seen: StreamOptions[] = [];
	const adapter: Adapter = { stream: (options) => (seen.push(options), faux.stream(options)) };
	const agent = createAgent({ model: "m", store, systemPrompt: "you are a test", tools: [], adapter });
	return { store, agent, seen };
}

const events = (store: SessionStore, id: string) => readFileSync(join(store.root, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);

describe("SessionStore.fork", () => {
	it("after the last run: the log up to its terminal, the name, the origin, no summary carried", async () => {
		const { store, agent } = await fixture([say("One."), say("Two.")]);
		const parent = await agent.session({ id: "p" });
		await drain(parent.run("first"));
		await drain(parent.run("second"));
		const { id, origin } = store.fork("p");
		const parentLines = readFileSync(join(store.root, "p.jsonl"), "utf8");
		expect(readFileSync(join(store.root, `${id}.jsonl`), "utf8"), "the parent's log, byte for byte").toBe(parentLines);
		expect(origin).toMatchObject({ session: "p", afterSeq: events(store, "p").at(-1).seq, title: "first" });
		expect(readSessionName(store.root, id)).toBe("first (fork)");
		expect(readForkOrigin(store.root, id)).toEqual(origin);
		expect(readSummary(store.root, "p"), "the parent has a summary").not.toBeNull();
		expect(readSummary(store.root, id), "the fork does not carry it").toBeNull();
	});

	it("after the first run: one run only; a point that is not a run's end, or no finished run, is refused in words", async () => {
		const { store, agent } = await fixture([say("One."), say("Two.")]);
		const parent = await agent.session({ id: "p" });
		await drain(parent.run("first"));
		await drain(parent.run("second"));
		const firstEnd = events(store, "p").find((e) => e.type === "terminal").seq;
		const { id } = store.fork("p", { afterSeq: firstEnd });
		const kept = events(store, id);
		expect(kept.filter((e) => e.type === "terminal")).toHaveLength(1);
		expect(kept.at(-1)).toMatchObject({ type: "terminal", seq: firstEnd });
		expect(() => store.fork("p", { afterSeq: 0 })).toThrow(ForkRefusedError);
		expect(() => store.fork("nobody")).toThrow(ForkRefusedError);
	});

	it("the fork's first input carries the note after the copied history; the next does not; a fork of a fork works", async () => {
		const { store, agent, seen } = await fixture([say("One."), say("Fork answer."), say("Again."), say("Deeper.")]);
		const parent = await agent.session({ id: "p" });
		await drain(parent.run("first"));
		const { id } = store.fork("p");
		const fork = await agent.session({ id });
		await drain(fork.run("next question"));
		const input = events(store, id).filter((e) => e.type === "user_input").at(-1);
		expect(input.content[0].text).toMatch(/^This session was forked from the session "first"/);
		expect(input.content[1]).toEqual({ type: "text", text: "next question" });
		const parentRequest = seen[0]!;
		const forkRequest = seen[1]!;
		expect(forkRequest.systemPrompt, "the system prompt is the parent's").toBe(parentRequest.systemPrompt);
		expect(JSON.stringify(forkRequest.messages.slice(0, parentRequest.messages.length)), "the parent's messages lead, byte for byte").toBe(JSON.stringify(parentRequest.messages));
		await drain(fork.run("and again"));
		expect(events(store, id).filter((e) => e.type === "user_input").at(-1).content, "a later input never carries it").toBe("and again");
		const deeper = store.fork(id);
		expect(readForkOrigin(store.root, deeper.id)?.session).toBe(id);
		expect(readSessionName(store.root, deeper.id)).toBe("first (fork) (fork)");
	});
});
