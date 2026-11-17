// ADR-0062 § 14 tests 21 and 1, with a real kill -9 of the process that holds the receiver.
// 21: three messages reach an idle receiver at one boundary; the process dies after the second is admitted; reopened, the
//     first two are never admitted again and the third is admitted once, once the cut-off run is resumed (as the page's
//     resume card does).
// 1: the process that held the receiver is gone; a message is written to its inbox meanwhile; opened, the receiver admits it
//    once, and a second open admits nothing.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createAgent, SessionStore, type Session } from "../src/index.js";
import { readInbox, writeMessage, type PeerMessage } from "../src/inbox.js";
import { openRunId } from "../src/recovery.js";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run) void _;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (id: string, at: number): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "Sender", text: `note ${id}`, files: [], rootId: "k/s#1", at });
const peerIds = (s: Session): string[] => s.log.all.flatMap((e) => (e.type === "user_input" && e.via?.kind === "peer" ? [e.via.messageId] : []));

/** A child process opens the receiver and delivers its inbox; it SIGKILLs itself after the `killAfter`-th admission, or,
 *  with 0, once it is open and idle. */
async function holder(root: string, killAfter: number): Promise<void> {
	const url = (p: string): string => JSON.stringify(new URL(p, import.meta.url).href);
	const child = `
import { createAgent, SessionStore } from ${url("../dist/index.js")};
import { createFauxProvider } from ${url("../../evals/dist/index.js")};
const append = SessionStore.prototype.append;
let admitted = 0;
SessionStore.prototype.append = async function (sessionId, runId, event) {
	await append.call(this, sessionId, runId, event); // durable first: the kill lands after the admission is on disk
	if (event.type === "user_input" && event.via?.kind === "peer" && ++admitted === ${killAfter}) process.kill(process.pid, "SIGKILL");
};
const store = new SessionStore(${JSON.stringify(root)});
const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider(${JSON.stringify([say("never")])}) }).session({ id: "r" });
session.usePeers({ root: ${JSON.stringify(root)}, onWake: (w) => void (async () => { for await (const _ of session.run(w.content, { source: "system", via: w.via })) void _; })() });
if (${killAfter} === 0) process.kill(process.pid, "SIGKILL");
setTimeout(() => process.exit(3), 10_000); // never reached: the kill comes first
`;
	const proc = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: ["ignore", "ignore", "inherit"] });
	const signal = await new Promise<NodeJS.Signals | null>((resolve) => proc.on("exit", (_code, sig) => resolve(sig)));
	expect(signal, "the holder died by kill -9").toBe("SIGKILL");
}

/** The receiver opened again, as the web host opens a Work: its inbox delivered, a wake started as a run. While the log
 *  still has an open run the wake is refused before any run begins, as the server's `run()` refuses it (OpenRunError). */
async function reopen(root: string, script: unknown[]) {
	const store = new SessionStore(root);
	const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider(script as never) }).session({ id: "r" });
	const runs: Promise<void>[] = [];
	const stop = session.usePeers({ root, onWake: (w) => void (openRunId(store.load("r")) === undefined && runs.push(drain(session.run(w.content, { source: "system", via: w.via })))) });
	const quiet = async (): Promise<void> => {
		for (let n = -1; n !== runs.length; ) {
			n = runs.length;
			await Promise.all(runs);
			await sleep(40);
		}
	};
	return { session, runs, stop, quiet };
}

describe("test 21: a crash between admissions replays only what was not admitted", () => {
	it("three messages at one boundary, killed after the second: the third is admitted once, the first two never again", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-k9-21-"));
		for (const [i, id] of ["m1", "m2", "m3"].entries()) await writeMessage(root, "r", msg(id, i + 1));
		await holder(root, 2);
		const onDisk = new SessionStore(root).load("r").flatMap((x) => (x.event.type === "user_input" && x.event.via?.kind === "peer" ? [x.event.via.messageId] : []));
		expect(onDisk, "on disk at the kill: the first two").toEqual(["m1", "m2"]);

		const r = await reopen(root, [say("Read the first two."), say("Read the third.")]);
		await r.quiet();
		expect(readInbox(root, "r").map((m) => m.messageId), "the admitted two are deleted unread; the third waits").toEqual(["m3"]);
		expect(peerIds(r.session), "nothing admitted while the cut-off run is open").toEqual(["m1", "m2"]);
		await drain(r.session.resume()); // the person resumes the cut-off run
		await r.quiet();
		expect(peerIds(r.session), "the third, once").toEqual(["m1", "m2", "m3"]);
		expect(readInbox(root, "r")).toEqual([]);
		r.stop();
	}, 30_000);
});

describe("test 1: with the host down a message lands in the inbox and is admitted once on open", () => {
	it("written while nothing holds the receiver; the first open admits it, a second open admits nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-k9-1-"));
		await holder(root, 0); // the receiver was open, then its process died
		expect(await writeMessage(root, "r", msg("m1", 1)), "the send needs no live receiver").toBe("written");

		const first = await reopen(root, [say("Read it.")]);
		await first.quiet();
		expect(peerIds(first.session)).toEqual(["m1"]);
		first.stop();
		const second = await reopen(root, [say("never")]);
		await second.quiet();
		expect(second.runs, "the second open starts nothing").toHaveLength(0);
		expect(peerIds(second.session)).toEqual(["m1"]);
		expect(readInbox(root, "r")).toEqual([]);
		second.stop();
	}, 30_000);
});
