/**
 * ADR-0058 §6 — the TaskManager: one per session, the only door to a
 * session's tasks.
 *
 * It owns the task directory (`<store root>/<session>.tasks/<id>/`, holding
 * `journal.jsonl` and `output.log`), allocates ids (`t1`, `t2`, … — stable
 * across restarts, read off the directory), writes the kiso-side records
 * durably, and classifies every task from its journal plus a verified
 * runner identity. It never spawns a process itself: a BACKEND does (the
 * process backend lives with the shell, in tools-node), and any number of
 * hosts reach tasks through this one manager — never by searching for a
 * child process themselves.
 *
 * Two ways in: `start` — a runner owns the command (background work, it
 * survives kiso); `adopt` — a foreground shell command promoted past its
 * wait, which the kiso process that spawned it keeps owning. An adopted
 * task's runner IS that kiso process: if kiso crashes the journal reads
 * `unknown`, never ended, never re-run (ADR-0058 3b, D1).
 *
 * What it does not do (later steps): tell the model (3c), or decide whether
 * an idle session wakes (3c).
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, fsyncDir, readRecords, runnerOf, verdictOf, type TaskProfile, type TaskRecord, type TaskState } from "./journal.js";

/** A backend runs one kind of task. The manager has already made `planned`
 *  durable; the backend spawns the runner, which records itself. */
