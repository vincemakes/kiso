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
import { SHEET_CLOSE, bandHeader } from "@vincemakes/kiso-tui-cells/strings";
import { cutLine, escapeTerminal, palette } from "@vincemakes/kiso-tui-cells/render";
import type { NoticeMark } from "@vincemakes/kiso-tui";

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

/** Finding 0480-F9: the chain budget is spent — said to the person once,
 *  so a chain that went quiet on its budget does not look idle. */
export function budgetSpentLine(info: { readonly wakes: number }): string {
	return `✦ chain budget spent — ${info.wakes} autonomous wake${info.wakes === 1 ? "" : "s"} since your last message · finished tasks wait for you`;
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

/** The tasks round (owner, 2026-10-06) — how a task ended, in one word and
 *  its colour: a shell `exited 0` (or `failed 1`), a child `answered` (or
 *  `failed`), `stopped` dim, `lost track — may still be running` gold (the
 *  main sync, Amendment 8's words; it read `◌ outcome unknown`), `ready`
 *  when a long-running command said it was. Read from the task's own journal, so a
 *  resumed session says what a live one did; with no journal entry, the
 *  delivery's transition word, uncoloured. */
export function taskOutcome(task: TaskInfo | undefined, transition: TaskDeliveryItem["transition"]): { readonly word: string; readonly tone: NoticeMark["tone"] | null } {
	if (task === undefined) return { word: transition, tone: null };
	if (transition === "ready") return { word: "ready", tone: "ok" };
	const label = taskStateLabel(task);
	if (label === "exited 0") return { word: task.agent !== undefined ? "answered" : "exited 0", tone: "ok" };
	if (label.startsWith("failed")) return { word: task.agent !== undefined && label !== "failed to start" ? "failed" : label, tone: "fail" };
	if (task.state.kind === "unknown") return { word: label, tone: "gold" };
	return { word: label, tone: null };
}

/** The tasks round — a task delivery on the terminal: one meta row per
 *  task, `TASK` once and the rows under it unlabelled, each `<id> <how it
 *  ended> · <what ran>` with the outcome word marked; a lost task adds
 *  where to look (`· /tasks shows it`). The pipe keeps `taskNoticeLines`'
 *  lines, byte for byte. */
export function taskNoticeRows(items: readonly TaskDeliveryItem[], tasks: readonly TaskInfo[]): { readonly label: string; readonly sentence: string; readonly mark?: NoticeMark }[] {
	// (a lost task adds `· /tasks shows it`, before what ran)
	return items.map((item, i) => {
		const task = tasks.find((t) => t.id === item.taskId);
		const { word, tone } = item.transition === "unknown" && task === undefined ? { word: "lost track — may still be running", tone: "gold" as const } : taskOutcome(task, item.transition);
		const what = task === undefined ? "" : ` · ${taskWhat(task)}`;
		// where to look before what ran: the row is cut at the end
		const where = item.transition === "unknown" ? " · /tasks shows it" : "";
		return { label: i === 0 ? "TASK" : "", sentence: `${item.taskId} ${word}${where}${what}`, ...(tone !== null ? { mark: { text: word, tone } } : {}) };
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
	// the main sync (0.46.2, Amendment 8): a lost task says why, first, in
	// gold — the printed form's `t1 — lost track: …` line
	const why = lostReason(task);
	if (why !== undefined) rows.push(`  ${p.gold}lost track: ${escapeTerminal(why)}; it may still be running${p.gold === "" ? "" : p.fgEnd}`);
	if (lines.length === 0) rows.push(`  ${p.dim}nothing yet${p.reset}`);
	for (const line of lines) rows.push(`  ${p.ink2}${escapeTerminal(line)}${p.ink2 === "" ? "" : p.fgEnd}`);
	rows.push(`  ${p.dim}${SHEET_CLOSE}${p.reset}`);
	return rows.map((r) => cutLine(r, W));
}
