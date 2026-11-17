// ADR-0062 § 14 tests 5, 6, 7, 9 and 11, with live sessions on one folder: two running sessions past the inbox cap; a
// three-session cycle spending its chain's 20 wakes, then a restart; two parent messages in one child run and one notice; a
// child's notice waking its idle parent while a sibling still runs; a file's revision for the model, and a 2 GB file hashed as
// a stream. The send tool here is the web host's, reduced to the runtime's own parts (id, chain, inbox, poke).
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type Tool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type Session } from "../src/index.js";
import { ChainBudget, completionMessage, currentChain } from "../src/chains.js";
import { fileRevision, INBOX_LIMITS, InboxRefusedError, peerMessageId, readInbox, writeMessage, type PeerMessage } from "../src/inbox.js";
import { writeStartedBy } from "../src/profile.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const call = (callId: string, name: string, input: unknown) => ({ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] });
const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run) void _;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const peerIds = (s: Session): string[] => s.log.all.flatMap((e) => (e.type === "user_input" && e.via?.kind === "peer" ? [e.via.messageId] : []));
const results = (s: Session, name: string): { content: string; isError: boolean }[] => {
	const calls = new Set(s.log.all.flatMap((e) => (e.type === "tool_call_end" && e.name === name ? [e.callId] : [])));
	return s.log.all.flatMap((e) => (e.type === "tool_result" && calls.has(e.callId) ? [{ content: String(e.content), isError: e.isError }] : []));
};

/** Sessions on one folder (`k`), each delivering its inbox; a wake starts a run, as the web host's does. */
function folder(root: string, budget?: ChainBudget) {
	const sessions = new Map<string, Session>();
	const runs: Promise<void>[] = [];
	const stops: (() => void)[] = [];
	/** `message`: the id from the call, the chain from the sender's log, the receiver told to look. */
	const send = (self: string): Tool =>
		defineTool({
			name: "message",
			description: "send a message",
			parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false },
			execute: async (raw, ctx) => {
				const { to, text } = raw as { to: string; text: string };
				const from = `k/${self}`;
				try {
					await writeMessage(root, to, { messageId: peerMessageId(from, ctx.callId ?? "", `k/${to}`, text), from, fromTitle: self, text, files: [], rootId: currentChain(sessions.get(self)!.log.all, from), at: Date.now() });
				} catch (err) {
					if (err instanceof InboxRefusedError) return { content: err.message, isError: true, errorKind: "precondition" as const };
					throw err;
				}
				return { content: `Sent: ${sessions.get(to)?.pokePeers() ?? "waiting"}`, isError: false };
			},
		});
	const open = async (id: string, script: unknown[], tools: Tool[] = []): Promise<Session> => {
		const store = new SessionStore(root);
		const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [send(id), ...tools], adapter: createFauxProvider(script as never) }).session({ id });
		sessions.set(id, session);
		stops.push(session.usePeers({ root, onWake: (w) => void runs.push(drain(session.run(w.content, { source: "system", via: w.via }))), ...(budget !== undefined ? { mayWake: (r: string) => budget.take(r) } : {}) }));
		return session;
	};
	/** Wait until no run is going and none was started meanwhile. */
	const quiet = async (): Promise<void> => {
		for (let n = -1; n !== runs.length; ) {
			n = runs.length;
			await Promise.all(runs);
			await sleep(40); // a settle's look, and the wake it may start
		}
	};
	const close = (): void => {
		for (const stop of stops.splice(0)) stop();
	};
	return { sessions, runs, open, quiet, close };
}

/** A tool that waits until the test opens it: the run stays live, at no boundary, meanwhile. */
const gate = () => {
	let open!: () => void;
	const opened = new Promise<void>((r) => (open = r));
	const tool = defineTool({ name: "wait", description: "waits", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => (await opened, { content: "done", isError: false }) });
	return { tool, open };
};

