/**
 * ADR-0058 §7–§8, step 3c — a task's transitions reach the model: batched,
 * exactly once from the log's receipts, into a live run at its next safe
 * point, or — idle — one wake run (the chain budget, switchable), and never through
 * a summary before they were delivered. The TaskManager runs over a fake
 * backend (the real processes are tools-node's tests).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type ToolContext, type UserInputVia } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type AgentSession, type Run } from "../src/index.js";
import { appendRecord } from "../src/tasks/journal.js";
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

const end = (m: TaskManager, id: string, exitCode = 0) => appendRecord(join(m.root, id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode, signal: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inputs = (events: readonly Event[]) => events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input");

async function setup(script: FauxScript, during?: (ctx: ToolContext, m: TaskManager) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-delivery-"));
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

describe("ADR-0058 §7 — into a live run: one batch, at the next safe point, exactly once", () => {
	it("two tasks ending within the window land as ONE system input naming both; nothing is delivered twice", async () => {
		const { session, manager } = await setup([TOOL, END, END], async (_ctx, m) => {
			const a = await m.start({ command: "a", cwd: "/", executionId: "ex-a" });
			const b = await m.start({ command: "b", cwd: "/", executionId: "ex-b" });
			end(m, a.id);
			end(m, b.id, 2);
			await sleep(150); // the poll hears both, the window flushes into this live run
		});
		session.useTasks(manager, { windowMs: 30 });
		const events = await drain(session.run("go"));
		const notices = inputs(events).filter((e) => e.via?.kind === "tasks");
		expect(notices).toHaveLength(1);
		expect(notices[0]!.source).toBe("system");
		expect(notices[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "failed" }] });
		expect(notices[0]!.content).toMatch(/<kiso-task id="t1" status="exited" code="0"[\s\S]*<kiso-task id="t2" status="failed" code="2"[\s\S]*Runtime notice — not the user\.$/);
		// a later run carries no repeat
		const later = await drain(session.run("again"));
		expect(inputs(later).filter((e) => e.via?.kind === "tasks")).toEqual([]);
		manager.close();
	});
});

describe("ADR-0058 §8 — an idle session: wake, notify, the switch, lineage", () => {
	it("a one-shot's end in an idle session asks for ONE wake; a service's ready line only notifies", async () => {
		const { session, manager } = await setup([END]);
		const wakes: { content: string; via: UserInputVia }[] = [];
		session.useTasks(manager, { windowMs: 20, onWake: (w) => void wakes.push(w) });
		const svc = await manager.start({ command: "serve", cwd: "/", profile: "service", readyWhen: "up", executionId: "ex-s" });
		appendRecord(join(manager.root, svc.id, "journal.jsonl"), { type: "ready", ts: Date.now(), match: "up" });
		await sleep(120);
		expect(wakes).toEqual([]); // ready: notify, held for the next run
		const job = await manager.start({ command: "npm test", cwd: "/", executionId: "ex-j" });
		end(manager, job.id);
		await sleep(120);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "ready" }, { taskId: "t2", transition: "exited" }] });
		manager.close();
	});

	it("the switch: with wake off, the end rides the next run the person starts, after the person's words", async () => {
		const { session, manager } = await setup([END]);
		let woke = false;
		session.useTasks(manager, { windowMs: 20, wake: false, onWake: () => void (woke = true) });
		const job = await manager.start({ command: "npm test", cwd: "/", executionId: "ex-j" });
		end(manager, job.id);
		await sleep(120);
		expect(woke).toBe(false);
		const landed = inputs(await drain(session.run("what now?")));
		expect(landed.map((e) => e.source ?? "user")).toEqual(["user", "system"]);
		expect(landed[1]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] });
		manager.close();
	});

	it("the chain (ADR-0058 Amendment 9, overturning guard 3): a task started inside a wake run wakes again — until the budget is spent", async () => {
		let started = "";
		const { session, manager } = await setup([TOOL, END], async (ctx, m) => {
			started = (await m.start({ command: "b", cwd: "/", ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}) })).id;
		});
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 20, onWake: (w) => void wakes.push(w) });
		// the wake run itself: its first input is a task notice
		const via: UserInputVia = { kind: "tasks", items: [{ taskId: "t0", transition: "exited" }] };
		await drain(session.run('<kiso-task id="t0" status="exited"/>\nRuntime notice — not the user.', { source: "system", via }));
		end(manager, started);
		await sleep(120);
		expect(wakes).toHaveLength(1); // one wake run so far, budget 20: the chain continues
		manager.close();
	});

	it("the budget: with maxWakes 1 and one wake run already in the log, the next end only notifies", async () => {
		let started = "";
		const { session, manager } = await setup([TOOL, END], async (ctx, m) => {
			started = (await m.start({ command: "b", cwd: "/", ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}) })).id;
		});
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 20, maxWakes: 1, onWake: (w) => void wakes.push(w) });
		const via: UserInputVia = { kind: "tasks", items: [{ taskId: "t0", transition: "exited" }] };
		await drain(session.run('<kiso-task id="t0" status="exited"/>\nRuntime notice — not the user.', { source: "system", via }));
		end(manager, started);
		await sleep(120);
		expect(wakes).toEqual([]); // the one allowed wake is the run above
		manager.close();
	});
});

describe("ADR-0058 §6/§8 — a restart delivers what ended meanwhile as a notify, never a wake", () => {
	it("ended tasks without a receipt ride the next person run; no wake at startup", async () => {
		const { session, manager } = await setup([END]);
		const job = await manager.start({ command: "npm test", cwd: "/", executionId: "ex-j" });
		manager.close(); // the old process is gone
		end(manager, job.id); // the runner finished while nobody listened
		const restarted = new TaskManager({ root: manager.root, backend: fakeBackend(), pollMs: 10 });
		let woke = false;
		session.useTasks(restarted, { windowMs: 20, onWake: () => void (woke = true) });
		await sleep(80);
		expect(woke).toBe(false);
		const landed = inputs(await drain(session.run("hi")));
		expect(landed.filter((e) => e.via?.kind === "tasks").map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] }]);
		restarted.close();
	});
});

describe("ADR-0058 §7 — a summary tells only what the model was told", () => {
	it("a task that ended but was never delivered is still 'running' in the snapshot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-snapshot-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend() });
		const job = await manager.start({ command: "npm test", cwd: "/", executionId: "ex-7" });
		end(manager, job.id);
		const delivery = new TaskDelivery({ manager, events: () => [], liveRun: () => undefined });
		const started = { seq: 3, type: "tool_execution_started", executionId: "ex-7" } as unknown as Event;
		const result = { seq: 4, type: "tool_result", callId: "c", content: "started background task t1.", isError: false, executionId: "ex-7" } as unknown as Event;
		expect(delivery.snapshot([started, result])).toBe("Background tasks, as you were last told: t1 running — npm test.");
		const told = { seq: 9, type: "user_input", content: "n", source: "system", via: { kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] } } as unknown as Event;
		expect(delivery.snapshot([started, result, told])).toBe("Background tasks, as you were last told: t1 exited — npm test.");
		expect(delivery.snapshot([])).toBe(""); // the model never saw it start
		delivery.close();
		manager.close();
	});

	it("a start the model was never told of is not in the snapshot: no result yet, or a result that failed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-snapshot-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend() });
		await manager.start({ command: "npm test", cwd: "/", executionId: "ex-7" });
		const delivery = new TaskDelivery({ manager, events: () => [], liveRun: () => undefined });
		// the crash window: the execution started, its result was never written
		const started = { seq: 3, type: "tool_execution_started", executionId: "ex-7" } as unknown as Event;
		expect(delivery.snapshot([started])).toBe("");
		// resolved after the crash: the model was told the attempt is NOT applied
		const resolved = { seq: 5, type: "tool_result", callId: "c", content: "interrupted execution — rerun approved", isError: true, errorKind: "precondition", executionId: "ex-7" } as unknown as Event;
		expect(delivery.snapshot([started, resolved])).toBe("");
		delivery.close();
		manager.close();
	});
});

describe("ADR-0058 (3c) — a notice the run could not admit is handed back and wakes once it settled", () => {
	it("maxTurns seals the run with the notice pending; the wake follows after the run settled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-delivery-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10 });
		const work = defineTool({
			name: "work",
			description: "W",
			parameters: { type: "object" },
			execute: async () => {
				const job = await manager.start({ command: "npm test", cwd: "/", executionId: "ex-late" });
				end(manager, job.id);
				await sleep(120);
				return { content: "worked", isError: false };
			},
		});
		const session: AgentSession = await createAgent({ model: "faux", store: new SessionStore(dir), tools: [work], adapter: createFauxProvider([TOOL, END]), maxTurns: 1 }).session({ id: "s" });
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 20, onWake: (w) => void wakes.push(w) });
		const events = await drain(session.run("go"));
		expect(inputs(events).filter((e) => e.via?.kind === "tasks")).toEqual([]); // maxTurns won: not admitted
		await sleep(30);
		expect(wakes).toHaveLength(1); // handed back, and the wake came after the settle
		manager.close();
	});
});
