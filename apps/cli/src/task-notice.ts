/**
 * ADR-0058 (3c): the row a task delivery shows in the transcript — live and
 * on resume. The model reads the notice's own lines; a person reads this.
 *
 * 3e: and what the person sees of the tasks themselves — the `/tasks` rows,
 * a task's output on request, and the count on the status row. All of it
 * is drawn on the screen only: no `user_input`, nothing in the session log,
 * nothing the model sees (the model has its notices and `read_file`).
 *
 * Amendment 8: a task kiso lost track of (`unknown`) is said in the
 * person's words — "lost track", and why — as its own transcript row, once;
 * never a second count on the status row. The model's notice keeps the
 * protocol's `unknown`.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskDeliveryItem } from "@vincemakes/kiso-core";
import { readRecords, type TaskInfo, type TaskRecord } from "@vincemakes/kiso-runtime/internal";
import { elapsedLabel } from "@vincemakes/kiso-tui-cells";

/** The lines a delivery shows: today's `✦ task t1 exited · t2 failed` for
 *  the ordinary items, and one `✦ lost track of …` row per lost task. The
 *  shape is fixed (a design keys on it): the opening `✦ lost track of <id>
 *  (<what>) — ` — the parenthesis only when the command is known — and the
 *  LAST ` — ` part opening with "it may still be running". One line each. */
export function taskNoticeLines(items: readonly TaskDeliveryItem[], what?: (taskId: string) => string | undefined): string[] {
	const rows: string[] = [];
	const ordinary = items.filter((i) => i.transition !== "unknown");
	if (ordinary.length > 0) rows.push(`✦ task ${ordinary.map((i) => `${i.taskId} ${i.transition}`).join(" · ")}`);
	for (const i of items) {
		if (i.transition !== "unknown") continue;
		const w = what?.(i.taskId)?.split("\n")[0]?.trim();
		rows.push(`✦ lost track of ${i.taskId}${w ? ` (${w})` : ""} — it may still be running · /tasks shows it`);
	}
	return rows;
}

/** A task's state in the person's words. A stop that was asked for and is
 *  not yet confirmed reads `stopping` — never `stopped` before the journal
 *  says so; a task kiso lost track of says so (Amendment 8). */
export function taskStateLabel(task: TaskInfo): string {
	const s = task.state;
	switch (s.kind) {
		case "starting":
			return "starting";
		case "not_run":
			return "never ran";
		case "running":
			return task.stoppedBy !== undefined ? "stopping" : s.ready ? "ready" : "running";
		case "unknown":
			return "lost track — may still be running";
		case "ended":
			if (s.stopped) return "stopped";
			if (s.error !== undefined) return "failed to start";
			return s.exitCode !== null ? (s.exitCode === 0 ? "exited 0" : `failed ${s.exitCode}`) : `ended ${s.signal ?? ""}`.trim();
	}
}

/** Why kiso lost track of a task, from its journal — or undefined when it
 *  has not: a stop it could not confirm, a moved command whose kiso ended,
 *  or a runner that is gone. */
export function lostReason(task: TaskInfo): string | undefined {
	if (task.state.kind !== "unknown") return undefined;
	let records: TaskRecord[] = [];
	try {
		records = readRecords(join(dirname(task.outputPath), "journal.jsonl"));
	} catch {
		// an unreadable journal: the general reason below
	}
	const unconfirmed = records.find((r): r is Extract<TaskRecord, { type: "stop_unconfirmed" }> => r.type === "stop_unconfirmed");
	if (unconfirmed !== undefined) return `its stop could not be confirmed (pids ${unconfirmed.pids.join(", ")})`;
	if (task.backend === "foreground") return "the kiso that held it ended without recording its end";
	return "its runner is gone without recording its end";
}

/** What the task is: the command, or the child's role and task. */
export function taskWhat(task: TaskInfo): string {
	return task.agent !== undefined ? task.command : task.command.split("\n")[0]!;
}

/** One `/tasks` row: `t3  running  1m 20s`, with the command beside it. */
export function taskRow(task: TaskInfo, now: number = Date.now()): { readonly label: string; readonly note: string } {
	const seconds = ((task.endedAt ?? now) - task.startedAt) / 1000;
	return { label: `${task.id}  ${taskStateLabel(task)}  ${elapsedLabel(seconds)}`, note: taskWhat(task) };
}

/** A task's last `lines` lines of output — or, for a child, its answer. */
export function taskOutput(task: TaskInfo, lines = 20): string[] {
	if (task.agent !== undefined) {
		try {
			return readFileSync(join(dirname(task.outputPath), "result.md"), "utf8").trimEnd().split("\n").slice(-lines);
		} catch {
			// no answer written (yet): what it printed instead
		}
	}
	try {
		const fd = openSync(task.outputPath, "r");
		try {
			const size = fstatSync(fd).size;
			const n = Math.min(size, 64 * 1024);
			const buf = Buffer.alloc(n);
			readSync(fd, buf, 0, n, size - n);
			return buf.toString("utf8").trimEnd().split("\n").slice(-lines);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

/** The status row's count: the tasks kiso manages (running or starting).
 *  A lost task is not counted here (Amendment 8). */
export function taskCounts(tasks: readonly TaskInfo[]): { readonly running: number } {
	let running = 0;
	for (const t of tasks) if (t.state.kind === "running" || t.state.kind === "starting") running += 1;
	return { running };
}
