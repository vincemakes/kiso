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
import { dirname, join } from "node:path";
import type { AbortSignalLike } from "@vincemakes/kiso-core";
import { appendRecord, fsyncDir, readRecords, runnerOf, verdictOf, type ClaimedTransition, type TaskAgent, type TaskProfile, type TaskRecord, type TaskState } from "./journal.js";

/** Whether a recorded runner is still that process (ADR-0058 §6):
 *  "verified" — the pid is live AND its OS start time is the recorded one;
 *  "gone" — no such process, or another process holds the pid;
 *  "unverifiable" — the pid is live but whose it is cannot be told (no
 *  start time recorded, or none readable now). Only "verified" is the
 *  runner: "when identity cannot be verified, the verdict is the gone row". */
export type RunnerIdentity = "verified" | "gone" | "unverifiable";

/** A backend runs one kind of task. The manager has already made `planned`
 *  durable; the backend spawns the runner, which records itself. */
export interface TaskBackend {
	/** Spawn the runner for the task in `dir`; resolve once `runner_started`
	 *  is on disk (reject if the runner never speaks). */
	spawn(spec: { readonly dir: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<void>;
	identify(pid: number, startedAt: string): RunnerIdentity;
	/** Signal a VERIFIED runner to stop (a sooner path than the journal's
	 *  `stop_requested`, which the runner watches; a no-op where signals
	 *  would kill the runner outright). */
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
	/** ADR-0058 3d: start `file` with exactly `args` — no shell; `command`
	 *  is then the label. Given the task's directory, before it is planned. */
	readonly exec?: (dir: string) => { readonly file: string; readonly args: readonly string[] };
	/** ADR-0058 §5: the task is a child agent (its role and session). */
	readonly agent?: TaskAgent;
}

export interface TaskInfo {
	readonly id: string;
	readonly command: string;
	readonly profile: TaskProfile;
	/** "process": a runner owns it; "foreground": a promoted command its kiso owns. */
	readonly backend: "process" | "foreground";
	/** The tool invocation that started it, when one did. */
	readonly executionId?: string;
	/** Who asked for its stop, when someone did. */
	readonly stoppedBy?: "person" | "model" | "exit";
	/** An agent task's role and child session (ADR-0058 §5). */
	readonly agent?: TaskAgent;
	readonly state: TaskState;
	readonly outputPath: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	/** ADR-0058 Amendment 7: the transitions a tool execution took over —
	 *  its result reports them, so they are never noticed. */
	readonly claims?: readonly { readonly transition: ClaimedTransition; readonly executionId: string }[];
}

/** The name a task's end (or its runner's vanishing, or a start that never
 *  ran) has for the model — as a notice says it, and as a claim records it. */
export function endTransitionOf(task: TaskInfo): Exclude<ClaimedTransition, "ready"> | null {
	const s = task.state;
	if (s.kind === "ended") {
		if (task.stoppedBy !== undefined) return "stopped";
		return s.exitCode === 0 && s.error === undefined ? "exited" : "failed";
	}
	if (s.kind === "unknown") return "unknown";
	if (s.kind === "not_run") return "failed";
	return null;
}

/** What `awaitSettled` saw: settled — the target reached (or any end);
 *  claimed — taken over for the calling execution, so never announced. */
export interface TaskSettled {
	readonly info: TaskInfo;
	readonly settled: boolean;
	readonly claimed: boolean;
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

/** Who moved a running foreground command to the background (3e). */
export type DetachBy = "person" | "steer";

/** A running foreground execution that can become a task now (ADR-0058
 *  §2 ways 3 and 4; 3e). Its owner registers it while it runs. */
export interface Detachable {
	/** When the command started (ms since the epoch): a steer detaches
	 *  only a command old enough (ADR-0057 §5; 3e D1). */
	readonly startedAt: number;
	/** Promote it now — the owner's own promotion (3b), with the reason. */
	detach(by: DetachBy): void;
}

/** What changed, reported once each: the ready signal, the end, the runner
 *  vanishing without an end, or a start that never ran. */
export type TaskTransition = "ready" | "ended" | "unknown" | "not_run";

export type TaskListener = (task: TaskInfo, transition: TaskTransition) => void;

export interface TaskManagerOptions {
	/** `<store root>/<session>.tasks` */
	readonly root: string;
	readonly backend: TaskBackend;
	/** A first listener — the same as `subscribe` right after construction. */
	readonly onTransition?: TaskListener;
	/** How often live tasks are re-read. Default 500 ms. */
	readonly pollMs?: number;
	/** How long a live runner's identity is reused before it is checked
	 *  again. Default 5 s. Each check starts a process (`ps`; a PowerShell
	 *  on win32), so it is not repeated on every read; the journal still is,
	 *  so an end is seen at once. The cost: a runner that dies WITHOUT a
	 *  terminal keeps reading as `running` for up to this long after it
	 *  died (its cached verdict is still "verified"), then `unknown`. */
	readonly identifyEveryMs?: number;
}

const JOURNAL = "journal.jsonl";
const OUTPUT = "output.log";
const ID = /^t(\d+)$/;

export class TaskManager {
	readonly root: string;
	readonly #backend: TaskBackend;
	readonly #listeners = new Set<TaskListener>();
	readonly #pollMs: number;
	readonly #identifyEveryMs: number;
	/** id → the last identity verdict for its runner (pid + start time). */
	readonly #identity = new Map<string, { readonly key: string; readonly verdict: RunnerIdentity; readonly at: number }>();
	#timer: ReturnType<typeof setInterval> | null = null;
	/** id → the last observed kind ("ready" for a running task that has signalled) */
	readonly #seen = new Map<string, string>();
	/** id → how to stop an adopted task this process owns */
	readonly #local = new Map<string, () => void>();
	/** executionId → a running foreground command that can be detached (3e) */
	readonly #detachable = new Map<string, Detachable>();
	/** id → how many `awaitSettled` calls wait on it: the watcher skips it */
	readonly #waiting = new Map<string, number>();

	constructor(options: TaskManagerOptions) {
		this.root = options.root;
		this.#backend = options.backend;
		if (options.onTransition !== undefined) this.#listeners.add(options.onTransition);
		this.#pollMs = options.pollMs ?? 500;
		this.#identifyEveryMs = options.identifyEveryMs ?? 5_000;
	}

	/** A runner's identity (Windows P6): "gone" is final — that pid and
	 *  start time never come back; any other verdict is reused for
	 *  `identifyEveryMs`. `fresh` always checks (a stop must never signal a
	 *  pid that is someone else's now). */
	#identityOf(id: string, runner: { readonly pid: number; readonly startedAt: string }, fresh = false): RunnerIdentity {
		const key = `${runner.pid}:${runner.startedAt}`;
		const cached = this.#identity.get(id);
		if (cached !== undefined && cached.key === key && (cached.verdict === "gone" || (!fresh && Date.now() - cached.at < this.#identifyEveryMs))) return cached.verdict;
		const verdict = this.#backend.identify(runner.pid, runner.startedAt);
		this.#identity.set(id, { key, verdict, at: Date.now() });
		return verdict;
	}

	/** Hear every transition (delivery, the terminal, telemetry — any number
	 *  of them). Returns the unsubscribe. */
	subscribe(listener: TaskListener): () => void {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}

	/** A new task directory, durable before anything is recorded in it: the
	 *  session's task root (and its entry in the store directory), then the
	 *  task's own directory. */
	#newTaskDir(): { readonly id: string; readonly dir: string } {
		if (!existsSync(this.root)) {
			mkdirSync(this.root, { recursive: true });
			fsyncDir(dirname(this.root));
		}
		const id = this.#nextId();
		const dir = join(this.root, id);
		mkdirSync(dir);
		fsyncDir(this.root);
		return { id, dir };
	}

	/** Start a task. `planned` is durable before the runner is spawned. */
	async start(options: TaskStartOptions): Promise<TaskInfo> {
		const { id, dir } = this.#newTaskDir();
		const exec = options.exec?.(dir);
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
			...(exec !== undefined ? { launch: { kind: "exec" as const, file: exec.file, args: [...exec.args] } } : {}),
			...(options.agent !== undefined ? { agent: options.agent } : {}),
		});
		// the journal's own directory entry: without it, a power loss could
		// erase a `planned` whose runner was spawned — "no planned ⇒ never
		// spawned" holds only once this is durable
		fsyncDir(dir);
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
		const { id, dir } = this.#newTaskDir();
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
		fsyncDir(dir);
		if (options.ready === true && options.readyWhen !== undefined) {
			appendRecord(journal, { type: "ready", ts: Date.now(), match: options.readyWhen });
			// the promotion's own result says "ready —": that call reports it
			if (options.executionId !== undefined) appendRecord(journal, { type: "result_claimed", ts: Date.now(), transition: "ready", executionId: options.executionId });
		}
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

	/** Stop a live task: `stop_requested` is durable first — the runner
	 *  watches its journal for it — then a VERIFIED runner is also signalled.
	 *  An unverifiable one is never signalled (its pid may be a stranger's
	 *  now); the record alone reaches it if it is ours. False when there is
	 *  nothing that could be stopped. */
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
		const identity = this.#identityOf(id, runner, true);
		if (identity === "gone") return false;
		appendRecord(join(this.root, id, JOURNAL), { type: "stop_requested", ts: Date.now(), by });
		if (identity === "verified") this.#backend.signalStop(runner.pid);
		return true;
	}

	/** ADR-0058 Amendment 7: wait up to `ms` for task `id` to reach `until`
	 *  — "end" (ended, unknown, never run) or "ready" (ready, or any end) —
	 *  on behalf of a tool call whose result will report it. While it waits
	 *  the watcher never announces this task. What it observes is CLAIMED
	 *  for `executionId` — the caller's own execution: `result_claimed` is
	 *  durable first, then the transition counts as seen, so it is never
	 *  announced. A timeout, an abort, no execution id, an agent task (its
	 *  end belongs to its group, 3d) or a claim that cannot be written
	 *  claim nothing: the transition is announced as before. */
	async awaitSettled(id: string, until: "end" | "ready", ms: number, opts: { readonly executionId?: string; readonly signal?: AbortSignalLike } = {}): Promise<TaskSettled> {
		if (this.get(id) === undefined) throw new Error(`no task ${id} in this session`);
		this.#waiting.set(id, (this.#waiting.get(id) ?? 0) + 1);
		let aborted = opts.signal?.aborted === true;
		let wake = (): void => {};
		const onAbort = (): void => {
			aborted = true;
			wake();
		};
		opts.signal?.addEventListener("abort", onAbort);
		try {
			const deadline = Date.now() + ms;
			for (;;) {
				const info = this.#info(id)!;
				const reached = endTransitionOf(info) ?? (until === "ready" && info.state.kind === "running" && info.state.ready ? "ready" : null);
				if (reached !== null) return { info, settled: true, claimed: this.#claim(info, reached, opts.executionId) };
				const left = deadline - Date.now();
				if (aborted || left <= 0) return { info, settled: false, claimed: false };
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(100, left));
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
			const n = (this.#waiting.get(id) ?? 1) - 1;
			if (n > 0) this.#waiting.set(id, n);
			else this.#waiting.delete(id);
		}
	}

	/** The frozen order: the claim durable, THEN seen — an append that fails
	 *  leaves the transition unseen, to be announced (a duplicate is the
	 *  lesser evil next to a lost transition). */
	#claim(info: TaskInfo, transition: ClaimedTransition, executionId: string | undefined): boolean {
		if (executionId === undefined || info.agent !== undefined) return false;
		try {
			appendRecord(join(this.root, info.id, JOURNAL), { type: "result_claimed", ts: Date.now(), transition, executionId });
		} catch {
			return false;
		}
		this.#seen.set(info.id, this.#kindOf(info));
		return true;
	}

	/** 3e: a running foreground command that can become a task now —
	 *  registered by its owner while it runs; returns the unregister. Every
	 *  detach goes through here (ADR-0058 §6): the person's key, a steer. */
	registerDetachable(executionId: string, detachable: Detachable): () => void {
		this.#detachable.set(executionId, detachable);
		return () => {
			if (this.#detachable.get(executionId) === detachable) this.#detachable.delete(executionId);
		};
	}

	/** Detach one registered execution. It is unregistered BEFORE it is
	 *  asked, so a second detach — two steers, a key racing a pending
	 *  auto-detach — is a no-op: one promotion, one task. */
	detach(executionId: string, by: DetachBy): boolean {
		const d = this.#detachable.get(executionId);
		if (d === undefined) return false;
		this.#detachable.delete(executionId);
		d.detach(by);
		return true;
	}

	/** Detach every registered execution; the ids that were detached. */
	detachAll(by: DetachBy): string[] {
		return [...this.#detachable.keys()].filter((id) => this.detach(id, by));
	}

	/** What can be detached now, with when each started. */
	detachable(): { readonly executionId: string; readonly startedAt: number }[] {
		return [...this.#detachable].map(([executionId, d]) => ({ executionId, startedAt: d.startedAt }));
	}

	/** A clean exit: stop every live task — or, `which: "moved"`, only the
	 *  ones this process owns (promoted foreground commands; a runner's task
	 *  is left running) — and wait for their terminals, up to `graceMs`.
	 *  Returns the ids still without a terminal: a stop REQUESTED, never
	 *  confirmed (3e). */
	async stopAll(by: "person" | "exit" = "exit", graceMs = 8_000, which: "all" | "moved" = "all"): Promise<string[]> {
		// every task not ended is asked; a corrupt journal is skipped here
		// (it fails loudly where it is read on purpose) — an exit still exits
		const kindOf = (id: string): string => {
			try {
				return this.#info(id)!.state.kind;
			} catch {
				return "corrupt";
			}
		};
		const moved = (id: string): boolean => {
			try {
				return this.#info(id)!.backend === "foreground";
			} catch {
				return false;
			}
		};
		const live = this.#ids().filter((id) => ["running", "starting", "unknown"].includes(kindOf(id)) && (which === "all" || moved(id)));
		const asked = live.filter((id) => this.stop(id, by));
		const deadline = Date.now() + graceMs;
		let left = asked;
		while (left.length > 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
			left = left.filter((id) => kindOf(id) !== "ended");
		}
		return left;
	}

	/** Start watching: every task is classified now (no transition for what
	 *  it already is), and live ones are re-read until they settle. */
	observe(): void {
		for (const id of this.#ids()) {
			if (this.#seen.has(id)) continue;
			try {
				this.#seen.set(id, this.#kindOf(this.#info(id)!));
			} catch {
				// a corrupt journal: left unclassified, and read loudly on purpose
			}
		}
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
			// a tool call is waiting on it: what it sees, its result reports
			if (this.#waiting.has(id)) continue;
			const before = this.#seen.get(id);
			if (before === "ended" || before === "unknown" || before === "not_run") continue;
			let info: TaskInfo;
			try {
				info = this.#info(id)!;
			} catch {
				continue; // a corrupt journal: reported where it is read, never here in the background
			}
			const now = this.#kindOf(info);
			if (now === before) continue;
			this.#seen.set(id, now);
			const transition: TaskTransition | null =
				now === "ready" ? "ready" : now === "ended" ? "ended" : now === "unknown" ? "unknown" : now === "not_run" ? "not_run" : null;
			if (transition !== null) for (const listener of this.#listeners) listener(info, transition);
		}
	}

	#kindOf(info: TaskInfo): string {
		return info.state.kind === "running" && info.state.ready ? "ready" : info.state.kind;
	}

	#info(id: string): TaskInfo | undefined {
		const records = readRecords(join(this.root, id, JOURNAL));
		const planned = records.find((r): r is Extract<TaskRecord, { type: "planned" }> => r.type === "planned");
		const runner = runnerOf(records);
		const terminal = records.find((r) => r.type === "terminal");
		// an adopted task this very process still owns needs no identity
		// check: the owner is here, holding the child; and an ended task's
		// verdict is its terminal — identity cannot change it (Windows P6)
		const verified =
			this.#local.has(id) || (terminal === undefined && runner !== undefined && this.#identityOf(id, runner) === "verified");
		const stop = records.find((r): r is Extract<TaskRecord, { type: "stop_requested" }> => r.type === "stop_requested");
		const claims = records
			.filter((r): r is Extract<TaskRecord, { type: "result_claimed" }> => r.type === "result_claimed")
			.map((r) => ({ transition: r.transition, executionId: r.executionId }));
		return {
			id,
			command: planned?.command ?? "",
			profile: planned?.profile ?? "oneshot",
			backend: planned?.backend ?? "process",
			...(planned?.executionId !== undefined ? { executionId: planned.executionId } : {}),
			...(stop !== undefined ? { stoppedBy: stop.by } : {}),
			...(planned?.agent !== undefined ? { agent: planned.agent } : {}),
			state: verdictOf(records, verified),
			outputPath: join(this.root, id, OUTPUT),
			startedAt: planned?.ts ?? 0,
			...(terminal !== undefined ? { endedAt: terminal.ts } : {}),
			...(claims.length > 0 ? { claims } : {}),
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
