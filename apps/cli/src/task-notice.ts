/**
 * ADR-0058 (3c): the row a task delivery shows in the transcript — live and
 * on resume. The model reads the notice's own lines; a person reads this.
 *
 * 3e: and what the person sees of the tasks themselves — the `/tasks` rows,
 * a task's output on request, and the counts on the status row. All of it
 * is drawn on the screen only: no `user_input`, nothing in the session log,
 * nothing the model sees (the model has its notices and `read_file`).
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskDeliveryItem } from "@vincemakes/kiso-core";
import type { TaskInfo } from "@vincemakes/kiso-runtime/internal";
import { elapsedLabel } from "@vincemakes/kiso-tui-cells";

export function taskNoticeRow(items: readonly TaskDeliveryItem[]): string {
	return `✦ task ${items.map((i) => `${i.taskId} ${i.transition}`).join(" · ")}`;
}

/** A task's state in the person's words. A stop that was asked for and is
 *  not yet confirmed reads `stopping` — never `stopped` before the journal
 *  says so; an outcome nobody can know reads `◌ outcome unknown`. */
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
			return "◌ outcome unknown";
		case "ended":
			if (s.stopped) return "stopped";
			if (s.error !== undefined) return "failed to start";
			return s.exitCode !== null ? (s.exitCode === 0 ? "exited 0" : `failed ${s.exitCode}`) : `ended ${s.signal ?? ""}`.trim();
	}
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

/** The status row's counts: live tasks, and the unknown ones the person
 *  has not looked at in `/tasks` in this process. */
export function taskCounts(tasks: readonly TaskInfo[], seen: ReadonlySet<string>): { readonly running: number; readonly unknown: number } {
	let running = 0;
	let unknown = 0;
	for (const t of tasks) {
		if (t.state.kind === "running" || t.state.kind === "starting") running += 1;
		else if (t.state.kind === "unknown" && !seen.has(t.id)) unknown += 1;
	}
	return { running, unknown };
}
