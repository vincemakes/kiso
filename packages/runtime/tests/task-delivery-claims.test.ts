/**
 * ADR-0058 Amendment 7 at the delivery: a claimed transition is never
 * noticed — not in the live run, not after a restart — while every stop
 * that is not the model's own confirmed call (the person's, an unconfirmed
 * one) still is. And the summary snapshot learns a transition from a
 * claim ONLY through the claiming execution's durable, successful
 * tool_result: the task journal says who will report; the EventLog alone
 * says what the model knows.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type ToolContext } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type Run } from "../src/index.js";
import { appendRecord, type TaskRecord } from "../src/tasks/journal.js";
import { TaskDelivery } from "../src/tasks/delivery.js";
import { TaskManager, type TaskBackend } from "../src/tasks/manager.js";

const TOOL = { events: [{ type: "tool_call_end" as const, callId: "c1", name: "work", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] };
const END = { events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] };

function fakeBackend(): TaskBackend {
	let pid = 100;
	return {
		async spawn({ dir }) {
			pid += 1;
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid, startedAt: `start-${pid}` });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: (p, startedAt) => (startedAt === `start-${p}` ? "verified" : "gone"),
		signalStop: () => {},
	};
}

const journal = (m: TaskManager, id: string) => join(m.root, id, "journal.jsonl");
const end = (m: TaskManager, id: string, signal: string | null = "SIGTERM") => appendRecord(journal(m, id), { type: "terminal", ts: Date.now(), exitCode: null, signal });
const claim = (m: TaskManager, id: string, transition: string, executionId: string) =>
	appendRecord(journal(m, id), { type: "result_claimed", ts: Date.now(), transition, executionId } as unknown as TaskRecord);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notices = (events: readonly Event[]) => events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input" && e.via?.kind === "tasks");
/** The work tool's own result: its body (and the expects in it) ran to the end. */
const worked = (events: readonly Event[]) => events.filter((e): e is Event & { type: "tool_result" } => e.type === "tool_result").map((e) => [e.content, e.isError]);

async function setup(script: FauxScript, during?: (ctx: ToolContext, m: TaskManager) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-claimdeliv-"));
	const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10 });
	const work = defineTool({
		name: "work",
		description: "W",
		parameters: { type: "object" },
		execute: async (_i, ctx) => {
			await during?.(ctx, manager);
			return { content: "worked", isError: false };
		},
	});
	const session = await createAgent({ model: "faux", store: new SessionStore(dir), tools: [work], adapter: createFauxProvider(script) }).session({ id: "s" });
	return { session, manager };
}

async function drain(run: Run): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of run) out.push(ev);
	return out;
}

describe("a claimed transition is never noticed; every other stop still is", () => {
	it("the model's own stop, confirmed within the call: no notice in this run or the next", async () => {
		const { session, manager } = await setup([TOOL, END, END], async (ctx, m) => {
			const t = await m.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
			m.stop(t.id, "model");
			setTimeout(() => end(m, t.id), 20);
			const r = await m.awaitSettled(t.id, "end", 2_000, { executionId: ctx.executionId! });
			expect(r.claimed).toBe(true);
			await sleep(150); // a poll and a window would have flushed a notice by now
		});
		session.useTasks(manager, { windowMs: 30 });
		const first = await drain(session.run("go"));
		expect(worked(first)).toEqual([["worked", false]]);
		expect(notices(first)).toEqual([]);
		expect(notices(await drain(session.run("again")))).toEqual([]);
		manager.close();
	});

	it("the person's stop (/tasks stop) still reaches the model as a stopped notice", async () => {
		const { session, manager } = await setup([TOOL, END], async (_ctx, m) => {
			const t = await m.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
			m.stop(t.id, "person");
			end(m, t.id);
			await sleep(150);
		});
		session.useTasks(manager, { windowMs: 30 });
		expect(notices(await drain(session.run("go"))).map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "stopped" }] }]);
		manager.close();
	});

	it("a model stop NOT confirmed within the wait is noticed when it ends", async () => {
		const { session, manager } = await setup([TOOL, END], async (ctx, m) => {
			const t = await m.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
			m.stop(t.id, "model");
			const r = await m.awaitSettled(t.id, "end", 60, { executionId: ctx.executionId! });
			expect(r.claimed).toBe(false);
			end(m, t.id);
			await sleep(150);
		});
		session.useTasks(manager, { windowMs: 30 });
		const events = await drain(session.run("go"));
		expect(worked(events)).toEqual([["worked", false]]);
		expect(notices(events).map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "stopped" }] }]);
		manager.close();
	});

	it("a restart does not re-deliver a claimed end (the claim alone decides)", async () => {
		const { session, manager } = await setup([END]);
		const t = await manager.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
		manager.close();
		manager.stop(t.id, "model");
		end(manager, t.id);
		claim(manager, t.id, "stopped", "ex-stop");
		const restarted = new TaskManager({ root: manager.root, backend: fakeBackend(), pollMs: 10 });
		session.useTasks(restarted, { windowMs: 20 });
		await sleep(80);
		expect(notices(await drain(session.run("hi")))).toEqual([]);
		restarted.close();
	});
});

