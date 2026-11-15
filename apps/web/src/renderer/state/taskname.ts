import type { TaskRow } from "../../shared/frames.js";
import type { State, Step } from "./model.js";

/** Control characters out, runs of spaces collapsed, at most 60 characters. */
const clean = (text: string): string => {
	const s = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

const LEAD_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const REDIRECT = /\s+(?:\d?>>?|&>)\s*(?:&\d|"[^"]*"|'[^']*'|[^\s;&|]+)/g;

/** A task's name: the model's description, else the command without a leading `cd <path> &&` (the folder is shown on its own) and
 *  without its output redirections; a chain stays whole, never named by its first part (owner 2026-11-15). */
export function titleOf(command: string, description?: unknown): string {
	if (typeof description === "string" && clean(description) !== "") return clean(description);
	return clean(command.replace(LEAD_CD, "").replace(REDIRECT, "")) || clean(command);
}

/** The shell call a task came from, by its id on the Work's own steps (a background start or a promoted foreground command; any replay finds it). */
export const stepOfTask = (state: State, id: string): Step | undefined => state.turns.flatMap((t) => t.items).find((i): i is Step => i.kind === "step" && i.taskId === id);

/** "running", "finished", "failed · exit 2", "stopped". */
export function statusOf(label: string): string {
	const exit = /(?:failed|exited) (\d+)$/.exec(label);
	if (/^(starting|running|ready|stopping)$/.test(label)) return "running";
	return exit === null ? label : label.startsWith("exited") && exit[1] === "0" ? "finished" : `failed · exit ${exit[1]}`;
}

export interface TaskName {
	readonly title: string;
	readonly command: string;
	readonly folder: string | null;
	readonly status: string;
}

/** What every place that shows a task reads. */
export function taskNameOf(state: State, task: Pick<TaskRow, "id" | "label" | "command">): TaskName {
	const input = stepOfTask(state, task.id)?.input;
	const command = typeof input?.["command"] === "string" ? input["command"] : task.command;
	return { title: titleOf(command, input?.["description"]), command, folder: /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&/.exec(command)?.[1]?.replace(/^["']|["']$/g, "") ?? null, status: statusOf(task.label) };
}
