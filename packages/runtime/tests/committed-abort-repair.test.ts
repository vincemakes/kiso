/**
 * 0.40.2 — an esc in a COMMITTED round left a call with no started and no
 * result, and every later request was a provider 400 (the owner's session
 * 2026-09-22T01-58-27-0027: three committed shell calls, two results, an
 * aborted terminal). The runtime's recovery answers such a call with one
 * durable "aborted before execution" result, riding the run that owns it,
 * before anything projects the session into a request.
 *
 * The fixture is that session's shape (seq 82375–82388), rebuilt through
 * the store: the log itself is the owner's work and stays on his disk.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { projectMessages, type Adapter, type Message, type StreamOptions } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";
import { ABORTED_BEFORE_EXECUTION, unansweredAbortedCalls } from "../src/aborted-calls.js";

/**
 * Run r1: three shell calls, each approved, the stop that commits them;
 * c0 runs and succeeds, c1 starts and fails ("shell aborted"), the esc
 * lands before c2 starts; the aborted terminal. `extraDangling` adds a
 * fourth committed call that never ran either.
 */
async function seedPoisoned(dir: string, extraDangling = false): Promise<void> {
	const store = new SessionStore(dir);
	let seq = 0;
	const put = (e: Record<string, unknown>) => store.append("s", "r1", { seq: seq++, ...e } as never);
	await put({ type: "user_input", content: "run the three checks" });
	const calls = extraDangling ? ["c0", "c1", "c2", "c3"] : ["c0", "c1", "c2"];
	const callSeq: Record<string, number> = {};
	for (const [i, id] of calls.entries()) {
		callSeq[id] = seq;
		await put({ type: "tool_call_end", callId: id, name: "shell", input: { command: `check ${i}` } });
		await put({ type: "permission_decided", decisionId: `d${i}`, callId: id, invocationSeq: callSeq[id], decision: "approved", decidedBy: "mode:bypass" });
	}
	await put({ type: "stop", reason: "tool_use" });
	// c0: started → succeeded → result; c1: started → failed → result (82382–82387)
	const ex0 = `ex-${seq}`;
	await put({ type: "tool_execution_started", executionId: ex0, callId: "c0", invocationSeq: callSeq.c0, name: "shell", input: { command: "check 0" } });
	await put({ type: "tool_execution_succeeded", executionId: ex0, callId: "c0", invocationSeq: callSeq.c0, result: { content: "ok", isError: false } });
	await put({ type: "tool_result", callId: "c0", invocationSeq: callSeq.c0, content: "ok", isError: false });
	const ex1 = `ex-${seq}`;
	await put({ type: "tool_execution_started", executionId: ex1, callId: "c1", invocationSeq: callSeq.c1, name: "shell", input: { command: "check 1" } });
	await put({ type: "tool_execution_failed", executionId: ex1, callId: "c1", invocationSeq: callSeq.c1, error: "shell aborted", errorKind: "fatal", safeToRetry: false });
	await put({ type: "tool_result", callId: "c1", invocationSeq: callSeq.c1, content: "shell aborted", isError: true, errorKind: "fatal" });
	await put({ type: "terminal", outcome: { kind: "aborted", by: "user" } });
	await store.closeAll();
}

/** The durable records, read the way a new process reads them. */
const load = (dir: string) => new SessionStore(dir).load("s");

/** Every assistant tool_use is followed by its own tool message. */
function unpaired(messages: readonly Message[]): string[] {
	const missing: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const calls = m.blocks.filter((b) => b.type === "tool_use").map((b) => (b as { callId: string }).callId);
		const following: string[] = [];
		for (let j = i + 1; j < messages.length && messages[j]!.role === "tool"; j++) following.push((messages[j] as { callId: string }).callId);
		missing.push(...calls.filter((c) => !following.includes(c)));
	}
	return missing;
}

async function runOnce(dir: string) {
	const store = new SessionStore(dir);
	const faux = createFauxProvider([{ events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] }]);
	const requests: StreamOptions[] = [];
	const adapter = { stream: (opts: StreamOptions) => (requests.push(opts), faux.stream(opts)) } as Adapter;
	const agent = createAgent({ model: "faux", store, tools: [], adapter });
	const session = await agent.session({ id: "s" });
	for await (const _ of session.run("why did it fail")) {
		// the run lands in the log and the store
	}
	await store.closeAll();
	return requests;
}

