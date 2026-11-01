import { memo, useState, type ReactNode } from "react";
import type { TaskRow } from "../../shared/frames.js";
import { fmt, span, t, tokens } from "../i18n/index.js";
import { split, type Ask, type Turn as TurnModel } from "../state/model.js";
import { Answer } from "./Answer.js";
import { Approval } from "./Approval.js";
import { RunContext } from "./links.js";
import { Process } from "./Process.js";

interface Props {
	readonly turn: TurnModel;
	/** changes whenever this turn may have: ended turns pass a constant so they are not redrawn */
	readonly rev: number;
	readonly tasks: readonly TaskRow[];
	/** the run was cut off with the host */
	readonly interrupted: boolean;
	readonly onAnswer: (decisionId: string, allow: boolean) => void;
}

function Footer({ turn }: { readonly turn: TurnModel }): ReactNode {
	const time = turn.startedAt !== null && turn.endedAt !== null ? span(turn.endedAt - turn.startedAt) : "";
	const f = turn.footer;
	if (f === null) return <div className="acts" data-kind="footer">{time}</div>;
	const values = { time, fresh: tokens(f.fresh), output: tokens(f.output), cache: f.cacheRate === null ? "" : Math.round(f.cacheRate) };
	return (
		<div className="acts" data-kind="footer">
			{fmt(f.cacheRate === null ? t.footerNoCache : t.footer, values)}
		</div>
	);
}

/** One run: the person's line, the process, the approvals still open, the answer, the live row or the footer. */
export const Turn = memo(function Turn({ turn, tasks, onAnswer, interrupted }: Props): ReactNode {
	const { process: items, answer, openAsks } = split(turn);
	const inProcess = items.filter((i) => !(i.kind === "ask" && i.decision === "open"));
	const live = turn.phase === "running" && !interrupted;
	// the footer closes a run once its answer is drawn to the end, not while the steady release is still writing it
	const [drawn, setDrawn] = useState(true);
	return (
		<RunContext.Provider value={turn.id}>
			<div className="me" data-kind="me">
				{turn.user}
			</div>
			{inProcess.length > 0 || live ? <Process turn={turn} items={inProcess} tasks={tasks} onAnswer={onAnswer} interrupted={interrupted} /> : null}
			{openAsks.map((ask: Ask) => (
				<Approval key={ask.id} ask={ask} onAnswer={onAnswer} />
			))}
			{answer !== null ? <Answer text={answer.text} live={live} onSettled={setDrawn} /> : null}
			{turn.phase === "ended" && !live && (answer === null || drawn) ? <Footer turn={turn} /> : null}
		</RunContext.Provider>
	);
}, (a, b) => a.turn === b.turn && a.rev === b.rev && a.tasks === b.tasks && a.interrupted === b.interrupted);
