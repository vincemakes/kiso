/**
 * ADR-0058 §6 — the journal's verdict table, pure, and the TaskManager
 * over a fake backend (the real processes are tools-node's
 * tasks-process.test.ts).
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRecord, readRecords, RUNNER_START_WINDOW_MS, TaskJournalCorruptError, verdictOf, type TaskRecord } from "../src/tasks/journal.js";
import { TaskManager, type TaskBackend, type TaskTransition } from "../src/tasks/manager.js";

const now = 1_000_000;
const planned: TaskRecord = { type: "planned", ts: now, taskId: "t1", backend: "process", command: "x", cwd: "/", profile: "oneshot" };
const runner: TaskRecord = { type: "runner_started", ts: now, pid: 42, startedAt: "Mon" };
const started: TaskRecord = { type: "command_started", ts: now };

describe("ADR-0058 §6 — the verdict table", () => {
	it("no planned → not_run", () => {
		expect(verdictOf([], false, now)).toEqual({ kind: "not_run" });
	});
	it("planned alone → starting within the window, not_run after it", () => {
		expect(verdictOf([planned], false, now + 10)).toEqual({ kind: "starting" });
		expect(verdictOf([planned], false, now + RUNNER_START_WINDOW_MS + 1)).toEqual({ kind: "not_run" });
	});
	it("runner_started, no command_started → starting while the runner lives, not_run once it is gone", () => {
		expect(verdictOf([planned, runner], true, now)).toEqual({ kind: "starting" });
		expect(verdictOf([planned, runner], false, now)).toEqual({ kind: "not_run" });
	});
	it("command_started, no terminal → running while verified alive, unknown once gone", () => {
		expect(verdictOf([planned, runner, started], true, now)).toEqual({ kind: "running", ready: false });
		expect(verdictOf([planned, runner, started, { type: "ready", ts: now, match: "ok" }], true, now)).toEqual({ kind: "running", ready: true });
		expect(verdictOf([planned, runner, started], false, now)).toEqual({ kind: "unknown" });
	});
	it("terminal → ended as recorded, stopped when a stop was asked for", () => {
		const terminal: TaskRecord = { type: "terminal", ts: now, exitCode: null, signal: "SIGTERM" };
		expect(verdictOf([planned, runner, started, { type: "stop_requested", ts: now, by: "person" }, terminal], false, now)).toEqual({
			kind: "ended",
			exitCode: null,
			signal: "SIGTERM",
			stopped: true,
		});
	});
	it("terminal with an error → ended, carrying why the command never ran", () => {
		const terminal: TaskRecord = { type: "terminal", ts: now, exitCode: null, signal: null, error: "spawn bash ENOENT" };
		expect(verdictOf([planned, runner, started, terminal], false, now)).toEqual({ kind: "ended", exitCode: null, signal: null, stopped: false, error: "spawn bash ENOENT" });
	});
	it("a torn last line is dropped, never guessed at", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-journal-"));
		const file = join(dir, "journal.jsonl");
		appendRecord(file, planned);
		appendFileSync(file, '{"type":"runner_sta');
		expect(readRecords(file)).toEqual([planned]);
	});
	it("a bad line anywhere but the tail is corruption — it fails loudly, never skipped", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-journal-"));
		const file = join(dir, "journal.jsonl");
		appendRecord(file, planned);
		appendFileSync(file, '{"type":"command_sta\n');
		appendRecord(file, { type: "terminal", ts: now, exitCode: 0, signal: null });
		expect(() => readRecords(file)).toThrow(TaskJournalCorruptError);
	});
});

/** A backend with no processes: `spawn` writes what a runner would. */
function fakeBackend(): TaskBackend & { live: Set<number>; unverifiable: Set<number>; stopped: number[] } {
	let pid = 100;
	const live = new Set<number>();
	const unverifiable = new Set<number>();
	const stopped: number[] = [];
	return {
		live,
		unverifiable,
		stopped,
		async spawn({ dir }) {
			pid += 1;
			live.add(pid);
			appendRecord(join(dir, "journal.jsonl"), { type: "runner_started", ts: Date.now(), pid, startedAt: `start-${pid}` });
			appendRecord(join(dir, "journal.jsonl"), { type: "command_started", ts: Date.now() });
		},
		identify: (p, startedAt) => (!live.has(p) ? "gone" : unverifiable.has(p) ? "unverifiable" : startedAt === `start-${p}` ? "verified" : "gone"),
		signalStop: (p) => void stopped.push(p),
	};
}

