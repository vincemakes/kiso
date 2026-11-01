/**
 * ADR-0058 Amendment 17 — an adopted task's owner is the kiso itself, so it is
 * alive when a stop cannot be confirmed or a hand-over fails. The verdict then
 * must not read "running": the command's end is not known (`unknown`), no
 * terminal is invented, and each transition is heard once.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRecords, verdictOf, type TaskRecord } from "../src/tasks/journal.js";
import { TaskManager, type TaskBackend, type TaskTransition } from "../src/tasks/manager.js";

const now = 1_000_000;
const planned: TaskRecord = { type: "planned", ts: now, taskId: "t1", backend: "foreground", command: "x", cwd: "/", profile: "oneshot" };
const runner: TaskRecord = { type: "runner_started", ts: now, pid: 42, startedAt: "Mon" };
const started: TaskRecord = { type: "command_started", ts: now };

/** the owner (this process) is alive and verified */
const backend: TaskBackend = {
	async spawn() {},
	identify: () => "verified",
	signalStop: () => {},
};

function setup() {
	const root = join(mkdtempSync(join(tmpdir(), "kiso-unk-")), "s.tasks");
	const manager = new TaskManager({ root, backend, pollMs: 25 });
	const heard: { id: string; transition: TaskTransition }[] = [];
	manager.subscribe((info, transition) => heard.push({ id: info.id, transition }));
	const adopt = (stop: () => void = () => {}) => manager.adopt({ command: "x", cwd: "/", runner: { pid: process.pid, startedAt: "s" }, startedAt: Date.now(), stop });
	return { root, manager, heard, adopt };
}
const types = (root: string, id: string) => readRecords(join(root, id, "journal.jsonl")).map((r) => r.type);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the verdict of an adopted task whose owner lives", () => {
	it("a stop that left survivors, or a failed hand-over, is unknown — not running — even with the owner alive", () => {
		expect(verdictOf([planned, runner, started], true, now)).toEqual({ kind: "running", ready: false });
		expect(verdictOf([planned, runner, started, { type: "stop_unconfirmed", ts: now, pids: [] }], true, now)).toEqual({ kind: "unknown" });
		expect(verdictOf([planned, runner, started, { type: "handover_failed", ts: now, reason: "EACCES" }], true, now)).toEqual({ kind: "unknown" });
	});
	it("a failed hand-over is never not_run: the command was started", () => {
		const records: TaskRecord[] = [planned, runner, started, { type: "handover_failed", ts: now, reason: "x" }];
		expect(verdictOf(records, false, now)).toEqual({ kind: "unknown" });
		expect(verdictOf(records, true, now)).not.toEqual({ kind: "not_run" });
	});
	it("an end that is recorded still wins: a terminal after the unconfirmed stop is ended", () => {
		const terminal: TaskRecord = { type: "terminal", ts: now, exitCode: 0, signal: null };
		expect(verdictOf([planned, runner, started, { type: "stop_unconfirmed", ts: now, pids: [9] }, terminal], true, now).kind).toBe("ended");
	});
});

describe("the TaskManager", () => {
	it("unconfirmed(): unknown at once, no terminal, nothing left to stop, and a later ended() cannot make it ended", () => {
		const { root, manager, adopt } = setup();
		const a = adopt();
		expect(manager.get(a.id)!.state.kind).toBe("running");
		a.unconfirmed([]);
		expect(manager.get(a.id)!.state.kind).toBe("unknown");
		expect(types(root, a.id)).not.toContain("terminal");
		expect(manager.stop(a.id, "model")).toBe(false);
		a.ended(0, null);
		expect(types(root, a.id)).not.toContain("terminal");
		manager.close();
	});

	it("handoverFailed(): unknown with the reason on record, no terminal, once", () => {
		const { root, manager, adopt } = setup();
		const a = adopt();
		a.handoverFailed("EACCES: output.log");
		a.handoverFailed("again");
		expect(manager.get(a.id)!.state.kind).toBe("unknown");
		const failed = readRecords(join(root, a.id, "journal.jsonl")).filter((r) => r.type === "handover_failed");
		expect(failed).toEqual([expect.objectContaining({ reason: "EACCES: output.log" })]);
		expect(types(root, a.id)).not.toContain("terminal");
		manager.close();
	});

	it("a transition to unknown is heard exactly once, and a failed hand-over is one notice, not two", async () => {
		const { manager, heard, adopt } = setup();
		const a = adopt();
		const b = adopt();
		a.unconfirmed([]);
		b.handoverFailed("x");
		await sleep(250);
		expect(heard.filter((h) => h.id === a.id)).toEqual([{ id: a.id, transition: "unknown" }]);
		expect(heard.filter((h) => h.id === b.id)).toEqual([{ id: b.id, transition: "unknown" }]);
		manager.close();
	});

	it("task_stop's wait settles on the unknown, claims it for its own execution, and the watcher then says nothing", async () => {
		const { root, manager, heard, adopt } = setup();
		const a = adopt(() => setTimeout(() => a.unconfirmed([]), 50)); // the owner's stop ends unconfirmed
		expect(manager.stop(a.id, "model")).toBe(true);
		const t0 = Date.now();
		const w = await manager.awaitSettled(a.id, "end", 8_000, { executionId: "ex-stop" });
		expect(Date.now() - t0).toBeLessThan(2_000); // not the full wait
		expect(w.settled).toBe(true);
		expect(w.info.state.kind).toBe("unknown");
		expect(w.claimed).toBe(true);
		await sleep(250);
		expect(heard).toEqual([]); // claimed: no second notice
		expect(readRecords(join(root, a.id, "journal.jsonl")).filter((r) => r.type === "result_claimed")).toEqual([expect.objectContaining({ transition: "unknown", executionId: "ex-stop" })]);
		expect(types(root, a.id).filter((x) => x === "stop_requested")).toHaveLength(1);
		manager.close();
	});

	it("an unconfirmed stop that nobody waits for is announced once", async () => {
		const { manager, heard, adopt } = setup();
		const a = adopt(() => setTimeout(() => a.unconfirmed([]), 50));
		manager.stop(a.id, "person");
		await sleep(400);
		expect(heard).toEqual([{ id: a.id, transition: "unknown" }]);
		manager.close();
	});

	it("stopAll does not wait out its grace for a stop that answered unknown, and still reports it", async () => {
		const { manager, adopt } = setup();
		const a = adopt(() => setTimeout(() => a.unconfirmed([]), 50));
		const t0 = Date.now();
		const left = await manager.stopAll("exit", 8_000);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(left).toEqual([a.id]);
		manager.close();
	});
});
