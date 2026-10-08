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
 * truth. The chain budget from the log too (ADR-0058 Amendment 9): the wake
 * runs since the last run a person started are counted, never kept.
 *
 * The summary snapshot is what the MODEL was told, never the live journal:
 * a compaction must not reveal a transition that has not been delivered.
 *
 * A transition a tool result reports (ADR-0058 Amendment 7) is CLAIMED in
 * the task journal by that execution and never noticed — the manager does
 * not announce it, and a restart does not deliver it. The claim decides
 * only that; what the model knows stays the log's: the summary learns a
 * claimed transition from the claiming execution's durable, successful
 * tool_result, never from the journal alone.
 *
 * Background children (ADR-0058 3d) arrive as a GROUP: the agent tasks
 * started by the calls of one model turn. The group closes once that turn
 * has ended and every call in it has its result — before that, a fast
 * child's end says nothing about the group. A closed group whose members
 * have all ended is delivered ONCE: every member's line, then excerpts of
 * the answers (result.md, which the child wrote) within 4 KiB each and
 * 16 KiB together; members already delivered are named as reported, and
 * only the rest are receipted. A failure goes into a live run at once and
 * never wakes on its own; idle, it waits for its group.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRuntimeInput, type Event, type TaskDeliveryItem, type UserInputVia } from "@vincemakes/kiso-core";
import { NOTICE_FOOTER as FOOTER, type Run, type TaskNotice } from "../run.js";
import { endTransitionOf, type TaskInfo, type TaskManager, type TaskTransition } from "./manager.js";

type Mode = "silent" | "notify" | "wake";

export interface TaskDeliveryOptions {
	readonly manager: TaskManager;
	/** The session's durable events: receipts and the chain are read here. */
	readonly events: () => readonly Event[];
	/** The session's live run, when one is running. */
	readonly liveRun: () => Run | undefined;
	/** False turns every wake into a notify (the switch, ADR-0058 §8.4). */
	readonly wake?: boolean;
	/** ADR-0058 Amendment 9 — the chain budget: how many autonomous wakes may follow
	 *  one person's input before a terminal delivers as a notify instead.
	 *  Replaces ADR-0058 §8 guard 3 (lineage depth 1). Default 20. */
	readonly maxWakes?: number;
	/** Start ONE continuation run whose first input is this notice. */
	readonly onWake?: (input: { readonly content: string; readonly via: UserInputVia }) => void;
	/** Transitions within this window merge into one notice. Default 1 s. */
	readonly windowMs?: number;
	/** ADR-0058 Amendment 8: a loss the model has not been told of, at
	 *  startup or as it is heard — the person can be told at once, while
	 *  the model's notice keeps its own turn. A claimed loss never comes. */
	readonly onLost?: (taskIds: readonly string[]) => void;
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
export const DEFAULT_MAX_WAKES = 20;

/** ADR-0058 3d (D3): a child's excerpt, and a group's excerpts together. */
const CHILD_EXCERPT_BYTES = 4_096;
const GROUP_EXCERPT_BYTES = 16_384;

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
	/** ended agent tasks waiting for their group (restart: heard at startup) */
	readonly #ended = new Map<string, { readonly restart: boolean }>();
	#recheck: ReturnType<typeof setTimeout> | null = null;
	readonly #unsubscribe: () => void;

