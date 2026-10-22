import type { SessionState, WireEvent } from "@vincemakes/kiso-protocol";
import type { AtFrame, TaskRow, TasksFrame, ToolOutputFrame, UsageFrame } from "../../shared/frames.js";
import { ThinkingPager } from "../../shared/thinking.js";

/**
 * The stream's model: wire events and host frames in, the turns the stream
 * draws out. A pure reducer over one ordered input, so the same code builds
 * the view live, after a page reload (the whole log replayed) and in the
 * proofs. Nothing here knows React or the DOM.
 *
 * A turn is one run: the person's line, then the process (thinking, text
 * that precedes a tool, steps, approvals) and, after the last step, the
 * answer. A step is a tool call, never a thought.
 */

export interface Thinking {
	readonly kind: "thinking";
	readonly id: string;
	readonly seq: number;
	text: string;
	/** the first sentence of each paragraph so far — what the one line pages through */
	lines: string[];
	startedAt: number | null;
	endedAt: number | null;
}

export interface Text {
	readonly kind: "text";
	readonly id: string;
	readonly seq: number;
	text: string;
}

export type StepStatus = "calling" | "waiting" | "running" | "done" | "failed" | "denied";

export interface Step {
	readonly kind: "step";
	readonly id: string;
	readonly seq: number;
	readonly callId: string;
	name: string;
	input: Readonly<Record<string, unknown>> | null;
	status: StepStatus;
	startedAt: number | null;
	endedAt: number | null;
	output: ToolOutputFrame | null;
	error: string | null;
	/** set when the result says the command moved to the background */
	taskId: string | null;
}

export interface Ask {
	readonly kind: "ask";
	readonly id: string;
	readonly seq: number;
	readonly decisionId: string;
	readonly callId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	decision: "open" | "approved" | "denied";
}

/** A line the person added while the run was live (a steer). */
export interface Steer {
	readonly kind: "steer";
	readonly id: string;
	readonly seq: number;
	readonly text: string;
}

/** A runtime notice the model was given (a task ended): drawn as a quiet line, never as the person's. */
export interface Notice {
	readonly kind: "notice";
	readonly id: string;
	readonly seq: number;
	readonly text: string;
}

export type Item = Thinking | Text | Step | Ask | Steer | Notice;

export interface Footer {
	readonly fresh: number | null;
	readonly output: number | null;
	readonly cacheRate: number | null;
}

export interface Turn {
	readonly id: string;
	readonly user: string;
	readonly items: Item[];
	phase: "running" | "ended";
	startedAt: number | null;
	endedAt: number | null;
	outcome: string | null;
	/** the run's usage so far, from the usage frames */
	live: Footer | null;
	/** the run's usage at its end, from run_usage */
	footer: Footer | null;
}

export interface State {
	readonly turns: Turn[];
	readonly tasks: readonly TaskRow[];
	/** the time of the latest `at` frame: where a thinking block starts */
	lastAt: number | null;
	/** the event the next `at` frame belongs to */
	last: { readonly seq: number; readonly type: string; readonly itemId: string | null } | null;
	/** what the host says about the session: an open run, uncertain executions, whether a run is live */
	snapshot: SessionState | null;
	/** a bumped counter the view reads to know something changed */
	version: number;
}

export type Input =
	| { readonly kind: "event"; readonly event: WireEvent }
	| { readonly kind: "frame"; readonly name: string; readonly data: unknown }
	| { readonly kind: "snapshot"; readonly state: SessionState };

export const initialState = (): State => ({ turns: [], tasks: [], lastAt: null, last: null, snapshot: null, version: 0 });

const pagers = new WeakMap<Thinking, ThinkingPager>();

const currentTurn = (s: State): Turn | undefined => s.turns.at(-1);

