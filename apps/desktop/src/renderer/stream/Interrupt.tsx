import { useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { State } from "../state/model.js";
import { Warn } from "./Icons.js";

/** What the uncertain execution was, from the step that made the call. */
function what(state: State, callId: string, name: string): string {
	for (const turn of state.turns) {
		for (const item of turn.items) {
			if (item.kind === "step" && item.callId === callId) {
				const i = item.input ?? {};
				const v = name === "shell" ? i["command"] : i["path"];
				return `${t.verb[name] ?? name} ${typeof v === "string" ? v.split("\n")[0] : ""}`.trim();
			}
		}
	}
	return t.verb[name] ?? name;
}

/** An interrupted run: the host went away before it finished. Resuming continues it where the log stopped. */
export function ResumeCard({ onResume }: { readonly onResume: () => void }): ReactNode {
	const [sent, setSent] = useState(false);
	return (
		<div className="ask resume" data-kind="resume">
			<div className="h">
				<Warn />
				{t.interrupted}
			</div>
			<button
				className="btn pri"
				disabled={sent}
				data-act="resume"
				onClick={() => {
					setSent(true);
					onResume();
				}}
			>
				{t.resume}
			</button>
		</div>
	);
}

/**
 * Executions kiso cannot vouch for: the process stopped while a tool ran,
 * so the effect may or may not have happened. The person decides for each:
 * run it again, or skip it. The run resumes when the last verdict is in.
 */
export function VerdictPanel({ state, onVerdict }: { readonly state: State; readonly onVerdict: (executionId: string, resolution: "rerun" | "abandoned") => void }): ReactNode {
	const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
	const items = state.snapshot?.uncertain ?? [];
	if (items.length === 0) return null;
	const give = (id: string, resolution: "rerun" | "abandoned"): void => {
		setSent(new Set([...sent, id]));
		onVerdict(id, resolution);
	};
	return (
		<div className="ask" data-kind="verdicts">
			<div className="h">
				<Warn />
				{t.verdictTitle}
			</div>
			{items.map((u) => (
				<div key={u.executionId} className="verdict" data-execution={u.executionId}>
					<pre>{what(state, u.callId, u.name)}</pre>
					<button className="btn pri" disabled={sent.has(u.executionId)} data-act="rerun" onClick={() => give(u.executionId, "rerun")}>
						{t.rerun}
					</button>
					<button className="btn" disabled={sent.has(u.executionId)} data-act="abandon" onClick={() => give(u.executionId, "abandoned")}>
						{t.abandon}
					</button>
				</div>
			))}
		</div>
	);
}
