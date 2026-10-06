/**
 * Graphite, the tasks round (owner, 2026-10-06) — what a person sees of a
 * background task besides the bar: the TASK meta rows (one per task, how
 * it ended in one word and its colour, then what ran) and a task's output
 * as a sheet. The words come from the task's own journal; the pipe keeps
 * `taskNoticeRow`'s line and the printed output, byte for byte.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TaskInfo } from "@vincemakes/kiso-runtime/internal";
import { palette, setGround, visibleWidth } from "@vincemakes/kiso-tui";
import { taskNoticeRow, taskNoticeRows, taskOutcome, taskOutputSheetRows, tasksForDisplay } from "../src/task-notice.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const task = (over: Partial<TaskInfo> & { id: string }): TaskInfo =>
	({ command: "for i in 1 2 3; do echo tick $i; sleep 1; done", profile: "default", backend: "process", state: { kind: "ended", exitCode: 0, signal: null, stopped: false }, outputPath: "/tmp/x/output.log", startedAt: 0, endedAt: 3_000, ...over }) as TaskInfo;
const child = (id: string, role: string, words: string, state: TaskInfo["state"] = { kind: "ended", exitCode: 0, signal: null, stopped: false }): TaskInfo => task({ id, command: `${role}: ${words}`, agent: { role, session: `c-${id}` } as never, state });

describe("how a task ended, in one word", () => {
	it("a shell exits or fails; a child answers or fails; stopped is plain; unknown is gold; ready is ready", () => {
		expect(taskOutcome(task({ id: "t1" }), "exited")).toEqual({ word: "exited 0", tone: "ok" });
		expect(taskOutcome(task({ id: "t1", state: { kind: "ended", exitCode: 1, signal: null, stopped: false } }), "failed")).toEqual({ word: "failed 1", tone: "fail" });
		expect(taskOutcome(child("t2", "explorer", "map"), "exited")).toEqual({ word: "answered", tone: "ok" });
		expect(taskOutcome(child("t2", "explorer", "map", { kind: "ended", exitCode: 2, signal: null, stopped: false }), "failed")).toEqual({ word: "failed", tone: "fail" });
		expect(taskOutcome(task({ id: "t1", state: { kind: "ended", exitCode: null, signal: "SIGTERM", stopped: true } }), "stopped")).toEqual({ word: "stopped", tone: null });
		expect(taskOutcome(task({ id: "t1", state: { kind: "unknown" } }), "unknown")).toEqual({ word: "◌ outcome unknown", tone: "gold" });
		expect(taskOutcome(task({ id: "t1", state: { kind: "running", ready: true } }), "ready")).toEqual({ word: "ready", tone: "ok" });
		// no journal entry: the delivery's own word, uncoloured
		expect(taskOutcome(undefined, "exited")).toEqual({ word: "exited", tone: null });
	});
});

describe("the TASK rows", () => {
	it("one row per task — the label once, the id, how it ended (marked), what ran", () => {
		const items = [
			{ taskId: "t1", transition: "exited" as const },
			{ taskId: "t2", transition: "exited" as const },
		];
		expect(taskNoticeRows(items, [child("t1", "explorer", "map the auth flow"), child("t2", "reviewer", "review the plan")])).toEqual([
			{ label: "TASK", sentence: "t1 answered · explorer: map the auth flow", mark: { text: "answered", tone: "ok" } },
			{ label: "", sentence: "t2 answered · reviewer: review the plan", mark: { text: "answered", tone: "ok" } },
		]);
		expect(taskNoticeRows([{ taskId: "t1", transition: "exited" }], [task({ id: "t1" })])[0]).toEqual({ label: "TASK", sentence: "t1 exited 0 · for i in 1 2 3; do echo tick $i; sleep 1; done", mark: { text: "exited 0", tone: "ok" } });
		// stopped carries no mark; an unknown task is gold
		expect(taskNoticeRows([{ taskId: "t1", transition: "stopped" }], [task({ id: "t1", state: { kind: "ended", exitCode: null, signal: "SIGTERM", stopped: true } })])[0]).not.toHaveProperty("mark");
		// a task the journal does not know still gets its row
		expect(taskNoticeRows([{ taskId: "t9", transition: "exited" }], [])).toEqual([{ label: "TASK", sentence: "t9 exited" }]);
	});

	it("the pipe's line is unchanged", () => {
		expect(taskNoticeRow([{ taskId: "t1", transition: "exited" }, { taskId: "t2", transition: "exited" }])).toBe("✦ task t1 exited · t2 exited");
	});

	it("a journal that cannot be read gives no tasks, never an error", () => {
		expect(tasksForDisplay(undefined)).toEqual([]);
		expect(
			tasksForDisplay({
				list: () => {
					throw new Error("corrupt");
				},
			}),
		).toEqual([]);
	});
});

describe("a task's output, as a sheet", () => {
	it("the band names the task, which output, how it ended; the lines; the closing row", () => {
		setGround("light");
		const rows = taskOutputSheetRows(task({ id: "t1" }), ["tick 1", "tick 2", "tick 3"], 80).map(plain);
		expect(rows[0]).toMatch(/^─── t1 · its last output · exited 0 ─+$/);
		expect(rows.slice(1)).toEqual(["  tick 1", "  tick 2", "  tick 3", "  esc closes · typing goes to the input"]);
		expect(plain(taskOutputSheetRows(child("t2", "explorer", "map"), ["auth lives in src/auth"], 80)[0]!)).toMatch(/^─── t2 · its answer · answered ─+$/);
		expect(plain(taskOutputSheetRows(task({ id: "t3", state: { kind: "running", ready: false } }), [], 80)[0]!)).toMatch(/^─── t3 · its last output · running ─+$/);
		expect(plain(taskOutputSheetRows(task({ id: "t3", state: { kind: "running", ready: false } }), [], 80)[1]!)).toBe("  nothing yet");
	});

	it("the output in ink2; every row fits, W 20..160, three grounds; no bare ESC", () => {
		setGround("light");
		expect(taskOutputSheetRows(task({ id: "t1" }), ["tick 1"], 80)[1]).toContain(`${palette().ink2}tick 1`);
		const long = ["x".repeat(300), "\u6f22".repeat(90), "\u001b[31mred\u001b[0m"];
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				for (const r of taskOutputSheetRows(task({ id: "t1" }), long, W)) {
					expect(visibleWidth(r), `${g} W=${W}`).toBeLessThanOrEqual(W);
					expect(r.replace(/\x1b\[[0-9;]*m/g, ""), `${g} W=${W}`).not.toContain("\x1b");
				}
			}
		}
	});
});
