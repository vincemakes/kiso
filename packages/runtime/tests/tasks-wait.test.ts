/**
 * ADR-0059 release 1 — `wait`: a run may end on a future event and resume
 * on it. A wait is a task (owner ruling 2026-10-05): profile `wait`, its
 * terminal is the event (`wait_fired`) or the deadline (`wait_expired`),
 * and everything downstream — journal, delivery, exactly-once, the task
 * row, `task_stop` — is ADR-0058's as it stands.
 *
 * The stated deviation this file pins: `via.items[].transition` is core's
 * closed union, so a fired wait rides as `exited` and an expired one as
 * `failed`; the notice's own line says `fired` / `expired` / `stopped`.
 *
 * Red on 0.46.0 by design — every `it` below names the rule it adds.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool, type Event, type ToolContext, type UserInputVia } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type AgentSession, type Run } from "../src/index.js";
import { appendRecord, readRecords, verdictOf, type TaskRecord } from "../src/tasks/journal.js";
import { TaskManager, type TaskBackend, type WaitDriver } from "../src/tasks/manager.js";

const TOOL = { events: [{ type: "tool_call_end" as const, callId: "c1", name: "work", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] };
const END = { events: [{ type: "text_delta" as const, text: "ok" }, { type: "stop" as const, reason: "end_turn" as const }] };
const FOOTER = /Runtime notice — not the user\.$/;

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

/** A driver the test fires by hand: `kind: "fake"`. */
function fakeDriver(): WaitDriver & { fire: (eventId: string, payload?: unknown) => void; armed: number } {
	let resolve: ((v: { eventId: string; payload: unknown }) => void) | null = null;
	const d = {
		kind: "fake",
		armed: 0,
		arm: (_wait: unknown, _signal: AbortSignal) =>
			new Promise<{ eventId: string; payload: unknown }>((r) => {
				d.armed += 1;
				resolve = r;
			}),
		fire: (eventId: string, payload: unknown = {}) => resolve?.({ eventId, payload }),
	};
	return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inputs = (events: readonly Event[]) => events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input");
const records = (m: TaskManager, id: string) => readRecords(join(m.root, id, "journal.jsonl"));

async function setup(script: FauxScript, during?: (ctx: ToolContext, m: TaskManager) => Promise<void>, drivers: readonly WaitDriver[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-wait-"));
	const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10, drivers });
	const work = defineTool({
		name: "work",
		description: "W",
		parameters: { type: "object" },
		execute: async (_i, ctx) => {
			await during?.(ctx, manager);
			return { content: "worked", isError: false };
		},
	});
	const session: AgentSession = await createAgent({ model: "faux", store: new SessionStore(dir), tools: [work], adapter: createFauxProvider(script) }).session({ id: "s" });
	return { session, manager, dir };
}

async function drain(run: Run): Promise<Event[]> {
	const out: Event[] = [];
	for await (const ev of run) out.push(ev);
	return out;
}

const WAKE_NOTICE = '<kiso-task id="t0" status="exited"/>\nRuntime notice — not the user.';
const WAKE_VIA: UserInputVia = { kind: "tasks", items: [{ taskId: "t0", transition: "exited" }] };

describe("ADR-0059 §2.1 — the journal's verdict for a wait, pure", () => {
	const now = 1_000_000;
	const planned: TaskRecord = {
		type: "planned",
		ts: now,
		taskId: "t1",
		backend: "process",
		command: "timer 50ms",
		cwd: "/",
		profile: "wait",
		executionId: "ex-1",
		wait: { source: { kind: "timer", ms: 50 }, deadlineAt: now + 50 },
	};
	it("planned, no terminal → waiting, carrying the source and the deadline", () => {
		expect(verdictOf([planned], false, now)).toEqual({ kind: "waiting", source: { kind: "timer", ms: 50 }, deadlineAt: now + 50 });
	});
	it("wait_fired → ended, fired, with the event's identity and payload; exit code and signal are null", () => {
		const fired: TaskRecord = { type: "wait_fired", ts: now + 50, eventId: "e1", payload: { firedAt: now + 50 } };
		expect(verdictOf([planned, fired], false, now + 60)).toEqual({ kind: "ended", exitCode: null, signal: null, stopped: false, wait: { outcome: "fired", eventId: "e1", payload: { firedAt: now + 50 } } });
	});
	it("wait_expired → ended, expired", () => {
		const expired: TaskRecord = { type: "wait_expired", ts: now + 50 };
		expect(verdictOf([planned, expired], false, now + 60)).toEqual({ kind: "ended", exitCode: null, signal: null, stopped: false, wait: { outcome: "expired" } });
	});
	it("a stop is a stop: stop_requested + terminal → ended, stopped — never fired", () => {
		const stop: TaskRecord = { type: "stop_requested", ts: now + 10, by: "model" };
		const terminal: TaskRecord = { type: "terminal", ts: now + 11, exitCode: null, signal: null };
		expect(verdictOf([planned, stop, terminal], false, now + 60)).toEqual({ kind: "ended", exitCode: null, signal: null, stopped: true });
	});
	it("a wait never reads unknown: no runner, no identity — the record set alone decides", () => {
		expect(verdictOf([planned], true, now + 10_000)).toEqual({ kind: "waiting", source: { kind: "timer", ms: 50 }, deadlineAt: now + 50 });
	});
});

