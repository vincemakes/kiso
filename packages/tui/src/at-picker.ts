/**
 * KC3 §3 — the @ file picker's PURE half: the subsequence filter and
 * the deterministic rank. No scoring library, no index, no disk. The
 * file list is DATA the CLI feeds in (the tui purity rule: input is
 * data, output is bytes); this module decides which of those paths a
 * query matches, in what order, and which characters to embolden.
 *
 * Determinism is the whole design constraint. A fuzzy finder that
 * reorders on a tie is unusable at speed — the row under the cursor
 * must not move because two paths scored equal. Every comparison here
 * ends in a total order: run length, then path length, then the raw
 * lexical order of the path (never localeCompare, whose result depends
 * on the machine's locale).
 */

/** The bound source's item — a repo-relative path and nothing else.
 *  Structural: the CLI passes whatever it likes as long as it has a
 *  path (slice 5 passes exactly this). */
export interface AtItem {
	readonly path: string;
}

/** A matched path plus the indices the panel emboldens. */
export interface AtMatch {
	readonly path: string;
	/** the matched character positions, ascending — the panel renders
	 *  these bold-white and the rest dim */
	readonly hit: readonly number[];
	/** the longest CONTIGUOUS run inside `hit` — the rank's first key,
	 *  carried so the panel and the ranking can never disagree about
	 *  why a row is where it is */
	readonly run: number;
}

/**
 * KC3 §5 — the ONE cap. The file list is computed per open with no
 * index and no watcher, so its cost is bounded here rather than
 * amortized somewhere invisible. The source collects at most CAP + 1
 * entries: the extra one is what makes "there were more" DISTINGUISHABLE
 * from "there were exactly this many", so the counter row can say so
 * honestly instead of guessing.
 */
export const AT_CAP = 2000;

/** KC3 §4 — the panel's visible height. A ceiling, not a promise: the
 *  compositor clamps further when the terminal is short. */
export const AT_VISIBLE = 5;

/**
 * The subsequence embedding, TIGHTENED — the two-pass walk every good
 * fuzzy finder uses, and the reason `@ra` emboldens the "ra" of
 * "src/range.js" rather than the r of "src" and the a of "range".
 *
 * Pass 1 walks forward and stops at the EARLIEST index that completes
 * the query — this both answers "does it match at all" and fixes the
 * right-hand edge. Pass 2 walks backward from that edge, taking the
 * LATEST position for each query character in turn, which slides every
 * matched character as far right as it can go without crossing the
 * next one. The result is the most clustered embedding that ends where
 * the earliest match ends.
 *
 * Case-insensitive: both sides are lowercased by the caller once per
 * query rather than once per character.
 *
 * Returns the ascending match indices, or null when the query is not a
 * subsequence of the path at all.
 */
export function atEmbed(lowerPath: string, lowerQuery: string): number[] | null {
	if (lowerQuery === "") return [];
	// pass 1 — forward, to the earliest completing index
	let qi = 0;
	let end = -1;
	for (let pi = 0; pi < lowerPath.length; pi += 1) {
		if (lowerPath[pi] === lowerQuery[qi]) {
			qi += 1;
			if (qi === lowerQuery.length) {
				end = pi;
				break;
			}
		}
	}
	if (end === -1) return null; // not a subsequence — no embedding exists
	// pass 2 — backward from that edge, sliding each character right
	const hit = new Array<number>(lowerQuery.length);
	let pi = end;
	for (let j = lowerQuery.length - 1; j >= 0; j -= 1) {
		while (lowerPath[pi] !== lowerQuery[j]) pi -= 1;
		hit[j] = pi;
		pi -= 1;
	}
	return hit;
}

/** The longest run of CONSECUTIVE indices in an ascending list. An
 *  empty query has no run — every path ties on it, and the rank falls
 *  through to path length. */
export function longestRun(hit: readonly number[]): number {
	let best = 0;
	let run = 0;
	for (let i = 0; i < hit.length; i += 1) {
		run = i > 0 && hit[i]! === hit[i - 1]! + 1 ? run + 1 : 1;
		if (run > best) best = run;
	}
	return best;
}

/**
 * The filter + the rank. Case-insensitive SUBSEQUENCE over the FULL
 * relative path (so `@tui/ed` finds packages/tui/src/editor.ts — the
 * directory is part of what the user is typing at, not a separate
 * field), ordered by:
 *
 *   1. contiguous-run length DESC — a path where the query appears as
 *      a solid stretch beats one where it is scattered across the
 *      whole string. This is the key that makes typing feel like
 *      aiming rather than fishing.
 *   2. path length ASC — among equally solid hits, the shorter path is
 *      the more likely target (src/range.js over a deep vendored copy
 *      of the same name).
 *   3. the path itself, lexically — the tiebreak of last resort, and
 *      the reason the order NEVER depends on the source's iteration
 *      order or on two runs of the same query disagreeing.
 *
 * An EMPTY query matches everything: rule 1 ties at 0 for all, so the
 * listing is shortest-path-first, then lexical. The list is sliced to
 * AT_CAP; `capped` reports whether anything was dropped.
 */
export function atFilter(items: readonly AtItem[], query: string): { matches: AtMatch[]; capped: boolean } {
	const capped = items.length > AT_CAP;
	const pool = capped ? items.slice(0, AT_CAP) : items;
	const lowerQuery = query.toLowerCase();
	const matches: AtMatch[] = [];
	for (const item of pool) {
		const hit = atEmbed(item.path.toLowerCase(), lowerQuery);
		if (hit === null) continue;
		matches.push({ path: item.path, hit, run: longestRun(hit) });
	}
	matches.sort((a, b) => {
		if (a.run !== b.run) return b.run - a.run;
		if (a.path.length !== b.path.length) return a.path.length - b.path.length;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	return { matches, capped };
}
