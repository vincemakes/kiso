// ADR-0062 § 5 / § 14 test 3: a send cut off by a real kill -9. The sender's process dies inside `message`, before its
// receipt (after the inbox write, or before it); reopened, the execution is uncertain and resolved "rerun" (as the web host
// does on open); the model sends again in a new call. The receiver admits the message exactly once, under one id, whether the
// first attempt was still in the inbox, already admitted, or never written.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { defineTool, type Tool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { peerMessageId, readInbox, retriedSendCallId, writeMessage } from "../src/inbox.js";

const SEND = { to: "Receiver", text: "The schema is in docs/schema.md." };
const call = (callId: string) => ({ events: [{ type: "tool_call_end", callId, name: "message", input: SEND }, { type: "stop", reason: "tool_use" }] });
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const drain = async (run: AsyncIterable<unknown>): Promise<void> => {
	for await (const _ of run) void _;
};

/** The sender's `message`, as the web host builds it: the id from the call, or from the send a crash rerun cut off. */
const sendTool = (sender: SessionStore, inbox: string): Tool =>
	defineTool({
		name: "message",
		description: "send a message",
		parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false },
		execute: async (raw, ctx) => {
			const input = raw as typeof SEND;
			const callId = retriedSendCallId(sender.load("a").map((r) => r.event), input) ?? ctx.callId ?? "";
			await writeMessage(inbox, "b", { messageId: peerMessageId("k/a", callId, "k/b", input.text), from: "k/a", fromTitle: "Sender", text: input.text, files: [], rootId: "k/a#1", at: Date.now() });
			return { content: "Sent.", isError: false };
		},
	});

/** A child process runs the sender's first turn and SIGKILLs itself inside `message`, before or after the inbox write. */
async function killedSend(senderDir: string, inbox: string, when: "before" | "after"): Promise<void> {
	const url = (p: string): string => JSON.stringify(new URL(p, import.meta.url).href);
	const child = `
import { createAgent, SessionStore } from ${url("../dist/index.js")};
import { peerMessageId, writeMessage } from ${url("../dist/internal.js")};
import { createFauxProvider } from ${url("../../evals/dist/index.js")};
const store = new SessionStore(${JSON.stringify(senderDir)});
const tool = { name: "message", description: "send a message", parameters: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false },
	execute: async (input, ctx) => {
		if (${JSON.stringify(when)} === "after") await writeMessage(${JSON.stringify(inbox)}, "b", { messageId: peerMessageId("k/a", ctx.callId, "k/b", input.text), from: "k/a", fromTitle: "Sender", text: input.text, files: [], rootId: "k/a#1", at: Date.now() });
		process.kill(process.pid, "SIGKILL");
	} };
const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [tool], adapter: createFauxProvider(${JSON.stringify([call("c1")])}) }).session({ id: "a" });
for await (const _ of session.run("Tell the receiver where the schema is.")) void _;
`;
	const proc = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: ["ignore", "ignore", "inherit"] });
	const signal = await new Promise<NodeJS.Signals | null>((resolve) => proc.on("exit", (_code, sig) => resolve(sig)));
	expect(signal, "the sender died by kill -9").toBe("SIGKILL");
}

async function receiver(root: string) {
	const store = new SessionStore(root);
	const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [], adapter: createFauxProvider([say("Got it."), say("Again.")] as never) }).session({ id: "b" });
	const look = async (): Promise<void> => {
		let woke: Promise<void> | undefined;
		const stop = session.usePeers({ root, onWake: (w) => void (woke = drain(session.run(w.content, { source: "system", via: w.via }))) });
		await woke;
		await new Promise((r) => setTimeout(r, 20)); // the settle's look
		stop();
	};
	const admitted = (): string[] => session.log.all.flatMap((e) => (e.type === "user_input" && e.via?.kind === "peer" ? [e.via.messageId] : []));
	return { look, admitted };
}