describe("unansweredAbortedCalls — the shape, and only the shape", () => {
	it("finds the committed call that never ran in the aborted run, with that run's id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-abort-repair-"));
		await seedPoisoned(dir);
		expect(unansweredAbortedCalls(load(dir))).toEqual([{ runId: "r1", callId: "c2", invocationSeq: 5 }]);
	});

	it("an uncommitted call (no stop) is not it — the loop abandons such a turn whole", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-abort-repair-")));
		let seq = 0;
		await store.append("s", "r1", { seq: seq++, type: "user_input", content: "go" } as never);
		await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: "c0", name: "shell", input: { command: "x" } } as never);
		await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "aborted", by: "user" } } as never);
		expect(unansweredAbortedCalls(store.load("s"))).toEqual([]);
	});

	it("a run that did not end aborted is not it", async () => {
		const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-abort-repair-")));
		let seq = 0;
		await store.append("s", "r1", { seq: seq++, type: "user_input", content: "go" } as never);
		await store.append("s", "r1", { seq: seq++, type: "tool_call_end", callId: "c0", name: "shell", input: { command: "x" } } as never);
		await store.append("s", "r1", { seq: seq++, type: "stop", reason: "tool_use" } as never);
		await store.append("s", "r1", { seq: seq++, type: "terminal", outcome: { kind: "completed" } } as never);
		expect(unansweredAbortedCalls(store.load("s"))).toEqual([]);
	});
});

describe("the repair — the poisoned session heals by the next run", () => {
	it("red on 0.40.1: the next request carried c2's tool_use with no result / green: every call is paired, c2 says it never ran", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-abort-repair-"));
		await seedPoisoned(dir);
		expect(unpaired(projectMessages(load(dir).map((r) => r.event)))).toEqual(["c2"]);

		const requests = await runOnce(dir);
		expect(unpaired(requests[0]!.messages)).toEqual([]);
		const c2 = requests[0]!.messages.find((m) => m.role === "tool" && (m as { callId: string }).callId === "c2") as { content: string; isError: boolean } | undefined;
		expect(c2?.content).toBe(ABORTED_BEFORE_EXECUTION);
		expect(c2?.isError).toBe(true);

		// durable: exactly one result for c2, riding r1, landed before the new input
		const records = load(dir);
		const repair = records.filter((r) => r.event.type === "tool_result" && r.event.callId === "c2");
		expect(repair).toHaveLength(1);
		expect(repair[0]!.runId).toBe("r1");
		expect(repair[0]!.event).toMatchObject({ invocationSeq: 5, errorKind: "precondition" });
		const input = records.findIndex((r) => r.event.type === "user_input" && r.event.content === "why did it fail");
		expect(records.indexOf(repair[0]!)).toBeLessThan(input);
		// and no started event was invented — the call never began
		expect(records.some((r) => r.event.type === "tool_execution_started" && r.event.callId === "c2")).toBe(false);
	});

	it("idempotent per invocation: a crash between two repairs leaves the rest for the next run, never a second result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-abort-repair-"));
		await seedPoisoned(dir, true);
		// the crash shape: c2's repair landed, c3's did not
		const seeded = load(dir);
		const c2Seq = seeded.find((r) => r.event.type === "tool_call_end" && r.event.callId === "c2")!.event.seq;
		const writer = new SessionStore(dir);
		await writer.append("s", "r1", { seq: seeded.at(-1)!.event.seq + 1, type: "tool_result", callId: "c2", invocationSeq: c2Seq, content: ABORTED_BEFORE_EXECUTION, isError: true, errorKind: "precondition" } as never);
		await writer.closeAll();

		const requests = await runOnce(dir);
		expect(unpaired(requests[0]!.messages)).toEqual([]);
		const records = load(dir);
		for (const id of ["c2", "c3"]) expect(records.filter((r) => r.event.type === "tool_result" && r.event.callId === id)).toHaveLength(1);
		// a second run repairs nothing more
		await runOnce(dir);
		const again = load(dir);
		for (const id of ["c2", "c3"]) expect(again.filter((r) => r.event.type === "tool_result" && r.event.callId === id)).toHaveLength(1);
	});
});
