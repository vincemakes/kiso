import { editDiff } from "../state/diff.js";
import { isInterrupted, isLive, split, type Footer, type State, type Step, type StepStatus } from "../state/model.js";
import { objectOf } from "../stream/Step.js";
import { thumbOf } from "../stream/Thumb.js";
import { t } from "../i18n/index.js";

/**
 * The rail's numbers and rows, derived from the stream's own state, so the
 * rail and the stream can never disagree: one reducer over the same log.
 * The rail shows the latest run (a Work is a conversation of runs; the
 * rail is the overview of the one in front of the person).
 */

export type RailStatus = "idle" | "working" | "waiting" | "done" | "stopped" | "failed" | "interrupted";

export interface RailStep {
	readonly id: string;
	readonly title: string;
	readonly status: StepStatus;
	/** ms since the run began, when known */
	readonly at: number | null;
	readonly ms: number | null;
	/** the first lines of what it printed, or its error */
	readonly lines: readonly string[];
}

export interface RailOutput {
	readonly id: string;
	readonly kind: "diff" | "term";
	readonly name: string;
	readonly sub: string;
}

export interface Rail {
	readonly status: RailStatus;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly usage: Footer | null;
	readonly steps: readonly RailStep[];
	readonly outputs: readonly RailOutput[];
	/** running background tasks plus approvals waiting: the badge on the overview key */
	readonly attention: number;
}

const base = (path: string): string => path.split("/").filter((p) => p !== "").pop() ?? path;

function outputOf(step: Step): RailOutput | null {
	const kind = thumbOf(step.name);
	if (kind === null || step.status !== "done") return null;
	if (kind === "term") return { id: step.id, kind, name: objectOf(step).slice(0, 24), sub: `${step.output?.lines ?? 0} lines` };
	const diff = editDiff(step.input);
	const added = step.name === "write_file" && typeof step.input?.["content"] === "string" ? (step.input["content"] as string).split("\n").length : diff.filter((l) => l.kind === "add").length;
	const removed = step.name === "write_file" ? 0 : diff.filter((l) => l.kind === "del").length;
	return { id: step.id, kind, name: base(objectOf(step)), sub: `+${added} −${removed}` };
}

export function railOf(state: State): Rail {
	const turn = state.turns.at(-1);
	if (turn === undefined) return { status: "idle", startedAt: null, endedAt: null, usage: null, steps: [], outputs: [], attention: 0 };
	const open = split(turn).openAsks.length;
	const live = isLive(state);
	const status: RailStatus = isInterrupted(state) ? "interrupted" : live ? (open > 0 ? "waiting" : "working") : turn.outcome === "completed" ? "done" : turn.outcome === "aborted" ? "stopped" : turn.phase === "ended" ? "failed" : "working";
	const steps = turn.items.filter((i): i is Step => i.kind === "step");
	return {
		status,
		startedAt: turn.startedAt,
		endedAt: turn.endedAt,
		usage: turn.footer ?? turn.live,
		steps: steps.map((s) => ({
			id: s.id,
			title: `${t.verb[s.name] ?? s.name} ${objectOf(s)}`.trim(),
			status: s.status,
			at: s.startedAt !== null && turn.startedAt !== null ? s.startedAt - turn.startedAt : null,
			ms: s.startedAt !== null && s.endedAt !== null ? s.endedAt - s.startedAt : null,
			lines: s.error !== null ? [s.error] : (s.output?.head ?? []).filter((l) => !/^\[rev:[0-9a-f]+\]$/.test(l)).slice(0, 4),
		})),
		outputs: steps.flatMap((s) => outputOf(s) ?? []),
		attention: state.tasks.filter((x) => x.endedAt === null).length + open,
	};
}
