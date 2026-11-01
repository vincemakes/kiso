import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { clock, fmt, t } from "../i18n/index.js";
import { editDiff } from "../state/diff.js";
import { delta } from "../state/groups.js";
import type { Step as StepItem } from "../state/model.js";
import type { TaskRow } from "../../shared/frames.js";
import { Chevron, toolIcon } from "./Icons.js";
import { artifactsOf, InPlace, Thumbs } from "./Artifacts.js";
import { Chip } from "./links.js";
import { useNow } from "./useNow.js";
import { useRelative } from "./root.js";

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
	// an image block stands in the text as "[image]": the picture itself is shown instead
	return (step.output?.head ?? []).filter((l) => !/^\[rev:[0-9a-f]+\]$/.test(l) && !(l === "[image]" && step.output?.artifacts !== undefined)).map((text) => ({ text, mark: "" as const }));
}

/** Changed lines, only where exact (`+N −N`); "modified" where a count would be a guess. */
export function Delta({ d }: { readonly d: ReturnType<typeof delta> }): ReactNode {
	if (d === null) return null;
	if (d === "modified") return <span className="delta mod" data-field="delta">{t.deltaModified}</span>;
	return (
		<span className="delta" data-field="delta">
			<em className="plus">+{d.added}</em>
			{d.removed > 0 ? <em className="minus">−{d.removed}</em> : null}
		</span>
	);
}

/**
 * `frozen`: the run was cut off with the host, so nothing here is moving. A row that made images has a chevron and opens them in
 * place (`shown`, kept by its group); a write or an edit of a file in the folder names it with its chip.
 */
export function Step({ step, task, frozen = false, shown = false, onShow }: { readonly step: StepItem; readonly task: TaskRow | undefined; readonly frozen?: boolean; readonly shown?: boolean; readonly onShow?: () => void }): ReactNode {
	const running = !frozen && (step.status === "running" || step.status === "calling" || step.status === "waiting");
	const now = useNow(running || (task !== undefined && task.endedAt === null));
	const began = step.startedAt ?? now;
	const ms = step.endedAt !== null && step.startedAt !== null ? step.endedAt - step.startedAt : now - began;
	const all = outputLines(step);
	const lines = all.slice(0, MAX_LINES);
	const total = step.name === "edit_file" || step.name === "write_file" ? all.length : (step.output?.lines ?? all.length);
	const more = Math.max(0, total - lines.length);
	const rel = useRelative();
	// a line that runs past the edge: the edge fades
	const box = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(false);
	useLayoutEffect(() => setWide((box.current?.scrollWidth ?? 0) > (box.current?.clientWidth ?? 0) + 1), [lines.length, step.status]);
	const images = artifactsOf(step).some((a) => a.kind === "image");
	const object = rel(objectOf(step));
	const chip = step.status === "done" && (step.name === "write_file" || step.name === "edit_file") && !object.startsWith("/") && !object.startsWith("..");
	return (
		<div className={`step ${step.status}${shown ? " shown" : ""}`} data-kind="step" data-tool={step.name} data-shown={images ? shown : undefined}>
			<div className={`s-row${images ? " click" : ""}`} onClick={images ? onShow : undefined}>
				<span className="s-ic">{running ? <span className="sp" /> : toolIcon(step.name)}</span>
				<span className="s-verb">{t.verb[step.name] ?? step.name}</span>
				{chip ? <Chip path={object} /> : <code className="s-obj">{object}</code>}
				<Delta d={delta(step)} />
				{images ? <Chevron /> : null}
				{step.taskId !== null ? <span className="bgtag">{t.moved}</span> : null}
				<span className="s-sp" />
				<Thumbs items={artifactsOf(step)} />
				<span className="s-time">{(ms / 1000).toFixed(1)}s</span>
			</div>
			{images && shown ? <InPlace step={step} /> : null}
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
			{/* a failed step says what went wrong once, in red: its output (the same message) is not repeated above it */}
			{lines.length > 0 && step.taskId === null && step.status !== "failed" ? (
				<div className="s-out">
					{/* long lines are not wrapped (a diff or a table keeps its columns): the right edge fades where a line goes on */}
					<div className="s-lines" ref={box} data-wide={wide}>
						{lines.map((l, i) => (
							<div key={i} className={l.mark}>
								{rel(l.text) || " "}
							</div>
						))}
					</div>
					{more > 0 ? <div className="more">{fmt(t.more, { n: more })}</div> : null}
				</div>
			) : null}
			{step.status === "failed" && step.error !== null ? <div className="s-err">{rel(step.error)}</div> : null}
			{step.status === "denied" ? <div className="s-err">{t.denied_step}</div> : null}
		</div>
	);
}
