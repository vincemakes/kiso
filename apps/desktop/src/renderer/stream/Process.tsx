import { useState, type ReactNode } from "react";
import type { TaskRow } from "../../shared/frames.js";
import { clock, fmt, span, t } from "../i18n/index.js";
import { folded, type Item, type Step as StepItem, type Turn } from "../state/model.js";
import { Approval } from "./Approval.js";
import { Chevron } from "./Icons.js";
import { Step } from "./Step.js";
import { Thinking } from "./Thinking.js";
import { Thumb, thumbOf } from "./Thumb.js";
import { useNow } from "./useNow.js";

interface Props {
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
export function Process({ turn, items, tasks, onAnswer }: Props): ReactNode {
	const [choice, setChoice] = useState<boolean | undefined>(undefined);
	const isFolded = folded(turn, choice);
	const live = turn.phase === "running";
	const now = useNow(live);
	const began = turn.startedAt ?? now;
	const ms = (turn.endedAt ?? now) - began;
	const steps = items.filter((i): i is StepItem => i.kind === "step");
	const thumbs = steps.map((s) => (s.status === "done" ? thumbOf(s.name) : null)).filter((k): k is "diff" | "term" => k !== null);
	return (
		<div className={`proc${isFolded ? " folded" : ""}${live ? "" : " ended"}`} data-kind="process" data-folded={isFolded}>
			<button className="ph" onClick={() => setChoice(!isFolded)}>
				<span className="dotpulse" />
				<Chevron />
				<span className="lab">{live ? t.working : fmt(steps.length === 1 ? t.workedSteps.replace("{n} steps", t.stepsOne) : t.workedSteps, { time: span(ms), n: steps.length })}</span>
				{live ? <span className="clk">{clock(ms)}</span> : null}
				<span className="pthumbs">
					{thumbs.map((k, i) => (
						<Thumb key={i} kind={k} />
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
									return (
										<div key={item.id} className="say">
											{item.text}
										</div>
									);
								case "step":
									return <Step key={item.id} step={item} task={tasks.find((r) => r.id === item.taskId)} />;
								case "ask":
									return <Approval key={item.id} ask={item} onAnswer={onAnswer} />;
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
