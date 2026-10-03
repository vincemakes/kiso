/**
 * ADR-0058 §6 — the task runner: `node task-runner.js <task dir>`.
 *
 * A small process of its own, detached from kiso, that owns one task's
 * command, its output file and its terminal record — and outlives kiso,
 * so a task survives the agent's death and its outcome is still written.
 *
 * Its records, each written and fsynced BEFORE the step it gates:
 *   runner_started   its pid and OS start time — its verifiable identity
 *   command_started  then, and only then, the command is spawned
 *   ready            the first time the output contains `readyWhen`
 *   terminal         the exit code or signal, once the command's output closed
 *
 * The command runs in its own process group. A stop is asked for by the
 * journal's `stop_requested` record — durable before any signal, and the
 * one channel every platform has (on win32 a signal to the runner is
 * TerminateProcess): the runner watches its journal and stops the whole
 * tree (TERM, a grace, then the confirmed sweep of the process module).
 * SIGTERM is the same stop, sooner, where signals exist.
 *
 * A command that never starts (no shell, a missing cwd) ends with a
 * `terminal` carrying `error` and no exit code — none is invented. A stop that cannot confirm every process dead writes NO
 * terminal — `stop_unconfirmed` names the survivors and the runner exits,
 * so the journal reads `unknown`, never ended. The output passes
 * through the runner so it can rotate at the cap (64 MiB: the file moves to
 * output.1.log and a fresh output.log starts with a marker — the tail,
 * where errors live, is always kept) and match `readyWhen`.
 *
 * Nothing secret is written down: the environment arrives with the process
 * and is handed to the command, never recorded.
 */

import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { killTree, processStartTime, RotatingOutput, startCommand, startExec } from "./process.js";

const OUTPUT_CAP_DEFAULT = 64 * 1024 * 1024;
const STOP_GRACE_MS = 5_000;
/** How often the runner looks for a `stop_requested` in its journal. */
const STOP_POLL_MS = 250;