export interface TaskBackend {
	/** Spawn the runner for the task in `dir`; resolve once `runner_started`
	 *  is on disk (reject if the runner never speaks). */
	spawn(spec: { readonly dir: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<void>;
	/** True only when `pid` is alive AND is the process that recorded
	 *  `startedAt` — a reused pid is not the runner. */
	alive(pid: number, startedAt: string): boolean;
	/** Ask the runner to stop its command's process group. */
	signalStop(pid: number): void;
}

export interface TaskStartOptions {
	readonly command: string;
	readonly cwd: string;
	readonly profile?: TaskProfile;
	/** The runner's environment. The shell's own policy (stripped
	 *  credentials) is applied by the caller; nothing of it is written down. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The tool invocation that started the task, when one did. */
	readonly executionId?: string;
	/** A literal substring of the output that means "ready" (ADR-0058 §3). */
	readonly readyWhen?: string;
}

export interface TaskInfo {
	readonly id: string;
	readonly command: string;
	readonly profile: TaskProfile;
	readonly state: TaskState;
	readonly outputPath: string;
	readonly startedAt: number;
	readonly endedAt?: number;
}

export interface TaskAdoptOptions {
	readonly command: string;
	readonly cwd: string;
	/** The tool invocation that ran the command. */
	readonly executionId?: string;
	readonly readyWhen?: string;
	/** The process that owns the command from now on — the caller itself:
	 *  its pid and OS start time ("" when it cannot be read). */
	readonly runner: { readonly pid: number; readonly startedAt: string };
	/** True when the ready line is what promoted it. */
	readonly ready?: boolean;
	/** Stop the command. The owner then reports `ended` or `unconfirmed`. */
	readonly stop: () => void;
}

/** The owner's side of an adopted task: every record it writes is durable. */
export interface AdoptedTask {
	readonly id: string;
	readonly outputPath: string;
	ready(match: string): void;
	ended(exitCode: number | null, signal: string | null): void;
	/** A stop left these pids alive: no terminal — the task stays `unknown`. */
	unconfirmed(pids: readonly number[]): void;
}

/** What changed, reported once each: the ready signal, the end, the runner
 *  vanishing without an end, or a start that never ran. */
export type TaskTransition = "ready" | "ended" | "unknown" | "not_run";

export interface TaskManagerOptions {
	/** `<store root>/<session>.tasks` */
	readonly root: string;
	readonly backend: TaskBackend;
	readonly onTransition?: (task: TaskInfo, transition: TaskTransition) => void;
	/** How often live tasks are re-read. Default 500 ms. */
	readonly pollMs?: number;
}

const JOURNAL = "journal.jsonl";
const OUTPUT = "output.log";
const ID = /^t(\d+)$/;

export class TaskManager {
	readonly root: string;
	readonly #backend: TaskBackend;
	readonly #onTransition: TaskManagerOptions["onTransition"];
	readonly #pollMs: number;
	#timer: ReturnType<typeof setInterval> | null = null;
	/** id → the last observed kind ("ready" for a running task that has signalled) */
	readonly #seen = new Map<string, string>();
	/** id → how to stop an adopted task this process owns */
	readonly #local = new Map<string, () => void>();

	constructor(options: TaskManagerOptions) {
		this.root = options.root;
		this.#backend = options.backend;
		this.#onTransition = options.onTransition;
		this.#pollMs = options.pollMs ?? 500;
	}

	/** Start a task. `planned` is durable before the runner is spawned. */
	async start(options: TaskStartOptions): Promise<TaskInfo> {
		mkdirSync(this.root, { recursive: true });
		const id = this.#nextId();
		const dir = join(this.root, id);
		mkdirSync(dir);
		fsyncDir(this.root);
		appendRecord(join(dir, JOURNAL), {
			type: "planned",
			ts: Date.now(),
			taskId: id,
			backend: "process",
			command: options.command,
			cwd: options.cwd,
			profile: options.profile ?? "oneshot",
			...(options.executionId !== undefined ? { executionId: options.executionId } : {}),
			...(options.readyWhen !== undefined ? { readyWhen: options.readyWhen } : {}),
		});
		await this.#backend.spawn({ dir, env: options.env ?? process.env });
		this.#seen.set(id, "starting");
		this.observe();
		return this.get(id)!;
	}

	/** A running foreground command becomes a task this process owns:
	 *  `planned`, the owner's identity and `command_started` are durable
	 *  before this returns. The command is already running; nothing is
	 *  spawned. */
	adopt(options: TaskAdoptOptions): AdoptedTask {
		mkdirSync(this.root, { recursive: true });
		const id = this.#nextId();
		const dir = join(this.root, id);
		mkdirSync(dir);
		fsyncDir(this.root);
		const journal = join(dir, JOURNAL);
		appendRecord(journal, {
			type: "planned",
			ts: Date.now(),
			taskId: id,
			backend: "foreground",
			command: options.command,
			cwd: options.cwd,
			profile: options.readyWhen !== undefined ? "service" : "oneshot",
			...(options.executionId !== undefined ? { executionId: options.executionId } : {}),
			...(options.readyWhen !== undefined ? { readyWhen: options.readyWhen } : {}),
		});
		appendRecord(journal, { type: "runner_started", ts: Date.now(), pid: options.runner.pid, startedAt: options.runner.startedAt });
		appendRecord(journal, { type: "command_started", ts: Date.now() });
		if (options.ready === true && options.readyWhen !== undefined) appendRecord(journal, { type: "ready", ts: Date.now(), match: options.readyWhen });
		this.#local.set(id, options.stop);
		this.#seen.set(id, options.ready === true ? "ready" : "running");
		this.observe();
		let readySent = options.ready === true;
		return {
			id,
			outputPath: join(dir, OUTPUT),
			ready: (match) => {
				if (readySent) return;
				readySent = true;
				appendRecord(journal, { type: "ready", ts: Date.now(), match });
			},
			ended: (exitCode, signal) => {
				if (!this.#local.delete(id)) return;
				appendRecord(journal, { type: "terminal", ts: Date.now(), exitCode, signal });
			},
			unconfirmed: (pids) => {
				if (!this.#local.delete(id)) return;
				appendRecord(journal, { type: "stop_unconfirmed", ts: Date.now(), pids });
			},
		};
	}

	/** Every task of the session, oldest first. */
	list(): TaskInfo[] {
		return this.#ids().map((id) => this.#info(id)!);
	}

	get(id: string): TaskInfo | undefined {
		return ID.test(id) && existsSync(join(this.root, id, JOURNAL)) ? this.#info(id) : undefined;
	}

	/** Stop a live task: `stop_requested` is durable, then the runner is
	 *  signalled. False when there is nothing live to stop. */
	stop(id: string, by: "person" | "model" | "exit"): boolean {
		if (!ID.test(id)) return false;
		const records = readRecords(join(this.root, id, JOURNAL));
		if (records.some((r) => r.type === "terminal")) return false;
		const planned = records.find((r): r is Extract<TaskRecord, { type: "planned" }> => r.type === "planned");
		if (planned?.backend === "foreground") {
			// its runner is a kiso process: never signalled — the owner stops
			// the command, and only the owner can
			const stopper = this.#local.get(id);
			if (stopper === undefined) return false;
			appendRecord(join(this.root, id, JOURNAL), { type: "stop_requested", ts: Date.now(), by });
			stopper();
			return true;
		}
		const runner = runnerOf(records);
		if (runner === undefined) return false;
		if (!this.#backend.alive(runner.pid, runner.startedAt)) return false;
		appendRecord(join(this.root, id, JOURNAL), { type: "stop_requested", ts: Date.now(), by });
		this.#backend.signalStop(runner.pid);
		return true;
	}

	/** A clean exit: stop every live task and wait for their terminals, up
	 *  to `graceMs`. Returns the ids still without a terminal. */
	async stopAll(by: "person" | "exit" = "exit", graceMs = 8_000): Promise<string[]> {
		const live = this.list().filter((t) => t.state.kind === "running" || t.state.kind === "starting").map((t) => t.id);
		for (const id of live) this.stop(id, by);
		const deadline = Date.now() + graceMs;
		let left = live;
		while (left.length > 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
			left = left.filter((id) => this.get(id)?.state.kind !== "ended");
		}
		return left;
	}

	/** Start watching: every task is classified now (no transition for what
	 *  it already is), and live ones are re-read until they settle. */
	observe(): void {
		for (const id of this.#ids()) if (!this.#seen.has(id)) this.#seen.set(id, this.#kindOf(this.#info(id)!));
		if (this.#timer !== null) return;
		this.#timer = setInterval(() => this.#poll(), this.#pollMs);
		(this.#timer as { unref?: () => void }).unref?.();
	}

	/** Stop watching. Tasks keep running. */
	close(): void {
		if (this.#timer !== null) clearInterval(this.#timer);
		this.#timer = null;
	}

	#poll(): void {
		for (const id of this.#ids()) {
			const before = this.#seen.get(id);
			if (before === "ended" || before === "unknown" || before === "not_run") continue;
			const info = this.#info(id)!;
			const now = this.#kindOf(info);
			if (now === before) continue;
			this.#seen.set(id, now);
			const transition: TaskTransition | null =
				now === "ready" ? "ready" : now === "ended" ? "ended" : now === "unknown" ? "unknown" : now === "not_run" ? "not_run" : null;
			if (transition !== null) this.#onTransition?.(info, transition);
		}
	}

	#kindOf(info: TaskInfo): string {
		return info.state.kind === "running" && info.state.ready ? "ready" : info.state.kind;
	}

	#info(id: string): TaskInfo | undefined {
		const records = readRecords(join(this.root, id, JOURNAL));
		const planned = records.find((r): r is Extract<TaskRecord, { type: "planned" }> => r.type === "planned");
		const runner = runnerOf(records);
		const alive = runner !== undefined && this.#backend.alive(runner.pid, runner.startedAt);
		const terminal = records.find((r) => r.type === "terminal");
		return {
			id,
			command: planned?.command ?? "",
			profile: planned?.profile ?? "oneshot",
			state: verdictOf(records, alive),
			outputPath: join(this.root, id, OUTPUT),
			startedAt: planned?.ts ?? 0,
			...(terminal !== undefined ? { endedAt: terminal.ts } : {}),
		};
	}

	#ids(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root)
			.filter((name) => ID.test(name))
			.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	}

	#nextId(): string {
		const ids = this.#ids();
		const last = ids.length === 0 ? 0 : Number(ids.at(-1)!.slice(1));
		return `t${last + 1}`;
	}
}
