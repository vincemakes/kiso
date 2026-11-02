import { split, type Footer, type State } from "../state/model.js";
import { artifactsOf, focusOf } from "../stream/Artifacts.js";
import { changesOf } from "../state/panels.js";
import type { ArtifactRef } from "../../shared/frames.js";

/**
 * The rail's numbers and rows, derived from the stream's own state, so the
 * rail and the stream can never disagree: one reducer over the same log.
 * Usage is the latest run's; outputs and changes are the whole Work's.
 */

export interface Rail {
	readonly usage: Footer | null;
	/** running background tasks plus approvals waiting: the badge on the overview key */
	readonly attention: number;
}

export function railOf(state: State): Rail {
	const turn = state.turns.at(-1);
	if (turn === undefined) return { usage: null, attention: 0 };
	return { usage: turn.footer ?? turn.live, attention: state.tasks.filter((x) => x.endedAt === null).length + split(turn).openAsks.length };
}

/** One thing the Work made, newest first, once each (the same file written twice is one output). */
export interface RailOutput {
	readonly a: ArtifactRef;
	readonly focus: string;
	readonly at: number | null;
}

/** Every run's artifacts, newest first, deduplicated by what they open (the rail's Outputs: the whole Work, not the latest run). */
export function outputsOf(state: State): RailOutput[] {
	const seen = new Set<string>();
	const out: RailOutput[] = [];
	for (const turn of [...state.turns].reverse())
		for (const item of [...turn.items].reverse()) {
			if (item.kind !== "step") continue;
			for (const a of artifactsOf(item)) {
				const focus = focusOf(a);
				if (seen.has(focus)) continue;
				seen.add(focus);
				out.push({ a, focus, at: item.endedAt ?? item.startedAt });
			}
		}
	return out;
}

/** The files every run of the Work changed, summed per path (the rail's Changes: what this Work did to the folder). */
export function workChangesOf(state: State, root: string | null): { readonly path: string; readonly added: number; readonly removed: number; readonly created: boolean; readonly exact: boolean }[] {
	const byPath = new Map<string, { added: number; removed: number; created: boolean; exact: boolean }>();
	for (const turn of state.turns)
		for (const c of changesOf({ ...state, turns: [turn] }, root)) {
			const e = byPath.get(c.path) ?? { added: 0, removed: 0, created: false, exact: true };
			byPath.set(c.path, { added: e.added + c.added, removed: e.removed + c.removed, created: e.created || c.created, exact: e.exact && c.exact });
		}
	return [...byPath].map(([path, e]) => ({ path, ...e }));
}