function append(journal: string, record: Record<string, unknown>): void {
	const fd = openSync(journal, "a");
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		// Windows: an append handle cannot be flushed; the flush goes
		// through a read-write handle (the runtime journal's syncFile)
		if (process.platform === "win32") {
			const sync = openSync(journal, "r+");
			try {
				fsyncSync(sync);
			} finally {
				closeSync(sync);
			}
		} else fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

interface Planned {
	readonly command: string;
	readonly cwd: string;
	readonly readyWhen?: string;
	/** 3d: an argv launch — no shell; `command` is then the label */
	readonly launch?: { readonly kind: "exec"; readonly file: string; readonly args: readonly string[] };
}

function plannedOf(journal: string): Planned {
	for (const line of readFileSync(journal, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const record = JSON.parse(line) as { type?: string } & Planned;
		if (record.type === "planned") return record;
	}
	throw new Error(`no planned record in ${journal}`);
}

function main(dir: string): void {
	const journal = join(dir, "journal.jsonl");
	const planned = plannedOf(journal);
	// test-only crash points: the process dies right after a record, before
	// the step that record gates
	const dieAfter = process.env.KISO_TASK_RUNNER_DIE_AFTER;
	// test-only: report a stop as unconfirmed (a survivor the platform could
	// not kill cannot be made on purpose)
	const forceUnconfirmed = process.env.KISO_TASK_RUNNER_STOP_UNCONFIRMED === "1";
	const cap = Number(process.env.KISO_TASK_OUTPUT_CAP ?? OUTPUT_CAP_DEFAULT);
	const env = { ...process.env };
	delete env.KISO_TASK_RUNNER_DIE_AFTER;
	delete env.KISO_TASK_RUNNER_STOP_UNCONFIRMED;
	delete env.KISO_TASK_OUTPUT_CAP;

	// "" when the start time cannot be read: the identity is then the pid
	// alone, and the backend treats it as unverifiable, never as dead
	const self = processStartTime(process.pid);
	append(journal, { type: "runner_started", ts: Date.now(), pid: process.pid, startedAt: self.kind === "running" ? self.startedAt : "" });
	if (dieAfter === "runner_started") process.exit(99);
	append(journal, { type: "command_started", ts: Date.now() });
	if (dieAfter === "command_started") process.exit(99);

	const out = new RotatingOutput(join(dir, "output.log"), cap);
	let finished = false;
	/** The last record; the output closes first, and nothing is written after. */
	const finish = (record: Record<string, unknown>): void => {
		if (finished) return;
		finished = true;
		out.close();
		append(journal, record);
		process.exit(0);
	};
	/** The command never started: its reason is the record, and the output says it too. */
	const notStarted = (err: Error): void => {
		out.write(Buffer.from(`[kiso: the command could not start: ${err.message}]\n`));
		finish({ type: "terminal", ts: Date.now(), exitCode: null, signal: null, error: err.message });
	};
	let child: ReturnType<typeof startCommand>;
	try {
		child = planned.launch?.kind === "exec" ? startExec(planned.launch.file, planned.launch.args, { cwd: planned.cwd, env }) : startCommand(planned.command, { cwd: planned.cwd, env });
	} catch (err) {
		// win32 without bash throws here (the Windows line's process module)
		notStarted(err instanceof Error ? err : new Error(String(err)));
		return;
	}
	let seen = "";
	let ready = false;
	const onData = (chunk: Buffer): void => {
		if (finished) return;
		out.write(chunk);
		if (planned.readyWhen === undefined || ready) return;
		seen = (seen + chunk.toString("utf8")).slice(-(planned.readyWhen.length + 65_536));
		if (seen.includes(planned.readyWhen)) {
			ready = true;
			append(journal, { type: "ready", ts: Date.now(), match: planned.readyWhen });
		}
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.on("error", (err) => {
		// a spawn failure (no pid) is a start that never happened; the `close`
		// that follows would otherwise carry an errno as if it were an exit code
		if (child.pid === undefined) notStarted(err);
		else out.write(Buffer.from(`[kiso: ${err.message}]\n`));
	});

	let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	child.on("exit", (code, signal) => {
		exit = { code, signal };
	});
	const outputClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));

	let stopping = false;
	const stop = (): void => {
		if (stopping || finished || child.pid === undefined) return;
		stopping = true;
		void killTree(child, { graceMs: STOP_GRACE_MS }).then(async ({ unconfirmed }) => {
			const survivors = forceUnconfirmed ? [child.pid!] : unconfirmed;
			if (survivors.length > 0) {
				finish({ type: "stop_unconfirmed", ts: Date.now(), pids: survivors });
				return;
			}
			// every tracked process is confirmed dead; the output drains
			// (bounded: an untracked holder of the pipe must not hang the stop)
			await Promise.race([outputClosed, new Promise((r) => setTimeout(r, 1_000))]);
			const e = exit as { code: number | null; signal: NodeJS.Signals | null } | null;
			finish({ type: "terminal", ts: Date.now(), exitCode: e?.code ?? null, signal: e?.signal ?? null });
		});
	};
	process.on("SIGTERM", stop);
	// the journal is the stop channel: re-read only when it grew
	let journalSize = -1;
	const watch = setInterval(() => {
		try {
			const size = statSync(journal).size;
			if (size === journalSize) return;
			journalSize = size;
			if (readFileSync(journal, "utf8").includes('"type":"stop_requested"')) stop();
		} catch {
			// a transient read failure is retried on the next tick
		}
	}, STOP_POLL_MS);
	watch.unref();

	// the command ended on its own: the terminal is written once its output closed
	child.on("close", (code, signal) => {
		if (!stopping) finish({ type: "terminal", ts: Date.now(), exitCode: code, signal });
	});
}

main(process.argv[2]!);
