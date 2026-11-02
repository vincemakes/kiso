import { useEffect, useState, type ReactNode } from "react";
import { clock, t } from "../i18n/index.js";
import { fetchTaskLog } from "../state/api.js";
import type { State, Step } from "../state/model.js";
import { objectOf } from "../stream/Step.js";

interface Props {
	readonly state: State;
	readonly wkey: string | null;
	readonly sessionId: string;
	/** the tab shown: a task's id, or COMMANDS (the panel's top bar holds the tabs) */
	readonly tab: string;
}

export const COMMANDS = "commands";

/** Background tasks with their logs, and the latest run's foreground commands with the first lines they printed. */
export function Term({ state, wkey, sessionId, tab }: Props): ReactNode {
	const [log, setLog] = useState<{ readonly lines: readonly string[]; readonly truncated: boolean } | null>(null);
	const task = state.tasks.find((x) => x.id === tab);
	const running = task !== undefined && task.endedAt === null;
	useEffect(() => {
		if (task === undefined) return;
		let alive = true;
		const read = (): void => void fetchTaskLog(wkey, sessionId, task.id).then((l) => alive && setLog(l), () => undefined);
		read();
		const timer = running ? setInterval(read, 1_000) : undefined;
		return () => {
			alive = false;
			if (timer !== undefined) clearInterval(timer);
		};
	}, [task?.id, running, wkey, sessionId]);
	const commands = (state.turns.at(-1)?.items ?? []).filter((i): i is Step => i.kind === "step" && i.name === "shell");
	return (
		<div data-panel-body="term">
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
