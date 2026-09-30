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
 * What it does not do (later steps): tell the model (3c), decide whether an
 * idle session wakes (3c), or offer tools (3b).
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
		const records = readRecords(join(this.root, id, JOURNAL));
		const runner = runnerOf(records);
		if (runner === undefined || records.some((r) => r.type === "terminal")) return false;
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
