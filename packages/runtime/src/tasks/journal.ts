/**
 * ADR-0058 §6 — the task journal: execution truth for work that no longer
 * sits inside a tool call.
 *
 * One append-only JSONL file per task. Every record that gates an external
 * effect is DURABLE — written and fsynced — before the effect may begin:
 * `planned` before the runner is spawned, `command_started` before the
 * command runs, `terminal` before the task counts as ended. That is what
 * lets `verdictOf` read a crash honestly: an absent record proves its effect
 * never began; a present one proves only that it may have.
 *
 * The session log is conversation truth and never records a process
 * lifecycle; this journal never records what the model knows. Neither
 * decides the other's facts.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

export type TaskProfile = "oneshot" | "service";

/** A launch without a shell: the file and its arguments, verbatim. */
export interface TaskLaunch {
	readonly kind: "exec";
	readonly file: string;
	readonly args: readonly string[];
}

/** Who an agent task is: its role and the child's session id. */
export interface TaskAgent {
	readonly role: string;
	readonly session: string;
}

export type TaskRecord =
	| {
			readonly type: "planned";
			readonly ts: number;
			readonly taskId: string;
			/** "process": a runner owns the command (it survives kiso).
			 *  "foreground": a shell command promoted past its wait — the kiso
			 *  process that started it owns it (ADR-0058 3b, D1). */
			readonly backend: "process" | "foreground";
			readonly command: string;
			readonly cwd: string;
			readonly profile: TaskProfile;
			/** The tool invocation that started the task, when one did. */
			readonly executionId?: string;
			/** A literal substring of the output that means "ready". */
			readonly readyWhen?: string;
			/** ADR-0058 3d: an argv launch — the runner starts `file` with
			 *  exactly `args`, no shell; `command` is then only the label. */
			readonly launch?: TaskLaunch;
			/** ADR-0058 §5: an agent task — a child kiso and its own session. */
			readonly agent?: TaskAgent;
	  }
	| { readonly type: "runner_started"; readonly ts: number; readonly pid: number; readonly startedAt: string }
	| { readonly type: "command_started"; readonly ts: number }
	| { readonly type: "ready"; readonly ts: number; readonly match: string }
	| { readonly type: "stop_requested"; readonly ts: number; readonly by: "person" | "model" | "exit" }
	/** A stop the runner could not confirm: these pids may outlive it. No
	 *  terminal follows — the verdict stays `unknown`. */
	| { readonly type: "stop_unconfirmed"; readonly ts: number; readonly pids: readonly number[] }
	/** `error`: the command never started (no shell, a missing cwd) — then
	 *  there is no exit code and none is invented. */
	| { readonly type: "terminal"; readonly ts: number; readonly exitCode: number | null; readonly signal: string | null; readonly error?: string };

/** Append one record and fsync it before returning — the write-ahead step. */
export function appendRecord(file: string, record: TaskRecord): void {
	const fd = openSync(file, "a");
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		if (process.platform === "win32") syncFile(file);
		else fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Windows: an append handle cannot be flushed (FlushFileBuffers needs
 *  write access, which append mode drops), and the append must stay an
 *  append (the runner and the manager both write the journal) — so the
 *  flush goes through a read-write handle of its own. */
export function syncFile(file: string): void {
	const fd = openSync(file, "r+");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** fsync a directory, so a file created in it survives a power loss too. */
export function fsyncDir(dir: string): void {
	// Windows opens no directory as a file, so the entry is not flushed
	// here: a process crash loses nothing, but the entry's power-loss
	// ordering is not the guarantee POSIX's directory fsync gives (the
	// Windows durability contract is P6's to state)
	if (process.platform === "win32") return;
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** A journal that is not a sequence of records with at most a torn tail. */
export class TaskJournalCorruptError extends Error {
	readonly file: string;
	readonly line: number;
	constructor(file: string, line: number) {
		super(`task journal ${file} is corrupt at line ${line} — a record follows an unreadable one`);
		this.name = "TaskJournalCorruptError";
		this.file = file;
		this.line = line;
	}
}

/** Every complete record, in order. A torn LAST line (a write cut by a
 *  crash) is not a record: it is dropped, never guessed at. An unreadable
 *  line with a record after it is corruption, and it fails loudly — the
 *  verdicts are inferences from what is present, so nothing is skipped. */
export function readRecords(file: string): TaskRecord[] {
	if (!existsSync(file)) return [];
	const out: TaskRecord[] = [];
	const lines = readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		try {
			out.push(JSON.parse(line) as TaskRecord);
		} catch {
			if (lines.slice(i + 1).some((l) => l.trim() !== "")) throw new TaskJournalCorruptError(file, i + 1);
		}
	}
	return out;
}

/**
 * What the journal proves, given whether the recorded runner is still the
 * live process it was (pid AND OS start time — never a bare pid).
 *
 *   starting      planned (or runner_started) and the runner may still act
 *   not_run       the command provably never ran
 *   running       command_started, the runner verified alive
 *   unknown       command_started, the runner gone, no terminal — the
 *                 person decides; the task is never re-run
 *   ended         the terminal, as recorded
 */
export type TaskState =
	| { readonly kind: "starting" }
	| { readonly kind: "not_run" }
	| { readonly kind: "running"; readonly ready: boolean }
	| { readonly kind: "unknown" }
	| { readonly kind: "ended"; readonly exitCode: number | null; readonly signal: string | null; readonly stopped: boolean; readonly error?: string };

/** How long a `planned` without a runner may wait for its runner to speak
 *  before it counts as never run — the runner's first act is its record. */
export const RUNNER_START_WINDOW_MS = 30_000;

export function verdictOf(records: readonly TaskRecord[], runnerAlive: boolean, now: number = Date.now()): TaskState {
	const has = (type: TaskRecord["type"]) => records.some((r) => r.type === type);
	const terminal = records.find((r): r is Extract<TaskRecord, { type: "terminal" }> => r.type === "terminal");
	if (terminal !== undefined)
		return {
			kind: "ended",
			exitCode: terminal.exitCode,
			signal: terminal.signal,
			stopped: has("stop_requested"),
			...(terminal.error !== undefined ? { error: terminal.error } : {}),
		};
	const planned = records.find((r) => r.type === "planned");
	if (planned === undefined) return { kind: "not_run" };
	if (has("command_started")) return runnerAlive ? { kind: "running", ready: has("ready") } : { kind: "unknown" };
	if (has("runner_started")) return runnerAlive ? { kind: "starting" } : { kind: "not_run" };
	return now - planned.ts < RUNNER_START_WINDOW_MS ? { kind: "starting" } : { kind: "not_run" };
}

/** The recorded runner identity, if the runner has spoken. */
export function runnerOf(records: readonly TaskRecord[]): { readonly pid: number; readonly startedAt: string } | undefined {
	const r = records.find((x): x is Extract<TaskRecord, { type: "runner_started" }> => x.type === "runner_started");
	return r === undefined ? undefined : { pid: r.pid, startedAt: r.startedAt };
}