describe("test 5: two running sessions past the inbox cap", () => {
	it("the send past the cap is refused in words; every accepted message is admitted, none lost", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-cap-"));
		const f = folder(root);
		const held = gate();
		const b = await f.open("b", [call("b1", "wait", {}), call("b2", "message", { to: "a", text: "Got your note." }), say("Done.")], [held.tool]);
		const bRun = drain(b.run("Work on the report."));
		while (!b.log.all.some((e) => e.type === "tool_call_end")) await sleep(5); // b is running, inside its tool
		const third = Array.from({ length: INBOX_LIMITS.messages - 1 }, (_, i): PeerMessage => ({ messageId: `x${String(i).padStart(3, "0")}`, from: "k/x", fromTitle: "X", text: `note ${i}`, files: [], rootId: "k/x#1", at: i }));
		for (const m of third) await writeMessage(root, "b", m);
		const aHeld = gate();
		const a = await f.open("a", [call("a1", "message", { to: "b", text: "first" }), call("a2", "message", { to: "b", text: "second" }), call("a3", "wait", {}), say("Done.")], [aHeld.tool]);
		const aRun = drain(a.run("Tell b twice."));
		while (results(a, "message").length < 2) await sleep(5); // both of a's sends answered while both run
		const [first, second] = results(a, "message");
		expect(first!.isError, "the 200th is accepted").toBe(false);
		expect(second, "the 201st is refused in words").toMatchObject({ isError: true, content: "the receiver's inbox is full; send later" });
		held.open(); // b reaches its boundary: everything accepted is admitted
		aHeld.open();
		await Promise.all([bRun, aRun]);
		await f.quiet();
		const accepted = [...third.map((m) => m.messageId), peerMessageId("k/a", "a1", "k/b", "first")];
		expect(peerIds(b).sort(), "every accepted message admitted once, nothing else").toEqual(accepted.sort());
		expect(peerIds(a), "b's reply reached a, which was still running or woke").toEqual([peerMessageId("k/b", "b2", "k/a", "Got your note.")]);
		expect(readInbox(root, "b"), "nothing left over").toEqual([]);
		f.close();
	}, 60_000);
});

describe("test 6: A→B→C→A past 20 wakes", () => {
	const relay = (self: string, next: string) => Array.from({ length: 12 }, (_, i) => [call(`${self}${i}`, "message", { to: next, text: `pass ${self}${i}` }), say("Passed.")]).flat();

	it("the 21st queues and starts nothing; after a restart the waiting one and a 22nd start nothing either", async () => {
		const [root, home] = [mkdtempSync(join(tmpdir(), "kiso-cyc-")), mkdtempSync(join(tmpdir(), "kiso-cyc-h-"))];
		const f = folder(root, new ChainBudget(join(home, "chains")));
		const [a] = [await f.open("a", relay("a", "b")), await f.open("b", relay("b", "c")), await f.open("c", relay("c", "a"))];
		await drain(a!.run("Start the relay."));
		await f.quiet();
		const chain = currentChain(a!.log.all.filter((e) => e.type === "user_input" && e.via === undefined), "k/a");
		const woken = (): number => [...f.sessions.values()].reduce((n, s) => n + s.log.all.filter((e) => e.type === "user_input" && e.via?.kind === "peer").length, 0);
		expect(woken(), "20 wakes, each one message").toBe(20);
		expect(new ChainBudget(join(home, "chains")).spent(chain), "the chain's budget is spent").toBe(20);
		const waiting = ["a", "b", "c"].flatMap((id) => readInbox(root, id));
		expect(waiting, "the 21st waits in its receiver's inbox").toHaveLength(1);
		expect(waiting[0]!.rootId).toBe(chain);
		f.close();

		// a host restart: new stores, a new budget read from disk, every session opened and looking at its inbox
		const g = folder(root, new ChainBudget(join(home, "chains")));
		for (const id of ["a", "b", "c"]) await g.open(id, [say("never")]);
		await writeMessage(root, "b", { messageId: "the-22nd", from: "k/a", fromTitle: "a", text: "pass on", files: [], rootId: chain, at: Date.now() });
		expect(g.sessions.get("b")!.pokePeers(), "the 22nd starts nothing").toBe("waiting");
		await g.quiet();
		expect(g.runs, "no run started after the restart").toHaveLength(0);
		expect(["a", "b", "c"].flatMap((id) => readInbox(root, id)), "both wait").toHaveLength(2);
		g.close();
	}, 60_000);
});