	constructor(options: TaskDeliveryOptions) {
		this.#o = options;
		this.#unsubscribe = options.manager.subscribe((task, transition) => this.#hear(task, transition));
		// a restart: what ended while nobody listened, and was never
		// delivered, is delivered now as a notify — never a wake at startup
		this.#scan();
		const missed: { item: TaskDeliveryItem; line: string }[] = [];
		const lost: string[] = [];
		for (const task of this.#safeList()) {
			const item = itemOf(task);
			if (item === null || item.transition === "ready" || this.#receipts.has(key(item))) continue;
			// a tool result reported it: the claim alone decides (Amendment 7)
			if (task.claims?.some((c) => c.transition === item.transition) === true) continue;
			if (item.transition === "unknown") lost.push(task.id);
			if (task.agent !== undefined) this.#ended.set(task.id, { restart: true });
			else missed.push({ item, line: this.#line(task, item) });
		}
		if (missed.length > 0) this.#pending.push({ notice: { lines: missed.map((m) => m.line), items: missed.map((m) => m.item) }, wake: false });
		if (this.#ended.size > 0) this.#groups();
		if (lost.length > 0) options.onLost?.(lost);
	}

	close(): void {
		this.#unsubscribe();
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#recheck !== null) clearTimeout(this.#recheck);
		this.#recheck = null;
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
		// its turns have all ended: a group held open by one may close
		if (this.#ended.size > 0) this.#groups();
		// never start a run from inside the settling one
		setTimeout(() => this.#pump(), 0);
	}

	/** The conversation's view of its tasks for a summary: a task the model
	 *  was told started, at the last transition it was TOLD about. Empty
	 *  when the model knows of no task. Told started = a durable, successful
	 *  tool_result for the execution that started it — a started execution
	 *  with no result (the crash window), or one resolved as not applied,
	 *  never told the model a task exists. Told a transition = a notice
	 *  naming it, or (Amendment 7) a durable, successful tool_result of the
	 *  execution that claimed it — in log order, the last one wins. */
	snapshot(events: readonly Event[]): string {
		const isTold = (e: Event): e is Event & { type: "tool_result" } => e.type === "tool_result" && !e.isError && e.executionId !== undefined;
		const started = new Set(events.filter(isTold).map((e) => e.executionId));
		const tasks = this.#safeList();
		const claimedBy = new Map<string, { readonly taskId: string; readonly transition: string }[]>();
		for (const task of tasks) for (const c of task.claims ?? []) claimedBy.set(c.executionId, [...(claimedBy.get(c.executionId) ?? []), { taskId: task.id, transition: c.transition }]);
		const told = new Map<string, string>();
		for (const e of events) {
			if (isTold(e)) for (const c of claimedBy.get(e.executionId!) ?? []) told.set(c.taskId, c.transition);
			if (e.type !== "user_input" || e.via?.kind !== "tasks") continue;
			for (const i of e.via.items) told.set(i.taskId, i.transition);
		}
		const rows: string[] = [];
		for (const task of tasks) {
			if (task.executionId === undefined || !started.has(task.executionId)) continue;
			rows.push(`${task.id} ${told.get(task.id) ?? "running"} — ${task.command}`);
		}
		return rows.length === 0 ? "" : `Background tasks, as you were last told: ${rows.join("; ")}.`;
	}

	#hear(task: TaskInfo, transition: TaskTransition): void {
		const item = itemOf(task, transition);
		if (item === null) return;
		if (item.transition === "unknown") this.#o.onLost?.([task.id]);
		if (task.agent !== undefined && item.transition !== "ready") return this.#agentEnded(task, item);
		const mode = this.#modeOf(task, item);
		if (mode === "silent") return;
		const spent = mode === "notify" && this.#eligible(task, item) && !this.#underBudget();
		this.#buffer.push({ item, line: spent ? `${this.#line(task, item)}\nchain budget spent: ${this.#wakesSinceLastPerson()} autonomous wakes since the person's last message — continue when they speak` : this.#line(task, item), mode });
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

	#hand(run: Run, notice: TaskNotice, wake?: boolean): boolean {
		if (!run.notify(notice)) {
			this.#pending.push({ notice, wake: wake ?? notice.items.some((i) => this.#wakes(i)) });
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

	/** ADR-0058 §8 defaults, then the guards: the switch, and the chain budget. */
	#modeOf(task: TaskInfo, item: TaskDeliveryItem): Mode {
		if (item.transition === "ready" || item.transition === "stopped" || item.transition === "unknown") return "notify";
		if (task.executionId === undefined) return "notify"; // started by the person: never a wake
		if (task.profile === "service") return "notify"; // a service's unexpected exit
		return this.#wakes(item) ? "wake" : "notify";
	}

	#wakes(item: TaskDeliveryItem): boolean {
		const task = this.#o.manager.get(item.taskId);
		if (task === undefined || !this.#eligible(task, item)) return false;
		// a child wakes only with its whole group (D2): never on its own
		if (task.agent !== undefined && !this.#complete(this.#groupOf(task))) return false;
		return this.#underBudget();
	}

	/** The transition could wake, budget aside: the switch, a terminal, an
	 *  execution's task, not a service. */
	#eligible(task: TaskInfo, item: TaskDeliveryItem): boolean {
		if (this.#o.wake === false) return false;
		if (item.transition !== "exited" && item.transition !== "failed") return false;
		if (task.executionId === undefined || task.profile === "service") return false;
		return true;
	}

	/** ADR-0058 Amendment 9: the chain budget, derived from the log — never a
	 *  counter. The count is the wake runs (first input a runtime notice)
	 *  since the last run a person started. */
	#underBudget(): boolean {
		return this.#wakesSinceLastPerson() < (this.#o.maxWakes ?? DEFAULT_MAX_WAKES);
	}

	#wakesSinceLastPerson(): number {
		let wakes = 0;
		let firstOfRun = true;
		for (const e of this.#o.events()) {
			if (e.type === "terminal") {
				firstOfRun = true;
				continue;
			}
			if (e.type !== "user_input" || !firstOfRun) continue;
			firstOfRun = false;
			wakes = isRuntimeInput(e) ? wakes + 1 : 0;
		}
		return wakes;
	}

	/** ADR-0058 3d: an agent task has ended — a failure goes into a live run
	 *  at once; every end waits for its group. */
	#agentEnded(task: TaskInfo, item: TaskDeliveryItem): void {
		if (this.#known(key(item)) || this.#ended.has(task.id)) return;
		const run = this.#o.liveRun();
		if (item.transition === "failed" && run !== undefined) this.#hand(run, { lines: [`${this.#agentTag(task, item)}${excerptOf(task, CHILD_EXCERPT_BYTES).text}`], items: [item] });
		this.#ended.set(task.id, { restart: false });
		this.#groups();
	}

	/** Deliver every closed group whose members have all ended; look again
	 *  later while a group is still open. */
	#groups(): void {
		if (this.#recheck !== null) clearTimeout(this.#recheck);
		this.#recheck = null;
		this.#scan();
		let open = false;
		const seen = new Set<string>();
		for (const id of [...this.#ended.keys()]) {
			if (seen.has(id) || !this.#ended.has(id)) continue;
			const task = this.#o.manager.get(id);
			if (task === undefined) {
				this.#ended.delete(id);
				continue;
			}
			const group = this.#groupOf(task);
			for (const m of group.members) seen.add(m);
			if (!group.closed) open = true;
			else if (this.#complete(group)) this.#deliverGroup(group.members);
		}
		if (open) {
			this.#recheck = setTimeout(() => this.#groups(), this.#o.windowMs ?? 1_000);
			(this.#recheck as { unref?: () => void }).unref?.();
		}
	}

	/** The group an agent task belongs to — derived from the log, never
	 *  stored: the model turn holding the call that started it. Closed once
	 *  that turn has ended and every call in it has its result — or the run
	 *  that held it has ended, when no more results can come. A call an
	 *  abandoned attempt voided never runs and is not waited for. A task the
	 *  log cannot place is a group of one. */
	#groupOf(task: TaskInfo): { readonly closed: boolean; readonly members: readonly string[] } {
		const alone = { closed: true, members: [task.id] };
		if (task.executionId === undefined) return alone;
		const events = this.#o.events();
		const started = events.find((e): e is Event & { type: "tool_execution_started" } => e.type === "tool_execution_started" && e.executionId === task.executionId);
		const at = started?.invocationSeq === undefined ? -1 : events.findIndex((e) => e.seq === started.invocationSeq);
		if (at < 0) return alone;
		const boundary = (e: Event): boolean => e.type === "stop" || e.type === "terminal";
		let from = at;
		while (from > 0 && !boundary(events[from - 1]!) && events[from - 1]!.type !== "user_input") from--;
		let to = at;
		while (to < events.length && !boundary(events[to]!)) to++;
		const voided = events.filter((e): e is Event & { type: "model_output_abandoned" } => e.type === "model_output_abandoned").map((e) => [e.voidFromSeq, e.seq] as const);
		const calls = new Set(events.slice(from, to).filter((e) => e.type === "tool_call_end" && !voided.some(([lo, hi]) => e.seq > lo && e.seq <= hi)).map((e) => e.seq));
		const runEnded = events.slice(to).some((e) => e.type === "terminal");
		const answered = new Set(events.filter((e): e is Event & { type: "tool_result" } => e.type === "tool_result").map((e) => e.invocationSeq));
		const executions = new Set(events.filter((e): e is Event & { type: "tool_execution_started" } => e.type === "tool_execution_started" && e.invocationSeq !== undefined && calls.has(e.invocationSeq)).map((e) => e.executionId));
		const members = this.#safeList()
			.filter((t) => t.agent !== undefined && t.executionId !== undefined && executions.has(t.executionId))
			.map((t) => t.id);
		return { closed: to < events.length && (runEnded || [...calls].every((c) => answered.has(c))), members: members.includes(task.id) ? members : [...members, task.id] };
	}

	#complete(group: { readonly closed: boolean; readonly members: readonly string[] }): boolean {
		return group.closed && group.members.every((id) => {
			const kind = this.#o.manager.get(id)?.state.kind;
			return kind === undefined || kind === "ended" || kind === "unknown" || kind === "not_run";
		});
	}

	/** ONE notice for a complete group: every member's line, excerpts within
	 *  the budget, receipts only for what was not delivered before. */
	#deliverGroup(members: readonly string[]): void {
		const restart = members.some((id) => this.#ended.get(id)?.restart === true);
		for (const id of members) this.#ended.delete(id);
		const tasks = members.map((id) => this.#o.manager.get(id)).filter((t): t is TaskInfo => t !== undefined);
		const fresh: { task: TaskInfo; item: TaskDeliveryItem }[] = [];
		const lines: string[] = [];
		for (const task of tasks) {
			const item = itemOf(task);
			if (item === null) continue;
			if (this.#receipts.has(key(item)) || this.#inFlight.has(key(item))) {
				lines.push(`<kiso-task id="${task.id}" kind="agent" role="${task.agent?.role ?? ""}" status="${item.transition}" reported="earlier"/>`);
				continue;
			}
			this.#unpend(key(item)); // held for the next run: it rides this notice instead
			fresh.push({ task, item });
		}
		if (fresh.length === 0) return;
		let budget = GROUP_EXCERPT_BYTES;
		for (const { task, item } of fresh) {
			const excerpt = excerptOf(task, Math.min(CHILD_EXCERPT_BYTES, budget));
			budget -= excerpt.bytes;
			lines.push(`${this.#agentTag(task, item)}${excerpt.text}`);
		}
		const items = fresh.map((f) => f.item);
		const notice: TaskNotice = { lines, items };
		const wake = !restart && items.some((i) => this.#wakes(i));
		const run = this.#o.liveRun();
		if (run !== undefined && this.#hand(run, notice, wake)) return;
		if (run === undefined) this.#pending.push({ notice, wake });
		this.#pump();
	}

	/** handed to a run, or held for one, or already in the log */
	#known(k: string): boolean {
		return this.#receipts.has(k) || this.#inFlight.has(k) || this.#pending.some((p) => p.notice.items.some((i) => key(i) === k));
	}

	/** A pending notice holding only `k` (a child's failure held for the
	 *  next run) is dropped: its group's notice carries it now. */
	#unpend(k: string): void {
		this.#pending = this.#pending.filter((p) => !(p.notice.items.length === 1 && key(p.notice.items[0]!) === k));
	}

	#agentTag(task: TaskInfo, item: TaskDeliveryItem): string {
		const attrs = [`id="${task.id}"`, `kind="agent"`, `role="${task.agent?.role ?? ""}"`, `status="${item.transition}"`];
		const outcome = outcomeOf(task);
		if (outcome !== undefined) attrs.push(`outcome="${outcome}"`);
		if (task.agent !== undefined) attrs.push(`session="${task.agent.session}"`);
		if (task.endedAt !== undefined) attrs.push(`duration="${duration(task.endedAt - task.startedAt)}"`);
		const result = resultPath(task);
		attrs.push(existsSync(result) ? `result="${result}"` : `output="${task.outputPath}"`);
		return `<kiso-task ${attrs.join(" ")}/>`;
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
	if (transition === "ready") return { taskId: task.id, transition: "ready" };
	const end = endTransitionOf(task);
	return end === null ? null : { taskId: task.id, transition: end };
}

const resultPath = (task: TaskInfo): string => join(dirname(task.outputPath), "result.md");

/** The child's outcome, as it wrote it beside its answer. */
function outcomeOf(task: TaskInfo): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dirname(task.outputPath), "result.json"), "utf8")) as { outcome?: unknown };
		return typeof parsed.outcome === "string" ? parsed.outcome : undefined;
	} catch {
		return undefined;
	}
}

/** A child's answer (result.md) cut to `bytes`, or — with no answer — the
 *  tail of what it printed. `bytes` counts the excerpt, never the pointer. */
function excerptOf(task: TaskInfo, bytes: number): { readonly text: string; readonly bytes: number } {
	const path = resultPath(task);
	let answer: string;
	try {
		answer = readFileSync(path, "utf8").trimEnd();
	} catch {
		const tail = bytes > 0 ? readTail(task, Math.min(bytes, 2_048)) : "";
		return tail === "" ? { text: "", bytes: 0 } : { text: `\n${tail}`, bytes: Buffer.byteLength(tail) };
	}
	if (answer === "") return { text: "", bytes: 0 };
	const size = Buffer.byteLength(answer);
	if (size <= bytes) return { text: `\n${answer}`, bytes: size };
	if (bytes <= 0) return { text: `\n[the whole answer: ${path}]`, bytes: 0 };
	const cut = Buffer.from(answer).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "");
	return { text: `\n${cut}\n… [truncated; the whole answer: ${path}]`, bytes: Buffer.byteLength(cut) };
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