/** Reopen the sender, settle its uncertain send as the web host does, and let the model send again in a new call. */
async function reopenAndResend(senderDir: string, inbox: string): Promise<void> {
	const store = new SessionStore(senderDir);
	const session = await createAgent({ model: "m", store, systemPrompt: "t", tools: [sendTool(store, inbox)], adapter: createFauxProvider([call("c2"), say("Sent again.")] as never) }).session({ id: "a" });
	const uncertain = session.uncertainExecutions();
	expect(uncertain.map((u) => u.name), "the cut-off send is uncertain").toEqual(["message"]);
	for (const u of uncertain) await session.resolveUncertain(u.executionId, "rerun");
	await drain(session.resume()); // the run cut off resumes (the web host resumes it on open); the model sends again
}

describe("a send cut off by kill -9 is admitted once", () => {
	it("killed after the inbox write, the retry still in the inbox: one file, one admission, the first attempt's id", async () => {
		const [senderDir, inbox] = [mkdtempSync(join(tmpdir(), "kiso-k9s-")), mkdtempSync(join(tmpdir(), "kiso-k9r-"))];
		await killedSend(senderDir, inbox, "after");
		expect(readInbox(inbox, "b"), "the write landed before the kill").toHaveLength(1);
		await reopenAndResend(senderDir, inbox);
		expect(readInbox(inbox, "b"), "the retry is a duplicate, not a second file").toHaveLength(1);
		const r = await receiver(inbox);
		await r.look();
		expect(r.admitted()).toEqual([peerMessageId("k/a", "c1", "k/b", SEND.text)]);
	}, 30_000);

	it("killed after the inbox write, admitted before the retry: the retry's file is deleted unread", async () => {
		const [senderDir, inbox] = [mkdtempSync(join(tmpdir(), "kiso-k9s-")), mkdtempSync(join(tmpdir(), "kiso-k9r-"))];
		await killedSend(senderDir, inbox, "after");
		const r = await receiver(inbox);
		await r.look();
		await reopenAndResend(senderDir, inbox);
		await r.look();
		expect(r.admitted(), "admitted once").toHaveLength(1);
		expect(readInbox(inbox, "b"), "nothing left over").toEqual([]);
	}, 30_000);

	it("killed before the inbox write: nothing landed, the retry writes it, admitted once", async () => {
		const [senderDir, inbox] = [mkdtempSync(join(tmpdir(), "kiso-k9s-")), mkdtempSync(join(tmpdir(), "kiso-k9r-"))];
		await killedSend(senderDir, inbox, "before");
		expect(readInbox(inbox, "b"), "no trace").toEqual([]);
		await reopenAndResend(senderDir, inbox);
		const r = await receiver(inbox);
		await r.look();
		expect(r.admitted()).toHaveLength(1);
	}, 30_000);
});

describe("retriedSendCallId", () => {
	const end = (callId: string, input: unknown) => ({ type: "tool_call_end", callId, name: "message", input }) as never;
	const rerun = (callId: string) => ({ type: "tool_execution_resolved", executionId: `x${callId}`, callId, resolution: "rerun" }) as never;
	const result = (callId: string, isError: boolean) => ({ type: "tool_result", callId, content: "", isError }) as never;

	it("names the call a rerun cut off when to, text and files match; never a send that landed, nor once it was re-sent", () => {
		expect(retriedSendCallId([end("c1", SEND), rerun("c1"), result("c1", true)], SEND)).toBe("c1");
		expect(retriedSendCallId([end("c1", SEND), rerun("c1")], { ...SEND, text: "other" }), "another text").toBeUndefined();
		expect(retriedSendCallId([end("c1", SEND), result("c1", false)], SEND), "a send that landed is never reused").toBeUndefined();
		expect(retriedSendCallId([end("c1", SEND), rerun("c1"), result("c1", true), end("c2", SEND), result("c2", false)], SEND), "re-sent once: a later same text is a new message").toBeUndefined();
	});
});