describe("test 7: two parent messages in one child run give one notice", () => {
	it("the run admits both, the notice is one file however often the settle is reported", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-note-"));
		const f = folder(root);
		const held = gate();
		const child = await f.open("c", [say("Started."), call("c1", "wait", {}), say("Both handled.")], [held.tool]);
		writeStartedBy(root, "c", "k/p");
		await drain(child.run("Brief: build the parser.")); // its first run (its own notice is not what this test is about)
		const going = drain(child.run("Go on."));
		while (!child.log.all.some((e) => e.type === "tool_call_end" && e.callId === "c1")) await sleep(5);
		for (const text of ["Use the new schema.", "And keep the old one readable."]) {
			await writeMessage(root, "c", { messageId: peerMessageId("k/p", text, "k/c", text), from: "k/p", fromTitle: "p", text, files: [], rootId: "k/p#1", at: Date.now() });
			expect(child.pokePeers()).toBe("handed");
		}
		held.open();
		await going;
		const records = new SessionStore(root).load("c");
		const runId = records.at(-1)!.runId;
		expect(records.filter((r) => r.runId === runId && r.event.type === "user_input" && r.event.via?.kind === "peer"), "one run admitted both").toHaveLength(2);
		const notice = (): PeerMessage => completionMessage({ records: new SessionStore(root).load("c"), runId, from: "k/c", fromTitle: "c", parent: "k/p", tasksRunning: false })!;
		expect(await writeMessage(root, "p", notice())).toBe("written");
		expect(await writeMessage(root, "p", notice()), "a second report of the same settle").toBe("duplicate");
		expect(readInbox(root, "p").filter((m) => m.event === "completion"), "one notice").toHaveLength(1);
		f.close();
	}, 30_000);
});

describe("test 9: a child finishing while a sibling runs", () => {
	it("the idle parent wakes at once, before the sibling ends", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-sib-"));
		const f = folder(root);
		const parent = await f.open("p", [say("c1 is done.")]);
		const held = gate();
		const sibling = await f.open("c2", [call("w", "wait", {}), say("Done too.")], [held.tool]);
		const one = await f.open("c1", [say("Done.")]);
		for (const id of ["c1", "c2"]) writeStartedBy(root, id, "k/p");
		let siblingEnded = false;
		const siblingRun = drain(sibling.run("Brief two.")).then(() => void (siblingEnded = true));
		while (!sibling.log.all.some((e) => e.type === "tool_call_end")) await sleep(5);
		await drain(one.run("Brief one."));
		const records = new SessionStore(root).load("c1");
		await writeMessage(root, "p", completionMessage({ records, runId: records.at(-1)!.runId, from: "k/c1", fromTitle: "c1", parent: "k/p", tasksRunning: false })!);
		expect(parent.pokePeers(), "the parent wakes").toBe("woke");
		await Promise.all(f.runs);
		expect(parent.log.all.filter((e) => e.type === "user_input" && e.via?.kind === "peer" && e.via.event === "completion"), "its run read the notice").toHaveLength(1);
		expect(siblingEnded, "while the sibling still runs").toBe(false);
		held.open();
		await siblingRun;
		f.close();
	}, 30_000);
});

describe("test 11: files", () => {
	it("a file's revision is the file tools' and reaches the receiver's model with the path; nothing of it is in the via", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-file-"));
		const path = join(root, "schema.md");
		writeFileSync(path, "v1");
		const rev = await fileRevision(path);
		expect(rev, "the file tools' revision").toBe(`rev:${createHash("sha256").update("v1").digest("hex").slice(0, 16)}`);
		const f = folder(root);
		const r = await f.open("r", [say("Read it.")]);
		await writeMessage(root, "r", { messageId: "m1", from: "k/s", fromTitle: "s", text: "The schema.", files: [{ path, rev }], rootId: "k/s#1", at: 1 });
		r.pokePeers();
		await f.quiet();
		const input = r.log.all.find((e): e is Extract<Event, { type: "user_input" }> => e.type === "user_input" && e.via?.kind === "peer")!;
		// v1 (§ 3): the model reads the path and the revision when sent; a read that prints another revision is a changed file
		expect(input.content).toContain(`- ${path} (${rev} when sent)`);
		writeFileSync(path, "v2");
		expect(await fileRevision(path), "changed since: another revision").not.toBe(rev);
		expect(Object.keys(input.via!).sort(), "nothing for the page to draw").toEqual(["event", "from", "kind", "messageId", "rootId"]);
		f.close();
	});

	it.skipIf(process.platform === "win32")("a 2 GB file is hashed as a stream, never held in memory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-2g-"));
		const path = join(dir, "big.bin");
		const fd = openSync(path, "w");
		ftruncateSync(fd, 2 * 1024 ** 3); // sparse: two gigabytes to read, none on the disk
		closeSync(fd);
		const base = process.memoryUsage().rss;
		let peak = base;
		const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10);
		try {
			expect(await fileRevision(path)).toMatch(/^rev:[0-9a-f]{16}$/);
		} finally {
			clearInterval(sample);
			rmSync(dir, { recursive: true, force: true });
		}
		expect(peak - base, "memory grew far less than the file").toBeLessThan(256 * 1024 ** 2);
	}, 60_000);
});