describe("0460-S1 — the snapshot learns a claimed transition only from the claiming execution's durable, successful result", () => {
	const ev = (e: Record<string, unknown>) => e as unknown as Event;
	const started = ev({ seq: 3, type: "tool_execution_started", executionId: "ex-start" });
	const startResult = ev({ seq: 4, type: "tool_result", callId: "a", content: "started background task t1.", isError: false, executionId: "ex-start" });

	async function stoppedAndClaimed() {
		const dir = mkdtempSync(join(tmpdir(), "kiso-claimsnap-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend() });
		const t = await manager.start({ command: "node server.js", cwd: "/", executionId: "ex-start" });
		manager.stop(t.id, "model");
		end(manager, t.id);
		claim(manager, t.id, "stopped", "ex-stop");
		return { manager, delivery: new TaskDelivery({ manager, events: () => [], liveRun: () => undefined }) };
	}

	it("a claim plus the stop call's durable successful result: the model was told it stopped", async () => {
		const { manager, delivery } = await stoppedAndClaimed();
		const stopResult = ev({ seq: 8, type: "tool_result", callId: "b", content: "stopped task t1", isError: false, executionId: "ex-stop" });
		expect(delivery.snapshot([started, startResult, stopResult])).toBe("Background tasks, as you were last told: t1 stopped — node server.js.");
		delivery.close();
		manager.close();
	});

	it("a claim with no durable result (the crash window) tells the summary nothing new", async () => {
		const { manager, delivery } = await stoppedAndClaimed();
		const stopStarted = ev({ seq: 7, type: "tool_execution_started", executionId: "ex-stop" });
		expect(delivery.snapshot([started, startResult, stopStarted])).toBe("Background tasks, as you were last told: t1 running — node server.js.");
		delivery.close();
		manager.close();
	});

	it("a claim whose execution was resolved as an error (abandoned) tells the summary nothing new", async () => {
		const { manager, delivery } = await stoppedAndClaimed();
		const abandoned = ev({ seq: 8, type: "tool_result", callId: "b", content: "interrupted execution — abandoned", isError: true, errorKind: "precondition", executionId: "ex-stop" });
		expect(delivery.snapshot([started, startResult, abandoned])).toBe("Background tasks, as you were last told: t1 running — node server.js.");
		delivery.close();
		manager.close();
	});

	it("a promotion's ready, told in its own result, is what the summary says; a later notice wins by log order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-claimsnap-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend() });
		manager.adopt({ command: "npm run dev", cwd: "/", executionId: "ex-p", readyWhen: "Local:", runner: { pid: process.pid, startedAt: "" }, ready: true, stop: () => {} });
		const delivery = new TaskDelivery({ manager, events: () => [], liveRun: () => undefined });
		const pStarted = ev({ seq: 3, type: "tool_execution_started", executionId: "ex-p" });
		const pResult = ev({ seq: 4, type: "tool_result", callId: "a", content: 'ready — the output contains "Local:"; continued as background task t1', isError: false, executionId: "ex-p" });
		expect(delivery.snapshot([pStarted, pResult])).toBe("Background tasks, as you were last told: t1 ready — npm run dev.");
		const later = ev({ seq: 9, type: "user_input", content: "n", source: "system", via: { kind: "tasks", items: [{ taskId: "t1", transition: "failed" }] } });
		expect(delivery.snapshot([pStarted, pResult, later])).toBe("Background tasks, as you were last told: t1 failed — npm run dev.");
		delivery.close();
		manager.close();
	});
});
