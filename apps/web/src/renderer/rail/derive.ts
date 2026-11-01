import { isInterrupted, isLive, split, type Footer, type State, type Step, type StepStatus } from "../state/model.js";
import { objectOf } from "../stream/Step.js";
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

export interface Rail {
	readonly status: RailStatus;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly usage: Footer | null;
	readonly steps: readonly RailStep[];
	/** running background tasks plus approvals waiting: the badge on the overview key */
	readonly attention: number;
}

/** `rel` writes a path inside the Work's folder relative to it (display only). */
export function railOf(state: State, rel: (text: string) => string = (text) => text): Rail {
	const turn = state.turns.at(-1);
	if (turn === undefined) return { status: "idle", startedAt: null, endedAt: null, usage: null, steps: [], attention: 0 };
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
			title: `${t.verb[s.name] ?? s.name} ${rel(objectOf(s))}`.trim(),
			status: s.status,
			at: s.startedAt !== null && turn.startedAt !== null ? s.startedAt - turn.startedAt : null,
			ms: s.startedAt !== null && s.endedAt !== null ? s.endedAt - s.startedAt : null,
			lines: (s.error !== null ? [s.error] : (s.output?.head ?? []).filter((l) => !/^\[rev:[0-9a-f]+\]$/.test(l)).slice(0, 4)).map(rel),
		})),
		attention: state.tasks.filter((x) => x.endedAt === null).length + open,
	};
}
