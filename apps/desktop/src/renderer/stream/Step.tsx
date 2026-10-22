import type { ReactNode } from "react";
import { clock, fmt, t } from "../i18n/index.js";
import { editDiff } from "../state/diff.js";
import type { Step as StepItem } from "../state/model.js";
import type { TaskRow } from "../../shared/frames.js";
import { toolIcon } from "./Icons.js";
import { Thumb, thumbOf } from "./Thumb.js";
import { useNow } from "./useNow.js";

const MAX_LINES = 8;

/** What the step acted on: the file, the command's first line, the pattern. */
export function objectOf(step: StepItem): string {
	const i = step.input ?? {};
	const pick = (k: string): string => (typeof i[k] === "string" ? (i[k] as string) : "");
	if (step.name === "shell") return pick("command").split("\n")[0]!;
	if (step.name === "search_text") return pick("pattern");
	if (step.name === "task_stop") return pick("id");
	return pick("path") || ".";
}

/** The lines to show under a step, each marked: unchanged, added or removed. */
export function outputLines(step: StepItem): { text: string; mark: "" | "a" | "d" }[] {
	if (step.name === "edit_file") {
		const diff = editDiff(step.input);
		if (diff.length > 0) return diff.map((l) => ({ text: `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`, mark: l.kind === "add" ? "a" : l.kind === "del" ? "d" : "" }));
	}
	if (step.name === "write_file" && typeof step.input?.["content"] === "string") return (step.input["content"] as string).split("\n").map((l) => ({ text: `+ ${l}`, mark: "a" as const }));
	return (step.output?.head ?? []).filter((l) => !/^\[rev:[0-9a-f]+\]$/.test(l)).map((text) => ({ text, mark: "" as const }));
}

export function Step({ step, task }: { readonly step: StepItem; readonly task: TaskRow | undefined }): ReactNode {
	const running = step.status === "running" || step.status === "calling" || step.status === "waiting";
	const now = useNow(running || (task !== undefined && task.endedAt === null));
	const began = step.startedAt ?? now;
	const ms = step.endedAt !== null && step.startedAt !== null ? step.endedAt - step.startedAt : now - began;
	const thumb = step.status === "done" ? thumbOf(step.name) : null;
	const all = outputLines(step);
	const lines = all.slice(0, MAX_LINES);
	const total = step.name === "edit_file" || step.name === "write_file" ? all.length : (step.output?.lines ?? all.length);
	const more = Math.max(0, total - lines.length);
	return (
		<div className={`step ${step.status}`} data-kind="step" data-tool={step.name}>
			<div className="s-row">
				<span className="s-ic">{running ? <span className="sp" /> : toolIcon(step.name)}</span>
				<span className="s-verb">{t.verb[step.name] ?? step.name}</span>
				<code className="s-obj">{objectOf(step)}</code>
				{step.taskId !== null ? <span className="bgtag">{t.moved}</span> : null}
				<span className="s-sp" />
				{thumb !== null ? <Thumb kind={thumb} /> : null}
				<span className="s-time">{(ms / 1000).toFixed(1)}s</span>
			</div>
			{step.taskId !== null ? (
				<div className={`s-bar${task === undefined || task.endedAt === null ? " live" : ""}`}>
					<b />
				</div>
			) : null}
			{step.taskId !== null && task !== undefined ? (
				<div className="s-req">
					{task.id} · {task.label} · {clock(task.elapsedMs)}
				</div>
			) : null}
			{lines.length > 0 && step.taskId === null ? (
				<div className="s-out">
					{lines.map((l, i) => (
						<div key={i} className={l.mark}>
							{l.text || " "}
						</div>
					))}
					{more > 0 ? <span className="more">{fmt(t.more, { n: more })}</span> : null}
				</div>
			) : null}
			{step.status === "failed" && step.error !== null ? <div className="s-err">{step.error}</div> : null}
			{step.status === "denied" ? <div className="s-err">{t.denied_step}</div> : null}
		</div>
	);
}