describe("ADR-0059 §2 — a timer wait ends the run and wakes it once (spec §7 item 1)", () => {
	it("the run ends with the wait registered; the session is idle; ONE wake run starts, its first input the fired notice", async () => {
		let waitId = "";
		const { session, manager } = await setup([TOOL, END], async (ctx, m) => {
			waitId = (await m.wait({ source: { kind: "timer", ms: 60 }, executionId: ctx.executionId! })).id;
		});
		const wakes: { content: string; via: UserInputVia }[] = [];
		session.useTasks(manager, { windowMs: 10, onWake: (w) => void wakes.push(w) });
		const events = await drain(session.run("go"));
		expect(events.at(-1)).toMatchObject({ type: "terminal" });
		expect(manager.get(waitId)!.profile).toBe("wait");
		expect(manager.get(waitId)!.state).toMatchObject({ kind: "waiting", source: { kind: "timer", ms: 60 } });
		expect(wakes).toEqual([]); // nothing fired yet — and no model call either
		await sleep(200);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: waitId, transition: "exited" }] });
		expect(wakes[0]!.content).toMatch(new RegExp(`^<kiso-wait id="${waitId}" status="fired" kind="timer"[^>]*/>\\n`));
		expect(wakes[0]!.content).toMatch(FOOTER);
		expect(records(manager, waitId).filter((r) => r.type === "wait_fired")).toHaveLength(1);
		manager.close();
	});
});

describe("ADR-0059 §3.3 — the chain: a wait inside a wake run wakes again; the budget bounds it (spec §7 items 3 and 4)", () => {
	it("overturns ADR-0058 §8 guard 3: a wait registered inside a wake run wakes when it fires", async () => {
		const { session, manager } = await setup([TOOL, END], async (ctx, m) => {
			await m.wait({ source: { kind: "timer", ms: 40 }, executionId: ctx.executionId! });
		});
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 10, onWake: (w) => void wakes.push(w) });
		// the wake run itself: its first input is a task notice
		await drain(session.run(WAKE_NOTICE, { source: "system", via: WAKE_VIA }));
		await sleep(200);
		expect(wakes).toHaveLength(1); // depth 1 no longer stops the chain
		manager.close();
	});

	it("maxWakes: past the budget the terminal delivers notify, and the next person's run carries it", async () => {
		const { session, manager } = await setup([TOOL, END, END], async (ctx, m) => {
			await m.wait({ source: { kind: "timer", ms: 40 }, executionId: ctx.executionId! });
		});
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 10, maxWakes: 0, onWake: (w) => void wakes.push(w) });
		await drain(session.run(WAKE_NOTICE, { source: "system", via: WAKE_VIA }));
		await sleep(200);
		expect(wakes).toEqual([]); // budget 0: never a wake
		const landed = inputs(await drain(session.run("what now?")));
		expect(landed.map((e) => e.source ?? "user")).toEqual(["user", "system"]);
		expect(landed[1]!.via).toEqual({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] });
		expect(landed[1]!.content).toMatch(/chain budget spent/);
		manager.close();
	});
});

