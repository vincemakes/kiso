/**
 * ADR-0058 (3e, Amendment 8) — what the person reads about a task: its
 * state in words (a requested stop is `stopping` until the journal says
 * `stopped`; a task kiso lost track of says so, and why), the `/tasks` row,
 * the running count on the status row, and the transcript row a delivery
 * shows — a lost task as its own `✦ lost track of …` row.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskInfo } from "@vincemakes/kiso-runtime/internal";
import { budgetSpentLine, lostReason, taskCounts, taskNoticeLines, taskOutput, taskRow, taskStateLabel } from "../src/task-notice.js";

const task = (over: Partial<TaskInfo>): TaskInfo => ({ id: "t1", command: "npm test", profile: "oneshot", backend: "process", state: { kind: "running", ready: false }, outputPath: "/nope/output.log", startedAt: 1_000, ...over }) as TaskInfo;

describe("3e — a task in the person's words", () => {
	it("a requested stop is stopping, never stopped before the journal says so", () => {
		expect(taskStateLabel(task({ stoppedBy: "person" }))).toBe("stopping");
		expect(taskStateLabel(task({ stoppedBy: "person", state: { kind: "ended", exitCode: null, signal: "SIGTERM", stopped: true } }))).toBe("stopped");
		expect(taskStateLabel(task({ state: { kind: "unknown" } }))).toBe("lost track — may still be running");
		expect(taskStateLabel(task({ state: { kind: "ended", exitCode: 0, signal: null, stopped: false } }))).toBe("exited 0");
		expect(taskStateLabel(task({ state: { kind: "ended", exitCode: 2, signal: null, stopped: false } }))).toBe("failed 2");
		expect(taskStateLabel(task({ state: { kind: "running", ready: true } }))).toBe("ready");
	});

	it("the /tasks row: id, state, time; the command beside it", () => {
		expect(taskRow(task({ endedAt: 81_000, state: { kind: "ended", exitCode: 0, signal: null, stopped: false } }))).toEqual({ label: "t1  exited 0  1m 20s", note: "npm test" });
	});

	it("a child's output is its answer; a command's is its last lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-notice-"));
		writeFileSync(join(dir, "output.log"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
		expect(taskOutput(task({ outputPath: join(dir, "output.log") }), 3)).toEqual(["line 28", "line 29", "line 30"]);
		writeFileSync(join(dir, "result.md"), "the answer\n");
		expect(taskOutput(task({ outputPath: join(dir, "output.log"), agent: { role: "explorer", session: "s" } }))).toEqual(["the answer"]);
	});

	it("the count: the tasks kiso manages, and only those", () => {
		const list = [task({ id: "t1" }), task({ id: "t2", state: { kind: "starting" } }), task({ id: "t3", state: { kind: "unknown" } }), task({ id: "t4", state: { kind: "unknown" } }), task({ id: "t5", state: { kind: "ended", exitCode: 0, signal: null, stopped: false } })];
		expect(taskCounts(list)).toEqual({ running: 2 });
	});
});

describe("Amendment 8 — the transcript row of a delivery", () => {
	const what = (cmds: Record<string, string>) => (id: string) => cmds[id];
	it("a lost task is its own row; the others keep today's row", () => {
		expect(taskNoticeLines([{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "failed" }])).toEqual(["✦ task t1 exited · t2 failed"]);
		expect(taskNoticeLines([{ taskId: "t3", transition: "unknown" }], what({ t3: "npm run dev" }))).toEqual(["✦ lost track of t3 (npm run dev) — it may still be running · /tasks shows it"]);
		expect(taskNoticeLines([{ taskId: "t1", transition: "exited" }, { taskId: "t3", transition: "unknown" }], what({ t3: "npm run dev" }))).toEqual([
			"✦ task t1 exited",
			"✦ lost track of t3 (npm run dev) — it may still be running · /tasks shows it",
		]);
	});

	it("the row's shape is stable: the opening with or without the command, and the tail as the LAST ` — ` part", () => {
		const [bare] = taskNoticeLines([{ taskId: "t3", transition: "unknown" }]);
		expect(bare).toBe("✦ lost track of t3 — it may still be running · /tasks shows it");
		// a command holding its own parentheses and dashes: the opening is
		// `✦ lost track of <id> (<what>) — ` and the tail is the last ` — ` part
		const cmd = "sh -c 'echo (a) — b' && make — all";
		const [row] = taskNoticeLines([{ taskId: "t9", transition: "unknown" }], what({ t9: cmd }));
		expect(row!.startsWith(`✦ lost track of t9 (${cmd}) — `)).toBe(true);
		expect(row!.slice(row!.lastIndexOf(" — ") + 3).startsWith("it may still be running")).toBe(true);
		// one line, always: a multi-line command shows its first line
		const [multi] = taskNoticeLines([{ taskId: "t4", transition: "unknown" }], what({ t4: "npm run dev\necho done" }));
		expect(multi).not.toContain("\n");
		expect(multi).toContain("(npm run dev)");
	});
});

describe("Amendment 8 — why kiso lost track, read from the journal", () => {
	const journal = (records: object[]) => {
		const dir = join(mkdtempSync(join(tmpdir(), "kiso-lost-")), "t3");
		mkdirSync(dir);
		writeFileSync(join(dir, "journal.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
		return join(dir, "output.log");
	};
	it("a moved command whose owner ended, a stop not confirmed, a runner gone", () => {
		const fg = journal([{ type: "planned", ts: 1, taskId: "t3", backend: "foreground", command: "npm run dev", cwd: "/", profile: "oneshot" }, { type: "command_started", ts: 2 }]);
		expect(lostReason(task({ backend: "foreground", outputPath: fg, state: { kind: "unknown" } }))).toBe("the kiso that held it ended without recording its end");
		const un = journal([{ type: "planned", ts: 1, taskId: "t3", backend: "process", command: "x", cwd: "/", profile: "oneshot" }, { type: "stop_requested", ts: 3, by: "model" }, { type: "stop_unconfirmed", ts: 4, pids: [4123, 4124] }]);
		expect(lostReason(task({ outputPath: un, state: { kind: "unknown" } }))).toBe("its stop could not be confirmed (pids 4123, 4124)");
		const gone = journal([{ type: "planned", ts: 1, taskId: "t3", backend: "process", command: "x", cwd: "/", profile: "oneshot" }, { type: "runner_started", ts: 2, pid: 9, startedAt: "s" }, { type: "command_started", ts: 2 }]);
		expect(lostReason(task({ outputPath: gone, state: { kind: "unknown" } }))).toBe("its runner is gone without recording its end");
		expect(lostReason(task({ state: { kind: "running", ready: false } }))).toBeUndefined();
	});
});

describe("finding 0480-F9 — a spent chain budget, in the person's words", () => {
	it("one row: how many wakes, and that finished tasks wait for the person", () => {
		expect(budgetSpentLine({ wakes: 20 })).toBe("✦ chain budget spent — 20 autonomous wakes since your last message · finished tasks wait for you");
		expect(budgetSpentLine({ wakes: 1 })).toBe("✦ chain budget spent — 1 autonomous wake since your last message · finished tasks wait for you");
	});
});

