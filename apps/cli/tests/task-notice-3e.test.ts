/**
 * ADR-0058 (3e) — what the person reads about a task: its state in words
 * (a requested stop is `stopping` until the journal says `stopped`; an
 * outcome nobody can know says so), the `/tasks` row, and the counts the
 * status row shows (an unknown task the person has looked at drops off).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskInfo } from "@vincemakes/kiso-runtime/internal";
import { taskCounts, taskOutput, taskRow, taskStateLabel } from "../src/task-notice.js";

const task = (over: Partial<TaskInfo>): TaskInfo => ({ id: "t1", command: "npm test", profile: "oneshot", backend: "process", state: { kind: "running", ready: false }, outputPath: "/nope/output.log", startedAt: 1_000, ...over }) as TaskInfo;

describe("3e — a task in the person's words", () => {
	it("a requested stop is stopping, never stopped before the journal says so", () => {
		expect(taskStateLabel(task({ stoppedBy: "person" }))).toBe("stopping");
		expect(taskStateLabel(task({ stoppedBy: "person", state: { kind: "ended", exitCode: null, signal: "SIGTERM", stopped: true } }))).toBe("stopped");
		expect(taskStateLabel(task({ state: { kind: "unknown" } }))).toBe("◌ outcome unknown");
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

	it("the counts: live tasks, and the unknown ones not yet looked at", () => {
		const list = [task({ id: "t1" }), task({ id: "t2", state: { kind: "starting" } }), task({ id: "t3", state: { kind: "unknown" } }), task({ id: "t4", state: { kind: "unknown" } }), task({ id: "t5", state: { kind: "ended", exitCode: 0, signal: null, stopped: false } })];
		expect(taskCounts(list, new Set())).toEqual({ running: 2, unknown: 2 });
		expect(taskCounts(list, new Set(["t3"]))).toEqual({ running: 2, unknown: 1 });
	});
});