describe("ADR-0059 §2.1 — expiry and stop (spec §7 items 5 and 7)", () => {
	it("a wait past its deadline delivers expired — never silent — and wakes like any terminal", async () => {
		const driver = fakeDriver();
		let waitId = "";
		const { session, manager } = await setup(
			[TOOL, END],
			async (ctx, m) => {
				waitId = (await m.wait({ source: { kind: "fake" }, deadlineMs: 40, executionId: ctx.executionId! })).id;
			},
			[driver],
		);
		const wakes: { content: string; via: UserInputVia }[] = [];
		session.useTasks(manager, { windowMs: 10, onWake: (w) => void wakes.push(w) });
		await drain(session.run("go"));
		expect(driver.armed).toBe(1);
		await sleep(200);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.via).toEqual({ kind: "tasks", items: [{ taskId: waitId, transition: "failed" }] });
		expect(wakes[0]!.content).toMatch(new RegExp(`^<kiso-wait id="${waitId}" status="expired" kind="fake"`));
		expect(records(manager, waitId).map((r) => r.type)).toEqual(["planned", "wait_expired"]);
		manager.close();
	});

	it("task_stop on a wait: stop_requested then terminal, state ended+stopped, the driver aborted, and never a wake", async () => {
		const driver = fakeDriver();
		let waitId = "";
		const { session, manager } = await setup(
			[TOOL, END, END],
			async (ctx, m) => {
				waitId = (await m.wait({ source: { kind: "fake" }, executionId: ctx.executionId! })).id;
			},
			[driver],
		);
		const wakes: unknown[] = [];
		session.useTasks(manager, { windowMs: 10, onWake: (w) => void wakes.push(w) });
		await drain(session.run("go"));
		expect(manager.stop(waitId, "model")).toBe(true);
		await sleep(100);
		expect(records(manager, waitId).map((r) => r.type)).toEqual(["planned", "stop_requested", "terminal"]);
		expect(manager.get(waitId)!.state).toEqual({ kind: "ended", exitCode: null, signal: null, stopped: true });
		expect(wakes).toEqual([]);
		driver.fire("late"); // the driver resolving after the stop changes nothing
		await sleep(50);
		expect(records(manager, waitId).filter((r) => r.type === "wait_fired")).toEqual([]);
		const landed = inputs(await drain(session.run("and?")));
		expect(landed[1]!.via).toEqual({ kind: "tasks", items: [{ taskId: waitId, transition: "stopped" }] });
		manager.close();
	});
});

describe("ADR-0059 §6 — the crash rows W2, W4, W5", () => {
	it("W2 — kill while waiting on a timer: the restart re-arms it from the journal; overdue fires ONCE and rides the next person's run as a notify", async () => {
		const { session, manager } = await setup([END]);
		const w = await manager.wait({ source: { kind: "timer", ms: 30 }, executionId: "ex-w" });
		manager.close(); // the process died: its timer with it
		await sleep(80); // the deadline passes while nobody is alive
		expect(records(manager, w.id).map((r) => r.type)).toEqual(["planned"]);
		const restarted = new TaskManager({ root: manager.root, backend: fakeBackend(), pollMs: 10 });
		let woke = false;
		session.useTasks(restarted, { windowMs: 10, onWake: () => void (woke = true) });
		await sleep(100);
		expect(records(restarted, w.id).map((r) => r.type)).toEqual(["planned", "wait_fired"]);
		expect(woke).toBe(false); // the restart rule: never a wake at startup
		const landed = inputs(await drain(session.run("hi")));
		expect(landed.filter((e) => e.via?.kind === "tasks").map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: w.id, transition: "exited" }] }]);
		const later = inputs(await drain(session.run("again")));
		expect(later.filter((e) => e.via?.kind === "tasks")).toEqual([]);
		restarted.close();
	});

	it("W4 — the terminal landed, the delivery did not: delivered once on restart, never twice", async () => {
		const driver = fakeDriver();
		const { session, manager } = await setup([END, END], undefined, [driver]);
		const w = await manager.wait({ source: { kind: "fake" }, executionId: "ex-w" });
		driver.fire("e1", { a: 1 });
		await sleep(50);
		expect(records(manager, w.id).map((r) => r.type)).toEqual(["planned", "wait_fired"]);
		manager.close(); // died before any delivery existed
		const restarted = new TaskManager({ root: manager.root, backend: fakeBackend(), pollMs: 10, drivers: [fakeDriver()] });
		let woke = false;
		session.useTasks(restarted, { windowMs: 10, onWake: () => void (woke = true) });
		await sleep(60);
		expect(woke).toBe(false);
		const landed = inputs(await drain(session.run("hi")));
		expect(landed.filter((e) => e.via?.kind === "tasks").map((e) => e.via)).toEqual([{ kind: "tasks", items: [{ taskId: w.id, transition: "exited" }] }]);
		expect(inputs(await drain(session.run("again"))).filter((e) => e.via?.kind === "tasks")).toEqual([]);
		restarted.close();
	});

	it("W5 — the same event observed twice is one terminal: identity dedupes", async () => {
		const driver = fakeDriver();
		const dir = mkdtempSync(join(tmpdir(), "kiso-wait-"));
		const manager = new TaskManager({ root: join(dir, "s.tasks"), backend: fakeBackend(), pollMs: 10, drivers: [driver] });
		const w = await manager.wait({ source: { kind: "fake" }, executionId: "ex-w" });
		driver.fire("e1");
		await sleep(30);
		driver.fire("e1");
		await sleep(30);
		expect(records(manager, w.id).filter((r) => r.type === "wait_fired")).toHaveLength(1);
		manager.close();
	});
});