/** The line a runtime notice reads as; a task notice becomes "Task t1 exited". */
export function noticeText(raw: string): string {
	const task = /<kiso-task id="([^"]+)" status="([^"]+)"(?: code="(-?\d+)")?/.exec(raw);
	if (task !== null) return `Task ${task[1]} ${task[2]}${task[3] !== undefined && task[3] !== "0" ? ` (exit ${task[3]})` : ""}`;
	return raw.replace(/<[^>]*>/g, "").trim().split("\n")[0]!.slice(0, 120);
}

/** The "moved to the background" sentence the shell's result carries. */
const BACKGROUND = /\bbackground task (t\d+)\b/;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((b) => (b !== null && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
	return "";
}

/** The thinking text is complete once anything else happens: the pager's last paragraph gets its line. */
function endThinkingText(turn: Turn): void {
	const item = turn.items.at(-1);
	if (item?.kind !== "thinking") return;
	const pager = pagers.get(item);
	if (pager === undefined) return;
	for (const p of pager.flush()) if (p.kind === "line") item.lines[p.paragraph] = p.text;
	pagers.delete(item);
}

function closeThinking(turn: Turn, ts: number | null): void {
	for (const item of turn.items) if (item.kind === "thinking" && item.endedAt === null) item.endedAt = ts ?? Date.now();
}

function stepOf(turn: Turn | undefined, callId: string): Step | undefined {
	return turn?.items.find((i): i is Step => i.kind === "step" && i.callId === callId);
}

/** Apply one input; mutates and returns the state with a new version. */
export function reduce(s: State, input: Input): State {
	s.version += 1;
	if (input.kind === "snapshot") {
		s.snapshot = input.state;
		return s;
	}
	if (input.kind === "frame") {
		frame(s, input.name, input.data);
		return s;
	}
	const e = input.event;
	const turn = currentTurn(s);
	s.last = { seq: e.seq, type: e.type, itemId: null };
	if (turn !== undefined && e.type !== "thinking") endThinkingText(turn);
	const note = (item: Item): void => {
		s.last = { seq: e.seq, type: e.type, itemId: item.id };
	};
	switch (e.type) {
		case "user_input": {
			const text = contentText(e.content);
			if ((e as { source?: string }).source === "system") {
				// a runtime notice, not the person: a quiet line inside a live run, nothing otherwise
				if (turn !== undefined && turn.phase === "running") {
					const item: Notice = { kind: "notice", id: `n${e.seq}`, seq: e.seq, text: noticeText(text) };
					turn.items.push(item);
					note(item);
				}
				return s;
			}
			if (turn !== undefined && turn.phase === "running") {
				const item: Steer = { kind: "steer", id: `u${e.seq}`, seq: e.seq, text };
				turn.items.push(item);
				note(item);
			} else {
				s.turns.push({ id: `t${e.seq}`, user: text, items: [], phase: "running", startedAt: null, endedAt: null, outcome: null, live: null, footer: null });
			}
			return s;
		}
		case "thinking": {
			if (turn === undefined) return s;
			let item = turn.items.at(-1);
			if (item?.kind !== "thinking" || item.endedAt !== null) {
				item = { kind: "thinking", id: `k${e.seq}`, seq: e.seq, text: "", lines: [], startedAt: s.lastAt, endedAt: null };
				pagers.set(item, new ThinkingPager());
				turn.items.push(item);
			}
			item.text += e.text;
			for (const p of pagers.get(item)!.push(e.text)) if (p.kind === "line") item.lines[p.paragraph] = p.text;
			return s;
		}
		case "text_start":
		case "text_delta": {
			if (turn === undefined) return s;
			let item = turn.items.at(-1);
			if (item?.kind !== "text" || e.type === "text_start") {
				if (e.type === "text_delta" && item?.kind === "text") {
					// a delta after a text_start already made this item
				} else {
					item = { kind: "text", id: `x${e.seq}`, seq: e.seq, text: "" };
					turn.items.push(item);
				}
			}
			if (e.type === "text_delta" && item?.kind === "text") item.text += e.text;
			if (item !== undefined) note(item);
			return s;
		}
		case "tool_call_start":
		case "tool_call_end": {
			if (turn === undefined) return s;
			let step = stepOf(turn, e.callId);
			if (step === undefined) {
				step = { kind: "step", id: `s${e.callId}`, seq: e.seq, callId: e.callId, name: e.name, input: null, status: "calling", startedAt: null, endedAt: null, output: null, error: null, taskId: null };
				turn.items.push(step);
			}
			if (e.type === "tool_call_end") step.input = e.input;
			note(step);
			return s;
		}
		case "permission_requested": {
			if (turn === undefined) return s;
			const step = stepOf(turn, e.callId);
			if (step !== undefined) step.status = "waiting";
			const ask: Ask = { kind: "ask", id: `a${e.decisionId}`, seq: e.seq, decisionId: e.decisionId, callId: e.callId, name: e.name, input: e.input, decision: "open" };
			turn.items.push(ask);
			note(ask);
			return s;
		}
		case "permission_decided": {
			const ask = turn?.items.find((i): i is Ask => i.kind === "ask" && i.decisionId === e.decisionId);
			if (ask === undefined) return s;
			ask.decision = e.decision;
			const step = stepOf(turn, ask.callId);
			if (step !== undefined) step.status = e.decision === "denied" ? "denied" : "calling";
			return s;
		}
		case "tool_execution_started": {
			const step = stepOf(turn, e.callId);
			if (step !== undefined) {
				step.status = "running";
				note(step);
			}
			return s;
		}
		case "tool_execution_succeeded":
		case "tool_execution_failed": {
			const step = stepOf(turn, e.callId);
			if (step === undefined) return s;
			step.status = e.type === "tool_execution_failed" ? "failed" : "done";
			if (e.type === "tool_execution_failed") step.error = e.error;
			note(step);
			return s;
		}
		case "tool_result": {
			const step = stepOf(turn, e.callId);
			if (step === undefined) return s;
			if (e.isError && step.status !== "denied") step.status = "failed";
			else if (!e.isError && step.status !== "failed") step.status = "done";
			note(step);
			return s;
		}
		case "draft_voided": {
			if (turn === undefined) return s;
			// model output after voidFromSeq was never committed; a step that began executing is a fact and stays
			const keep = turn.items.filter((i) => !(i.seq > e.voidFromSeq && (i.kind === "thinking" || i.kind === "text" || (i.kind === "step" && i.startedAt === null && i.status === "calling"))));
			turn.items.splice(0, turn.items.length, ...keep);
			return s;
		}
		case "terminal": {
			if (turn === undefined) return s;
			turn.phase = "ended";
			turn.outcome = e.outcome.kind;
			s.last = { seq: e.seq, type: e.type, itemId: null };
			return s;
		}
		default:
			return s;
	}
}

function frame(s: State, name: string, data: unknown): void {
	const turn = currentTurn(s);
	switch (name) {
		case "at": {
			const { seq, ts } = data as AtFrame;
			s.lastAt = ts;
			const last = s.last;
			if (turn === undefined || last === null || last.seq !== seq) return;
			const step = last.itemId === null ? undefined : turn.items.find((i): i is Step => i.kind === "step" && i.id === last.itemId);
			if (last.type === "user_input") turn.startedAt = ts;
			else if (last.type === "terminal") {
				turn.endedAt = ts;
				closeThinking(turn, ts);
			} else if (last.type === "tool_execution_started" && step !== undefined) {
				step.startedAt = ts;
				closeThinking(turn, ts);
			} else if ((last.type === "tool_result" || last.type === "tool_execution_succeeded" || last.type === "tool_execution_failed") && step !== undefined) {
				step.endedAt = ts;
			} else if (last.type === "tool_call_start" || last.type === "tool_call_end" || last.type === "text_start" || last.type === "permission_requested") closeThinking(turn, ts);
			return;
		}
		case "usage": {
			if (turn === undefined) return;
			const u = (data as UsageFrame).turn;
			turn.live = { fresh: u.fresh, output: u.output, cacheRate: u.cacheRate };
			return;
		}
		case "run_usage": {
			if (turn === undefined) return;
			const u = data as { fresh: number | null; output: number | null; cacheRate: number | null };
			turn.footer = { fresh: u.fresh, output: u.output, cacheRate: u.cacheRate };
			return;
		}
		case "tool_output": {
			const out = data as ToolOutputFrame;
			const step = stepOf(turn, out.callId);
			if (step === undefined) return;
			step.output = out;
			const moved = BACKGROUND.exec(out.head.join(" "));
			if (moved !== null) step.taskId = moved[1]!;
			return;
		}
		case "tasks":
			(s as { tasks: readonly TaskRow[] }).tasks = (data as TasksFrame).tasks;
			return;
		default:
	}
}

/** What the view draws for a turn: the process (everything but the trailing
 *  text), the answer (that trailing text, once nothing follows it), and which
 *  approvals are still open (they never fold). */
export function split(turn: Turn): { process: Item[]; answer: Text | null; openAsks: Ask[] } {
	const items = turn.items;
	const last = items.at(-1);
	const answer = last?.kind === "text" ? last : null;
	return { process: answer === null ? items : items.slice(0, -1), answer, openAsks: items.filter((i): i is Ask => i.kind === "ask" && i.decision === "open") };
}

/** The process region is folded when the run has ended, not before: a
 *  streaming answer does not fold it. */
export const folded = (turn: Turn, userChoice: boolean | undefined): boolean => userChoice ?? turn.phase === "ended";

/** A run is live when the host says so; a turn that never got its terminal after a restart is interrupted. */
export const isLive = (s: State): boolean => {
	const last = s.turns.at(-1);
	return last?.phase === "running" && (s.snapshot === null || s.snapshot.running);
};

export const isInterrupted = (s: State): boolean => s.turns.at(-1)?.phase === "running" && s.snapshot !== null && !s.snapshot.running && s.snapshot.openRun !== null;
