// ADR-0062 PR 2: the durable inbox (capacity, races, duplicates) and messages admitted one by one, exactly once, from the log.
import { chmodSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import type { Adapter, StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { INBOX_LIMITS, InboxRefusedError, inboxDir, readInbox, writeMessage, type PeerMessage } from "../src/inbox.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const msg = (id: string, text = "hi", at = Date.now()): PeerMessage => ({ messageId: id, from: "k/sender", fromTitle: "Sender", text, files: [], rootId: "k/sender", at });
const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run) void _;
};

// filling an inbox is 200 durable writes (each fsynced, with its directory): on a loaded machine that passes 5 s
describe("the inbox", () => {
	it("writes one file per message, oldest first; a replayed id is a duplicate, not a second file", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-ib-"));
		expect(await writeMessage(root, "r", msg("b", "two", 2))).toBe("written");
		expect(await writeMessage(root, "r", msg("a", "one", 1))).toBe("written");
		expect(await writeMessage(root, "r", msg("a", "one", 1))).toBe("duplicate");
		expect(readInbox(root, "r").map((m) => m.text)).toEqual(["one", "two"]);
	});

	it("refuses a message too long, too many files, or a full inbox, in words", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-ib-"));
		await expect(writeMessage(root, "r", msg("x", "y".repeat(INBOX_LIMITS.textBytes + 1)))).rejects.toThrow(InboxRefusedError);
		await expect(writeMessage(root, "r", { ...msg("x"), files: Array.from({ length: INBOX_LIMITS.files + 1 }, (_, i) => ({ path: `/f${i}`, rev: "rev:0" })) })).rejects.toThrow(/limit/);
		for (let i = 0; i < INBOX_LIMITS.messages; i++) await writeMessage(root, "r", msg(`m${i}`));
		await expect(writeMessage(root, "r", msg("over"))).rejects.toThrow(/full/);
	}, 30_000);

	it("counts whole records against the byte limit, so long path lists cannot slip past it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-ib-"));
		const files = Array.from({ length: INBOX_LIMITS.files }, (_, i) => ({ path: `/${"p".repeat(2000)}/${i}`, rev: "rev:0123456789abcdef" }));
		await expect((async () => {
			for (let i = 0; i < 40; i++) await writeMessage(root, "r", { ...msg(`f${i}`), files });
		})()).rejects.toThrow(/full/);
		expect(readInbox(root, "r").length).toBeLessThan(40);
	}, 30_000);

	it("three senders racing for the last slot: exactly one is accepted", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-ib-"));
		for (let i = 0; i < INBOX_LIMITS.messages - 1; i++) await writeMessage(root, "r", msg(`m${i}`));
		const results = await Promise.allSettled(["x", "y", "z"].map((id) => writeMessage(root, "r", msg(id))));
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(readInbox(root, "r")).toHaveLength(INBOX_LIMITS.messages);
	}, 30_000);
});

async function receiver(script: unknown[]) {
	const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-pm-")));
	const faux = createFauxProvider(script as never);
	const seen: StreamOptions[] = [];
	const adapter: Adapter = { stream: (options) => (seen.push(options), faux.stream(options)) };
	const agent = createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter });
	const session = await agent.session({ id: "r" });
	return { store, session, seen };
}
const peerInputs = (session: { log: { all: readonly { type: string; via?: { kind: string; messageId?: string } }[] } }) =>
	session.log.all.filter((e) => e.type === "user_input" && e.via?.kind === "peer").map((e) => e.via!.messageId);

describe("the inbox on Windows", () => {
	it("syncs the directory through fsyncDir, which skips it on win32 (opening a directory there fails with EPERM); the file's own fsync stays", () => {
		const src = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
		expect(src).toContain("fsyncDir(dir)");
		expect(src, "no directory opened by hand").not.toMatch(/openSync\(dir\b/);
		expect(src, "the file is still synced").toMatch(/fsyncSync\(fd\)/);
	});
});

describe("peer delivery", () => {
	it("idle: one wake run carries every waiting message, each its own user_input, before one model request", async () => {
		const { store, session, seen } = await receiver([say("Read them.")]);
		for (const id of ["a", "b", "c"]) await writeMessage(store.root, "r", msg(id, `text ${id}`, id.charCodeAt(0)));
		let woke: Promise<void> | undefined;
		session.usePeers({ root: store.root, onWake: (w) => void (woke = drain(session.run(w.content, { source: "system", via: w.via }))) });
		await woke;
		expect(peerInputs(session)).toEqual(["a", "b", "c"]);
		expect(seen, "one request after the three admissions").toHaveLength(1);
		await new Promise((r) => setTimeout(r, 10)); // the settle's look
		expect(readdirSync(inboxDir(store.root, "r")).filter((n) => n.endsWith(".json")), "admitted: the files are gone").toEqual([]);
	});

	it("exactly once: a file whose id the log holds is deleted unread, never admitted twice", async () => {
		const { store, session } = await receiver([say("One."), say("Two.")]);
		await writeMessage(store.root, "r", msg("a"));
		let woke: Promise<void> | undefined;
		const stop = session.usePeers({ root: store.root, onWake: (w) => void (woke = drain(session.run(w.content, { source: "system", via: w.via }))) });
		await woke;
		stop();
		await writeMessage(store.root, "r", msg("a")); // the replayed send of an admitted message
		woke = undefined;
		session.usePeers({ root: store.root, onWake: (w) => void (woke = drain(session.run(w.content, { source: "system", via: w.via }))) });
		expect(woke, "nothing new: no wake").toBeUndefined();
		expect(peerInputs(session)).toEqual(["a"]);
		expect(readInbox(store.root, "r")).toEqual([]);
	});

	// a read-only directory does not stop a delete on Windows, so the failure cannot be staged there
	it.skipIf(process.platform === "win32")("a delete that fails leaves litter, not a second admission", async () => {
		const { store, session } = await receiver([say("One.")]);
		await writeMessage(store.root, "r", msg("a"));
		let woke: Promise<void> | undefined;
		session.usePeers({ root: store.root, onWake: (w) => void (woke = drain(session.run(w.content, { source: "system", via: w.via }))) });
		chmodSync(inboxDir(store.root, "r"), 0o500); // the file cannot be deleted
		await woke;
		await new Promise((r) => setTimeout(r, 10));
		session.pokePeers();
		chmodSync(inboxDir(store.root, "r"), 0o700);
		expect(readInbox(store.root, "r").map((m) => m.messageId), "still there").toEqual(["a"]);
		expect(peerInputs(session), "admitted once").toEqual(["a"]);
	});

	it("a message to a running session is admitted at its next boundary, and is never the person's", async () => {
		const tool = { type: "tool_call_end", callId: "c1", name: "noop", input: {} };
		const { store, session } = await receiver([{ events: [tool, { type: "stop", reason: "tool_use" }] }, say("Done.")]);
		session.usePeers({ root: store.root });
		const run = session.run("work");
		const going = drain(run);
		await writeMessage(store.root, "r", msg("a", "mid-run"));
		expect(session.pokePeers(), "handed to the live run").toBe("handed");
		await going;
		const admitted = session.log.all.find((e) => e.type === "user_input" && e.via?.kind === "peer");
		expect(admitted).toMatchObject({ source: "system", via: { kind: "peer", messageId: "a" } });
	});
});
