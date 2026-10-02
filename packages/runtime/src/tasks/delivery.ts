/**
 * ADR-0058 §7–§8, step 3c — a task's transitions reach the model.
 *
 * One delivery per session. It hears the TaskManager's transitions,
 * decides each by the §8 defaults (silent | notify | wake), merges what
 * arrives within a window into ONE notice, and hands it on:
 *
 *   a live run      → `run.notify` — admitted at the next safe point, in
 *                     arrival order with the person's steers (ADR-0057);
 *   an idle session → held for the next run a person starts, or — when a
 *                     transition asks to wake — ONE continuation run whose
 *                     first input is the notice (the host starts it, after
 *                     the previous run has fully settled).
 *
 * Exactly once, from the log: a transition counts as delivered when a
 * `user_input` whose `via.items` names it is in the session's log (ADR-0051
 * Amendment 8). The set is a cache rebuilt from the log, never a second
 * truth. Lineage from the log too: a task started inside a wake run (a run
 * whose first input is a task notice) never wakes — depth 1.
 *
 * The summary snapshot is what the MODEL was told, never the live journal:
 * a compaction must not reveal a transition that has not been delivered.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isRuntimeInput, type Event, type TaskDeliveryItem, type UserInputVia } from "@vincemakes/kiso-core";
import { NOTICE_FOOTER as FOOTER, type Run, type TaskNotice } from "../run.js";
import type { TaskInfo, TaskManager, TaskTransition } from "./manager.js";

type Mode = "silent" | "notify" | "wake";

export interface TaskDeliveryOptions {
	readonly manager: TaskManager;
	/** The session's durable events: receipts and lineage are read here. */
	readonly events: () => readonly Event[];
	/** The session's live run, when one is running. */
	readonly liveRun: () => Run | undefined;
	/** False turns every wake into a notify (the switch, ADR-0058 §8.4). */
	readonly wake?: boolean;
	/** Start ONE continuation run whose first input is this notice. */
	readonly onWake?: (input: { readonly content: string; readonly via: UserInputVia }) => void;
	/** Transitions within this window merge into one notice. Default 1 s. */
	readonly windowMs?: number;
	/** How much of a failed task's output rides its notice. Default 2 KB. */
	readonly tailBytes?: number;
	/** Read a task's output tail (injectable for tests). */
	readonly readTail?: (task: TaskInfo, bytes: number) => string;
}

interface Pending {
	readonly notice: TaskNotice;
	readonly wake: boolean;
}

const key = (i: TaskDeliveryItem): string => `${i.taskId}:${i.transition}`;

export class TaskDelivery {
	readonly #o: TaskDeliveryOptions;
	readonly #receipts = new Set<string>();
	#scanned = 0;
	/** handed to a run, not yet seen landing in the log */
	readonly #inFlight = new Set<string>();
	#buffer: { item: TaskDeliveryItem; line: string; mode: Mode }[] = [];
	#timer: ReturnType<typeof setTimeout> | null = null;
	#pending: Pending[] = [];
	/** a wake was asked for and its run has not begun: no second wake */
	#waking = false;
	readonly #unsubscribe: () => void;

