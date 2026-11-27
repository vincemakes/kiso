/**
 * ADR-0064 A2 — a lease session's bootstrap in the runtime (A2 spec § 4.4,
 * § 4.5, § 6): the door writes it only into an empty log; a lease session's
 * checkpoint never takes it as material; a lease session cannot be forked;
 * a log holding only the bootstrap resumes into an ordinary first run; and
 * effective history lists it as runtime evidence no quote can come from.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Adapter, Message, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, ForkRefusedError, SessionStore } from "../src/index.js";
import { effectiveHistory, parityMismatches } from "../src/effective-history.js";
import { forkSession } from "../src/fork.js";
import { BootstrapRefusedError, bootstrapOf, writeBootstrap } from "../src/lease.js";
import { locateQuote } from "../src/provenance.js";

const BOOT = "Work snapshot at revision 4, taken when this session started. BOOTSTRAP-MARKER-7c1";
const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");
const say = (text: string) => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

const fresh = () => new SessionStore(mkdtempSync(join(tmpdir(), "kiso-lease-")));
const textOf = (messages: readonly Message[]): string => JSON.stringify(messages);

async function leaseSession(script: Parameters<typeof createFauxProvider>[0]) {
	const store = fresh();
	await writeBootstrap(store, "s", { meta: { leaseId: "L1", workId: "w1" }, projection: BOOT });
	const faux = createFauxProvider(script);
	const requests: StreamOptions[] = [];
	const adapter = { stream: (opts: StreamOptions) => (requests.push(opts), faux.stream(opts)) } as Adapter;
	const agent = createAgent({ model: "faux", store, tools: [], adapter, systemPrompt: "you are a test agent" });
	const session = await agent.session({ id: "s" });
	return { store, session, requests };
}

describe("the bootstrap door", () => {
	it("writes event 0 of an empty log, and refuses a log that has any event", async () => {
		const store = fresh();
		await writeBootstrap(store, "s", { meta: { leaseId: "L1" }, projection: BOOT });
		expect(bootstrapOf(store, "s")).toEqual({ meta: { leaseId: "L1" }, projection: BOOT });
		await expect(writeBootstrap(store, "s", { meta: { leaseId: "L2" }, projection: "again" })).rejects.toBeInstanceOf(BootstrapRefusedError);
		const other = fresh();
		await other.append("o", "r1", { seq: 0, type: "user_input", content: "hi" });
		await expect(writeBootstrap(other, "o", { meta: {}, projection: BOOT })).rejects.toBeInstanceOf(BootstrapRefusedError);
		expect(bootstrapOf(other, "o")).toBeUndefined();
	});
});

describe("a log holding only the bootstrap", () => {
	it("resumes into an ordinary first run: nothing recovered, the request opens with the bootstrap", async () => {
		const { store, session, requests } = await leaseSession([say("hello")]);
		for await (const _ of session.run("start the work")) {
			// the run lands in the log
		}
		const first = requests[0]!.messages;
		expect(first[0]).toEqual({ role: "user", content: BOOT, source: "system" });
		expect(first[1]).toMatchObject({ role: "user", content: "start the work" });
		const types = store.load("s").map((r) => r.event.type);
		expect(types[0]).toBe("context_bootstrap");
		expect(types[1]).toBe("user_input");
		expect(types).not.toContain("model_output_abandoned");
	});
});

describe("invariant 2: the bootstrap is never summary material", () => {
	it("a lease session's checkpoint call is the serialised form, and neither its input nor the checkpoint holds bootstrap bytes", async () => {
		const { store, session, requests } = await leaseSession([say("one"), say("two"), say("three"), say(VALID_SUMMARY)]);
		for (const ask of ["first", "second", "third"]) {
			for await (const _ of session.run(ask)) {
				// three rounds
			}
		}
		const before = requests.length;
		const result = await session.summarize({ keepRounds: 1 });
		expect(result).not.toBeNull();
		const summaryCall = requests.slice(before);
		expect(summaryCall).toHaveLength(1);
		expect(textOf(summaryCall[0]!.messages)).not.toContain("BOOTSTRAP-MARKER-7c1");
		expect(String(summaryCall[0]!.messages[0] && (summaryCall[0]!.messages[0] as { content: unknown }).content)).toContain("<conversation>");
		const summarized = store.load("s").map((r) => r.event).find((e) => e.type === "summarized");
		expect(JSON.stringify(summarized)).not.toContain("BOOTSTRAP-MARKER-7c1");
	});

	it("after the checkpoint the bootstrap still opens the context, before the summary", async () => {
		const { session, requests } = await leaseSession([say("one"), say("two"), say("three"), say(VALID_SUMMARY), say("four")]);
		for (const ask of ["first", "second", "third"]) {
			for await (const _ of session.run(ask)) {
				// three rounds
			}
		}
		await session.summarize({ keepRounds: 1 });
		for await (const _ of session.run("fourth")) {
			// after the checkpoint
		}
		const last = requests[requests.length - 1]!.messages;
		expect(last[0]).toEqual({ role: "user", content: BOOT, source: "system" });
		expect(String((last[1] as { content: unknown }).content)).toContain("## Goal");
	});
});

describe("a lease session cannot be forked (A2 spec § 4.5)", () => {
	it("refuses, naming the way to continue the work", async () => {
		const { store, session } = await leaseSession([say("hello")]);
		for await (const _ of session.run("go")) {
			// one finished run
		}
		expect(() => forkSession(store.root, "s")).toThrow(ForkRefusedError);
		expect(() => forkSession(store.root, "s")).toThrow(/open a new lease/);
	});

	it("an ordinary session still forks, byte for byte", async () => {
		const store = fresh();
		await store.append("p", "r1", { seq: 0, type: "user_input", content: "go" });
		await store.append("p", "r1", { seq: 1, type: "text_delta", text: "ok" });
		await store.append("p", "r1", { seq: 2, type: "stop", reason: "end_turn" });
		await store.append("p", "r1", { seq: 3, type: "terminal", outcome: { kind: "completed" } });
		const { id } = forkSession(store.root, "p");
		expect(readFileSync(join(store.root, `${id}.jsonl`))).toEqual(readFileSync(join(store.root, "p.jsonl")));
	});
});

describe("effective history", () => {
	it("lists the bootstrap as runtime evidence with no human authority; no quote can come from it; parity holds", async () => {
		const { store, session } = await leaseSession([say("hello")]);
		for await (const _ of session.run("go")) {
			// one run
		}
		const events = store.load("s").map((r) => r.event);
		expect(effectiveHistory(events)[0]).toMatchObject({ seq: 0, kind: "runtime", authority: "runtime", content: BOOT });
		expect(locateQuote(events, { owner: "session/s", seq: 0, span: "Work snapshot" })).toBeNull();
		expect(parityMismatches(events)).toEqual([]);
	});
});
