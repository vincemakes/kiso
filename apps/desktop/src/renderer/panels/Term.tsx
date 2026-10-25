import { useEffect, useState, type ReactNode } from "react";
import { clock, t } from "../i18n/index.js";
import { fetchTaskLog } from "../state/api.js";
import type { State, Step } from "../state/model.js";
import { objectOf } from "../stream/Step.js";

interface Props {
	readonly state: State;
	readonly token: string;
	readonly wkey: string | null;
	readonly sessionId: string;
	/** the task to show first (opened from the rail) */
	readonly focus: string | null;
}

const COMMANDS = "commands";

/** Background tasks with their logs, and the latest run's foreground commands with the first lines they printed. */
export function Term({ state, token, wkey, sessionId, focus }: Props): ReactNode {
	const [tab, setTab] = useState<string>(focus ?? state.tasks[0]?.id ?? COMMANDS);
	const [log, setLog] = useState<{ readonly lines: readonly string[]; readonly truncated: boolean } | null>(null);
	useEffect(() => {
		if (focus !== null) setTab(focus);
	}, [focus]);
	const task = state.tasks.find((x) => x.id === tab);
	const running = task !== undefined && task.endedAt === null;
	useEffect(() => {
		if (task === undefined) return;
		let alive = true;
		const read = (): void => void fetchTaskLog(token, wkey, sessionId, task.id).then((l) => alive && setLog(l), () => undefined);
		read();
		const timer = running ? setInterval(read, 1_000) : undefined;
		return () => {
			alive = false;
			if (timer !== undefined) clearInterval(timer);
		};
	}, [task?.id, running, token, wkey, sessionId]);
	const commands = (state.turns.at(-1)?.items ?? []).filter((i): i is Step => i.kind === "step" && i.name === "shell");
	return (
		<div data-panel-body="term">
			<div className="ttabs">
				{state.tasks.map((x) => (
					<button key={x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)} data-tab={x.id}>
						{x.id} {x.label}
					</button>
				))}
				<button className={tab === COMMANDS ? "on" : ""} onClick={() => setTab(COMMANDS)} data-tab={COMMANDS}>
					{t.commandsTab}
				</button>
			</div>
			{task !== undefined ? (
				<>
					<div className="tmeta mono">
						{task.command} · {task.label} · {clock(task.elapsedMs)}
					</div>
					<div className="log" data-log="task">
						{log === null || log.lines.length === 0 ? t.noLog : log.lines.join("\n")}
					</div>
					{log?.truncated === true ? <div className="pnote">{t.logCut}</div> : null}
				</>
			) : tab === COMMANDS ? (
				commands.length === 0 ? (
					<div className="empty">{t.noCommands}</div>
				) : (
					commands.map((c) => (
						<div key={c.id} className="cmd" data-command={c.id}>
							<div className="tmeta mono">$ {objectOf(c)}</div>
							<div className="log">{(c.output?.head ?? []).join("\n") || t.noLog}</div>
						</div>
					))
				)
			) : (
				<div className="empty">{t.noTasks}</div>
			)}
		</div>
	);
}