	constructor(options: TaskDeliveryOptions) {
		this.#o = options;
		this.#unsubscribe = options.manager.subscribe((task, transition) => this.#hear(task, transition));
		// a restart: what ended while nobody listened, and was never
		// delivered, is delivered now as a notify — never a wake at startup
		this.#scan();
		const missed: { item: TaskDeliveryItem; line: string }[] = [];
		for (const task of this.#safeList()) {
			const item = itemOf(task);
			if (item === null || item.transition === "ready" || this.#receipts.has(key(item))) continue;
			missed.push({ item, line: this.#line(task, item) });
		}
		if (missed.length > 0) this.#pending.push({ notice: { lines: missed.map((m) => m.line), items: missed.map((m) => m.item) }, wake: false });
	}

	close(): void {
		this.#unsubscribe();
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** A run a person started: pending notices ride its first admission. */
	takeForRun(run: Run): void {
		this.#waking = false;
		for (const p of this.#pending.splice(0)) this.#hand(run, p.notice);
	}

	/** The run has fully settled (its terminal durable, the slot free):
	 *  notices it never admitted come back, and a wake may start. */
	onRunSettled(run: Run): void {
		for (const notice of run.unadmittedNotices()) {
			for (const i of notice.items) this.#inFlight.delete(key(i));
			this.#pending.push({ notice, wake: notice.items.some((i) => this.#wakes(i)) });
		}
		this.#scan();
		// never start a run from inside the settling one
		setTimeout(() => this.#pump(), 0);
	}

	/** The conversation's view of its tasks for a summary: a task the model
	 *  was told started, at the last transition it was TOLD about. Empty
	 *  when the model knows of no task. Told started = a durable, successful
	 *  tool_result for the execution that started it — a started execution
	 *  with no result (the crash window), or one resolved as not applied,
	 *  never told the model a task exists. */
	snapshot(events: readonly Event[]): string {
		const started = new Set(events.filter((e): e is Event & { type: "tool_result" } => e.type === "tool_result" && !e.isError && e.executionId !== undefined).map((e) => e.executionId));
		const told = new Map<string, string>();
		for (const e of events) {
			if (e.type !== "user_input" || e.via?.kind !== "tasks") continue;
			for (const i of e.via.items) told.set(i.taskId, i.transition);
		}
		const rows: string[] = [];
		for (const task of this.#safeList()) {
			if (task.executionId === undefined || !started.has(task.executionId)) continue;
			rows.push(`${task.id} ${told.get(task.id) ?? "running"} — ${task.command}`);
		}
		return rows.length === 0 ? "" : `Background tasks, as you were last told: ${rows.join("; ")}.`;
	}

	#hear(task: TaskInfo, transition: TaskTransition): void {
		const item = itemOf(task, transition);
		if (item === null) return;
		const mode = this.#modeOf(task, item);
		if (mode === "silent") return;
		this.#buffer.push({ item, line: this.#line(task, item), mode });
		if (this.#timer === null) this.#timer = setTimeout(() => this.#flush(), this.#o.windowMs ?? 1_000);
	}

	#flush(): void {
		this.#timer = null;
		this.#scan();
		const held = new Set(this.#pending.flatMap((p) => p.notice.items.map(key)));
		const fresh = this.#buffer.splice(0).filter((b) => !this.#receipts.has(key(b.item)) && !this.#inFlight.has(key(b.item)) && !held.has(key(b.item)));
		if (fresh.length === 0) return;
		const notice: TaskNotice = { lines: fresh.map((b) => b.line), items: fresh.map((b) => b.item) };
		const run = this.#o.liveRun();
		if (run !== undefined && this.#hand(run, notice)) return;
		this.#pending.push({ notice, wake: fresh.some((b) => b.mode === "wake") });
		this.#pump();
	}

	/** Idle: a pending wake starts ONE run carrying everything pending. */
	#pump(): void {
		if (this.#waking || this.#o.liveRun() !== undefined || this.#pending.length === 0) return;
		if (this.#o.wake === false || this.#o.onWake === undefined || !this.#pending.some((p) => p.wake)) return;
		const all = this.#pending.splice(0);
		const items = all.flatMap((p) => p.notice.items);
		for (const i of items) this.#inFlight.add(key(i));
		const content = [...all.flatMap((p) => p.notice.lines), FOOTER].join("\n");
		this.#waking = true;
		this.#o.onWake({ content, via: { kind: "tasks", items } });
	}

	#hand(run: Run, notice: TaskNotice): boolean {
		if (!run.notify(notice)) {
			this.#pending.push({ notice, wake: notice.items.some((i) => this.#wakes(i)) });
			return false;
		}
		for (const i of notice.items) this.#inFlight.add(key(i));
		return true;
	}

	/** The receipts cache, extended from the log since the last scan. */
	#scan(): void {
		const events = this.#o.events();
		for (let n = this.#scanned; n < events.length; n++) {
			const e = events[n]!;
			if (e.type !== "user_input" || e.via?.kind !== "tasks") continue;
			for (const i of e.via.items) {
				this.#receipts.add(key(i));
				this.#inFlight.delete(key(i));
			}
		}
		this.#scanned = events.length;
	}

	/** ADR-0058 §8 defaults, then the guards: the switch, and lineage. */
	#modeOf(task: TaskInfo, item: TaskDeliveryItem): Mode {
		if (item.transition === "ready" || item.transition === "stopped" || item.transition === "unknown") return "notify";
		if (task.executionId === undefined) return "notify"; // started by the person: never a wake
		if (task.profile === "service") return "notify"; // a service's unexpected exit
		return this.#wakes(item) ? "wake" : "notify";
	}

	#wakes(item: TaskDeliveryItem): boolean {
		if (this.#o.wake === false) return false;
		if (item.transition !== "exited" && item.transition !== "failed") return false;
		const task = this.#o.manager.get(item.taskId);
		if (task === undefined || task.executionId === undefined || task.profile === "service") return false;
		return !this.#startedInWakeRun(task.executionId);
	}

	/** Lineage depth 1: the run that started the task began with a notice. */
	#startedInWakeRun(executionId: string): boolean {
		const events = this.#o.events();
		const at = events.findIndex((e) => e.type === "tool_execution_started" && e.executionId === executionId);
		if (at < 0) return false;
		let start = 0;
		for (let n = at - 1; n >= 0; n--) {
			if (events[n]!.type === "terminal") {
				start = n + 1;
				break;
			}
		}
		const first = events.slice(start, at).find((e): e is Event & { type: "user_input" } => e.type === "user_input");
		return isRuntimeInput(first);
	}

	#line(task: TaskInfo, item: TaskDeliveryItem): string {
		const attrs = [`id="${task.id}"`, `status="${item.transition}"`];
		if (task.state.kind === "ended" && task.state.exitCode !== null) attrs.push(`code="${task.state.exitCode}"`);
		if (task.state.kind === "ended" && task.state.signal !== null) attrs.push(`signal="${task.state.signal}"`);
		if (task.endedAt !== undefined) attrs.push(`duration="${duration(task.endedAt - task.startedAt)}"`);
		attrs.push(`output="${task.outputPath}"`);
		const tag = `<kiso-task ${attrs.join(" ")}/>`;
		if (item.transition !== "failed") return tag;
		if (task.state.kind === "ended" && task.state.error !== undefined) return `${tag}\nerror: ${task.state.error}`;
		const tail = (this.#o.readTail ?? readTail)(task, this.#o.tailBytes ?? 2_048);
		return tail === "" ? tag : `${tag}\n${tail}`;
	}

	#safeList(): TaskInfo[] {
		try {
			return this.#o.manager.list();
		} catch {
			return []; // a corrupt journal is reported where it is read on purpose
		}
	}
}

/** The transition a task's state stands for, as a receipt names it. */
function itemOf(task: TaskInfo, transition?: TaskTransition): TaskDeliveryItem | null {
	const s = task.state;
	const t = (x: TaskDeliveryItem["transition"]): TaskDeliveryItem => ({ taskId: task.id, transition: x });
	if (transition === "ready") return t("ready");
	if (s.kind === "ended") {
		if (task.stoppedBy !== undefined) return t("stopped");
		return s.exitCode === 0 && s.error === undefined ? t("exited") : t("failed");
	}
	if (s.kind === "unknown") return t("unknown");
	if (s.kind === "not_run") return t("failed");
	return null;
}

function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function readTail(task: TaskInfo, bytes: number): string {
	try {
		const fd = openSync(task.outputPath, "r");
		try {
			const size = fstatSync(fd).size;
			const n = Math.min(size, bytes);
			const buf = Buffer.alloc(n);
			readSync(fd, buf, 0, n, size - n);
			return (size > n ? "…" : "") + buf.toString("utf8").trimEnd();
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
