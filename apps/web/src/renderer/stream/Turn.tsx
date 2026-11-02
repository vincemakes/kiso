import { memo, useContext, useState, type ReactNode } from "react";
import type { TaskRow } from "../../shared/frames.js";
import { fmt, span, t, tokens } from "../i18n/index.js";
import { split, type Ask, type Turn as TurnModel } from "../state/model.js";
import { Answer } from "./Answer.js";
import { Approval } from "./Approval.js";
import { RunContext, WorkContext } from "./links.js";
import { Process } from "./Process.js";
import { artifactsOf, focusOf, Picture } from "./Artifacts.js";
import { artifactIcon } from "./Icons.js";
import { LightboxContext, useOpenArtifact } from "./Lightbox.js";
import type { ArtifactRef } from "../../shared/frames.js";

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
			{f.tokPerSec != null ? fmt(t.footerRate, { rate: f.tokPerSec }) : null}
		</div>
	);
}

/** What the run made, once each and in the order made, after its answer: the same items its steps show, opened the one way. */
function Made({ turn }: { readonly turn: TurnModel }): ReactNode {
	const open = useOpenArtifact();
	const seen = new Set<string>();
	const made: ArtifactRef[] = [];
	for (const item of turn.items) if (item.kind === "step") for (const a of artifactsOf(item)) if (!seen.has(focusOf(a))) (seen.add(focusOf(a)), made.push(a));
	if (made.length === 0) return null;
	return (
		<div className="made" data-kind="made">
			{made.map((a) => {
				const focus = focusOf(a);
				const name = focus.startsWith("log:") ? t.imageResult : (focus.split("/").pop() ?? focus);
				return (
					<button key={focus} className="made-c" data-made={focus} title={focus.startsWith("log:") ? t.imageResult : focus} onClick={() => open(a)}>
						{artifactIcon(a.kind, focus)}
						<span>{name}</span>
					</button>
				);
			})}
		</div>
	);
}

/** The person's pictures in their line, small, in the bubble's corner; a click opens one in the lightbox. */
function MePictures({ pictures }: { readonly pictures: readonly string[] }): ReactNode {
	const work = useContext(WorkContext);
	const lightbox = useContext(LightboxContext);
	if (pictures.length === 0) return null;
	return (
		<div className="me-pics" data-kind="me-pictures">
			{pictures.map((p) => {
				const focus = `log:${work}/${p.slice(4)}`;
				return (
					<button key={p} className="me-pic" onClick={() => lightbox(focus)} data-picture={focus}>
						<Picture focus={focus} className="me-img" />
					</button>
				);
			})}
		</div>
	);
}

/** One run: the person's line, the process, the approvals still open, the answer, what it made, the live row or the footer. */
export const Turn = memo(function Turn({ turn, tasks, onAnswer, interrupted }: Props): ReactNode {
	const { process: items, answer, openAsks } = split(turn);
	const inProcess = items.filter((i) => !(i.kind === "ask" && i.decision === "open"));
	const live = turn.phase === "running" && !interrupted;
	// the footer closes a run once its answer is drawn to the end, not while the steady release is still writing it
	const [drawn, setDrawn] = useState(true);
	return (
		<RunContext.Provider value={turn.id}>
			<MePictures pictures={turn.pictures} />
			{turn.user !== "" || turn.pictures.length === 0 ? (
				<div className="me" data-kind="me">
					{turn.user}
				</div>
			) : null}
			{inProcess.length > 0 || live ? <Process turn={turn} items={inProcess} tasks={tasks} onAnswer={onAnswer} interrupted={interrupted} /> : null}
			{openAsks.map((ask: Ask) => (
				<Approval key={ask.id} ask={ask} onAnswer={onAnswer} />
			))}
			{answer !== null ? <Answer text={answer.text} live={live} onSettled={setDrawn} /> : null}
			{turn.phase === "ended" && !live && (answer === null || drawn) ? <Made turn={turn} /> : null}
			{turn.phase === "ended" && !live && (answer === null || drawn) ? <Footer turn={turn} /> : null}
		</RunContext.Provider>
	);
}, (a, b) => a.turn === b.turn && a.rev === b.rev && a.tasks === b.tasks && a.interrupted === b.interrupted);
