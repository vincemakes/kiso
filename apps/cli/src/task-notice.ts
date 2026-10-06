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
import { SHEET_CLOSE, bandHeader } from "@vincemakes/kiso-tui-cells/strings";
import { cutLine, escapeTerminal, palette } from "@vincemakes/kiso-tui-cells/render";
import type { NoticeMark } from "@vincemakes/kiso-tui";

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

/** The tasks round (owner, 2026-10-06) — how a task ended, in one word and
 *  its colour: a shell `exited 0` (or `failed 1`), a child `answered` (or
 *  `failed`), `stopped` dim, `◌ outcome unknown` gold, `ready` when a
 *  long-running command said it was. Read from the task's own journal, so a
 *  resumed session says what a live one did; with no journal entry, the
 *  delivery's transition word, uncoloured. */
export function taskOutcome(task: TaskInfo | undefined, transition: TaskDeliveryItem["transition"]): { readonly word: string; readonly tone: NoticeMark["tone"] | null } {
	if (task === undefined) return { word: transition, tone: null };
	if (transition === "ready") return { word: "ready", tone: "ok" };
	const label = taskStateLabel(task);
	if (label === "exited 0") return { word: task.agent !== undefined ? "answered" : "exited 0", tone: "ok" };
	if (label.startsWith("failed")) return { word: task.agent !== undefined && label !== "failed to start" ? "failed" : label, tone: "fail" };
	if (label === "◌ outcome unknown") return { word: label, tone: "gold" };
	return { word: label, tone: null };
}

/** The tasks round — a task delivery on the terminal: one meta row per
 *  task, `TASK` once and the rows under it unlabelled, each `<id> <how it
 *  ended> · <what ran>` with the outcome word marked. The pipe keeps
 *  `taskNoticeRow`'s line, byte for byte. */
export function taskNoticeRows(items: readonly TaskDeliveryItem[], tasks: readonly TaskInfo[]): { readonly label: string; readonly sentence: string; readonly mark?: NoticeMark }[] {
	return items.map((item, i) => {
		const task = tasks.find((t) => t.id === item.taskId);
		const { word, tone } = taskOutcome(task, item.transition);
		const what = task === undefined ? "" : ` · ${taskWhat(task)}`;
		return { label: i === 0 ? "TASK" : "", sentence: `${item.taskId} ${word}${what}`, ...(tone !== null ? { mark: { text: word, tone } } : {}) };
	});
}

/** A session's tasks for display, or none: a journal that cannot be read
 *  is reported where it is read on purpose (`/tasks`), never here. */
export function tasksForDisplay(manager: { list(): TaskInfo[] } | undefined): readonly TaskInfo[] {
	if (manager === undefined) return [];
	try {
		return manager.list();
	} catch {
		return [];
	}
}

/** The tasks round (owner, 2026-10-06) — `/tasks` → show its output, on a
 *  dock: a sheet over the input, `/context`'s shape (§8.16). The band
 *  names the task, which output it is, and how it ended; the lines at the
 *  content edge, each cut to one row; the closing row. On a pipe the
 *  printed lines stay. */
export function taskOutputSheetRows(task: TaskInfo, lines: readonly string[], W: number): string[] {
	const p = palette();
	const which = task.agent !== undefined ? "its answer" : "its last output";
	const { word } = taskOutcome(task, "exited");
	const rows = [bandHeader(`${task.id} · ${which} · ${task.state.kind === "running" || task.state.kind === "starting" ? taskStateLabel(task) : word}`, W)];
	if (lines.length === 0) rows.push(`  ${p.dim}nothing yet${p.reset}`);
	for (const line of lines) rows.push(`  ${p.ink2}${escapeTerminal(line)}${p.ink2 === "" ? "" : p.fgEnd}`);
	rows.push(`  ${p.dim}${SHEET_CLOSE}${p.reset}`);
	return rows.map((r) => cutLine(r, W));
}
