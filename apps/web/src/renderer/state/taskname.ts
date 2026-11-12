import type { TaskRow } from "../../shared/frames.js";
import type { State, Step } from "./model.js";

/** Control characters out, runs of spaces collapsed, at most 60 characters. */
const clean = (text: string): string => {
	const s = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

const LEAD_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const SIMPLE = /^(?!sleep\b|for\b|while\b|until\b|if\b|case\b|(?:sh|bash|zsh)\s+-c\b)[^;&|<>`(){}\n]+$/;

/** A task's name: the model's description, else the command without a leading `cd <path> &&` when one simple command is left, else the command. */
export function titleOf(command: string, description?: unknown): string {
	if (typeof description === "string" && clean(description) !== "") return clean(description);
	const rest = command.replace(LEAD_CD, "");
	return clean(SIMPLE.test(rest.trim()) ? rest : command);
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
