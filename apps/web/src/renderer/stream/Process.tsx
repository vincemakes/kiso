import { useState, type ReactNode } from "react";
import type { TaskRow } from "../../shared/frames.js";
import { clock, fmt, span, t } from "../i18n/index.js";
import { folded, type Item, type Step as StepItem, type Turn } from "../state/model.js";
import { tokens } from "../i18n/index.js";
import { Blocks } from "./Answer.js";
import { Approval } from "./Approval.js";
import { Chevron } from "./Icons.js";
import { Step } from "./Step.js";
import { Thinking } from "./Thinking.js";
import { ThumbLink, thumbOf } from "./Thumb.js";
import { useNow } from "./useNow.js";

interface Props {
	/** the run was cut off with the host: nothing is moving, so no spinner */
	readonly interrupted?: boolean;
	readonly turn: Turn;
	/** the items of the process: everything but the answer and the approvals still open */
	readonly items: readonly Item[];
	readonly tasks: readonly TaskRow[];
	readonly onAnswer: (decisionId: string, allow: boolean) => void;
}

/**
 * The process: everything the agent does, in one region. It stays open
 * while the run is live and folds to one line when the run ends — not when
 * the answer starts. The person can open or close it at any time.
 */
export function Process({ turn, items, tasks, onAnswer, interrupted = false }: Props): ReactNode {
	const [choice, setChoice] = useState<boolean | undefined>(undefined);
	const isFolded = folded(turn, choice) && !interrupted;
	const live = turn.phase === "running" && !interrupted;
	const now = useNow(live);
	const began = turn.startedAt ?? now;
	const ms = (turn.endedAt ?? now) - began;
	const steps = items.filter((i): i is StepItem => i.kind === "step");
	const thumbs = steps.map((s) => (s.status === "done" ? thumbOf(s.name) : null)).filter((k): k is "diff" | "term" => k !== null);
	return (
		<div className={`proc${isFolded ? " folded" : ""}${live ? "" : " ended"}`} data-kind="process" data-folded={isFolded}>
			<button className="ph" onClick={() => setChoice(!isFolded)} aria-expanded={!isFolded}>
				<Chevron />
				<span className="dotpulse" />
				{/* the one live indicator of a run: its label shimmers while it works */}
				<span className={`lab${live ? " shimmer" : ""}`} {...(live ? { "data-kind": "live" } : {})}>
					{live ? t.working : fmt(steps.length === 0 ? t.worked : steps.length === 1 ? t.workedSteps.replace("{n} steps", t.stepsOne) : t.workedSteps, { time: span(ms), n: steps.length })}
				</span>
				{live ? <span className="clk">{clock(ms)}</span> : null}
				{live && turn.live?.output != null ? <span className="clk">{`${tokens(turn.live.output)} out`}</span> : null}
				<span className="pthumbs">
					{thumbs.map((k, i) => (
						<ThumbLink key={i} kind={k} />
					))}
				</span>
			</button>
			<div className="pw">
				<div className="pb">
					<div className="pb-in">
						{items.map((item) => {
							switch (item.kind) {
								case "thinking":
									return <Thinking key={item.id} item={item} />;
								case "text":
									return <Blocks key={item.id} className="say" kind="say" text={item.text} live={live && item === items.at(-1)} />;
								case "step":
									return <Step key={item.id} step={item} task={tasks.find((r) => r.id === item.taskId)} frozen={interrupted} />;
								case "ask":
									return <Approval key={item.id} ask={item} onAnswer={onAnswer} />;
								case "notice":
									return (
										<div key={item.id} className="note" data-kind="notice">
											{item.text}
										</div>
									);
								case "steer":
									return (
										<div key={item.id} className="steer">
											{item.text}
										</div>
									);
							}
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