describe("ADR-0058 §6 — the TaskManager", () => {
	it("stop is durable before the signal, and false when nothing is live", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		const m = new TaskManager({ root, backend });
		const t = await m.start({ command: "sleep 9", cwd: "/" });
		expect(m.stop(t.id, "model")).toBe(true);
		expect(readRecords(join(root, t.id, "journal.jsonl")).map((r) => r.type)).toEqual(["planned", "runner_started", "command_started", "stop_requested"]);
		expect(backend.stopped).toHaveLength(1);
		backend.live.clear();
		expect(m.stop(t.id, "model")).toBe(false);
		m.close();
	});

	it("reports each transition once: ready, then ended; a vanished runner is unknown", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		const seen: [string, TaskTransition][] = [];
		const m = new TaskManager({ root, backend, pollMs: 20, onTransition: (t, tr) => void seen.push([t.id, tr]) });
		const a = await m.start({ command: "serve", cwd: "/", profile: "service", readyWhen: "up" });
		const b = await m.start({ command: "build", cwd: "/" });
		appendRecord(join(root, a.id, "journal.jsonl"), { type: "ready", ts: Date.now(), match: "up" });
		appendRecord(join(root, b.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		await new Promise((r) => setTimeout(r, 120));
		backend.live.clear(); // a's runner vanishes without a terminal
		await new Promise((r) => setTimeout(r, 120));
		m.close();
		expect(seen).toEqual([
			["t1", "ready"],
			["t2", "ended"],
			["t1", "unknown"],
		]);
	});

	it("adopt: a running foreground command becomes a task its owner stops — the owner's pid is never signalled", () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		backend.live.add(4242);
		const m = new TaskManager({ root, backend });
		let stops = 0;
		const t = m.adopt({ command: "npm test", cwd: "/", executionId: "ex-9", runner: { pid: 4242, startedAt: "start-4242" }, stop: () => void (stops += 1) });
		expect(readRecords(join(root, t.id, "journal.jsonl")).map((r) => r.type)).toEqual(["planned", "runner_started", "command_started"]);
		expect(readRecords(join(root, t.id, "journal.jsonl"))[0]).toMatchObject({ backend: "foreground", executionId: "ex-9", profile: "oneshot" });
		expect(m.get(t.id)!.state).toEqual({ kind: "running", ready: false });
		expect(m.stop(t.id, "model")).toBe(true);
		expect(stops).toBe(1);
		expect(backend.stopped).toEqual([]); // never a signal to the owner
		t.ended(null, "SIGTERM");
		expect(m.get(t.id)!.state).toEqual({ kind: "ended", exitCode: null, signal: "SIGTERM", stopped: true });
		expect(m.stop(t.id, "model")).toBe(false);
		m.close();
	});

	it("adopt: the real exit code lands; a ready line is recorded once", () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		backend.live.add(4242);
		const m = new TaskManager({ root, backend });
		const t = m.adopt({ command: "serve", cwd: "/", readyWhen: "up", runner: { pid: 4242, startedAt: "start-4242" }, stop: () => {} });
		t.ready("up");
		t.ready("up");
		t.ended(3, null);
		const types = readRecords(join(root, t.id, "journal.jsonl")).map((r) => r.type);
		expect(types.filter((x) => x === "ready")).toHaveLength(1);
		expect(m.get(t.id)!.state).toEqual({ kind: "ended", exitCode: 3, signal: null, stopped: false });
		m.close();
	});

	it("adopt: when the owner is gone without a terminal — a crash, or a stop it could not confirm — the task is unknown, and nothing can stop it", () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		backend.live.add(4242);
		const m = new TaskManager({ root, backend });
		const a = m.adopt({ command: "a", cwd: "/", runner: { pid: 4242, startedAt: "start-4242" }, stop: () => {} });
		const b = m.adopt({ command: "b", cwd: "/", runner: { pid: 4242, startedAt: "start-4242" }, stop: () => {} });
		b.unconfirmed([777]);
		m.close();
		backend.live.clear(); // the owning kiso is gone
		const fresh = new TaskManager({ root, backend });
		expect(fresh.get(a.id)!.state.kind).toBe("unknown");
		expect(fresh.get(b.id)!.state.kind).toBe("unknown");
		expect(readRecords(join(root, b.id, "journal.jsonl")).map((r) => r.type)).toContain("stop_unconfirmed");
		expect(fresh.stop(a.id, "model")).toBe(false);
	});

	it("an identity that cannot be verified is never read as the runner: unknown, and a stop is only requested — no signal", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		const m = new TaskManager({ root, backend });
		const t = await m.start({ command: "sleep 9", cwd: "/" });
		backend.unverifiable.add(101); // the pid is live; whose it is cannot be told
		expect(m.get(t.id)!.state.kind).toBe("unknown");
		expect(m.stop(t.id, "person")).toBe(true); // the runner, if it is ours, reads the journal
		expect(readRecords(join(root, t.id, "journal.jsonl")).map((r) => r.type)).toContain("stop_requested");
		expect(backend.stopped).toEqual([]); // never a signal to a pid that may be a stranger's
		m.close();
	});

	it("an adopted task this process still owns is running even when its owner's start time was unreadable", () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		backend.live.add(4242);
		backend.unverifiable.add(4242);
		const m = new TaskManager({ root, backend });
		const t = m.adopt({ command: "x", cwd: "/", runner: { pid: 4242, startedAt: "" }, stop: () => {} });
		expect(m.get(t.id)!.state.kind).toBe("running");
		m.close();
		// a new manager (another process) cannot verify it: the gone row
		expect(new TaskManager({ root, backend }).get(t.id)!.state.kind).toBe("unknown");
	});

	it("subscribe: every listener hears each transition; unsubscribing stops it", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		const m = new TaskManager({ root, backend, pollMs: 20 });
		const a: string[] = [];
		const b: string[] = [];
		m.subscribe((t, tr) => void a.push(`${t.id}:${tr}`));
		const off = m.subscribe((t, tr) => void b.push(`${t.id}:${tr}`));
		const t1 = await m.start({ command: "x", cwd: "/" });
		appendRecord(join(root, t1.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		await new Promise((r) => setTimeout(r, 120));
		off();
		const t2 = await m.start({ command: "y", cwd: "/" });
		appendRecord(join(root, t2.id, "journal.jsonl"), { type: "terminal", ts: Date.now(), exitCode: 0, signal: null });
		await new Promise((r) => setTimeout(r, 120));
		m.close();
		expect(a).toEqual(["t1:ended", "t2:ended"]);
		expect(b).toEqual(["t1:ended"]);
	});

	it("TaskInfo carries what delivery needs: the executionId, the backend, and who stopped it", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		const backend = fakeBackend();
		backend.live.add(4242);
		const m = new TaskManager({ root, backend });
		const p = await m.start({ command: "x", cwd: "/", executionId: "ex-3" });
		expect(m.get(p.id)).toMatchObject({ executionId: "ex-3", backend: "process" });
		const f = m.adopt({ command: "y", cwd: "/", executionId: "ex-4", runner: { pid: 4242, startedAt: "start-4242" }, stop: () => {} });
		m.stop(f.id, "model");
		f.ended(null, "SIGTERM");
		expect(m.get(f.id)).toMatchObject({ executionId: "ex-4", backend: "foreground", stoppedBy: "model" });
		m.close();
	});

	it("a directory without a journal is not a task", () => {
		const root = join(mkdtempSync(join(tmpdir(), "kiso-mgr-")), "s.tasks");
		mkdirSync(join(root, "t1"), { recursive: true });
		writeFileSync(join(root, "notes.txt"), "");
		const m = new TaskManager({ root, backend: fakeBackend() });
		expect(m.get("t1")).toBeUndefined();
		expect(m.get("notes.txt")).toBeUndefined();
	});
});
