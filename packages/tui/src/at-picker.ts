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

import { escapeTerminal, palette } from "./lines.js";
import { atEmbed, bandKeyRow, bandVisible, bandWindow, goldHits, moreMark, selectionBar, visibleWidth, widthCut } from "./components.js";

// Graphite P3: the band helpers and the matcher moved to tui-cells, where
// the pick panels draw too; re-exported so every import site stays as it was
export { atEmbed, bandKeyRow, bandVisible, bandWindow, moreMark };
import { bandHeader } from "@vincemakes/kiso-tui-cells/strings";

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

/**
 * KC3 §5 — the directories the picker never offers, and the other half
 * of its contract with whatever host has to walk a tree to fill it.
 *
 * It lives here beside the cap because the two are the same kind of
 * promise: a host that walks must prune these BEFORE descending (a
 * post-filter would already have walked node_modules, which is the
 * cost the pruning exists to avoid), and must stop at the cap. Hosts
 * that get their list from a VCS ignore this set entirely — the VCS
 * has already applied a better one.
 */
export const AT_SKIP: ReadonlySet<string> = new Set([".git", "node_modules", "dist", "build", "coverage"]);

/** KC3 §4 — the panel's visible height. A ceiling, not a promise: the
 *  compositor clamps further when the terminal is short. */
export const AT_VISIBLE = 5;

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

/**
 * KC3 §4 — the picker's WINDOW: which slice of the ranked list is on
 * screen. The window TRAILS the selection exactly as the composer's
 * own viewport trails the cursor (KC1 §5) — derived per read, never
 * stored, so it can never disagree with the selection it is meant to
 * follow.
 */
export function atWindow(total: number, selected: number, visible = AT_VISIBLE): { first: number; count: number } {
	const count = Math.min(total, visible);
	const first = Math.max(0, Math.min(selected - count + 1, total - count));
	return { first, count };
}

/** The path split into the two columns the panel draws: the file's own
 *  name, and the directory that qualifies it. A path with no slash is
 *  all name and no directory. */
/** The cells a file's NAME takes in its row — the measure the band's name
 *  column is laid over (escaped as the row draws it, so the column a
 *  wide or control-character name asks for is the one it gets). */
export function atNameWidth(path: string): number {
	return visibleWidth(splitPath(escapeTerminal(path)).name);
}

function splitPath(path: string): { dir: string; name: string } {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}


/**
 * KC3 §4, Graphite P2 (owner, 2026-10-03) — ONE row of the panel: the
 * file's NAME, padded to the name column, then its FOLDER as a dim column,
 * so the folders line up. The letters the query matched are gold in both.
 *
 * DECLARED REVERSAL of TUI2-R1.5 ⑧ (VD-9) in two parts: the folder no
 * longer trails each name after an em dash — it is a column one gap after
 * the longest name in the list (never the far edge, which was VD-9's
 * complaint), so twenty rows read as a table; and a match inside the
 * folder is drawn, gold, because the person typed it.
 *
 * The name is the flexible column when the row is short: the folder gives
 * way first, then the name is cut with an ellipsis.
 */
export function atRow(match: AtMatch, selected: boolean, W: number, nameCol = 0, mark: string | null = null): string {
	const p = palette();
	const { dir, name } = splitPath(escapeTerminal(match.path));
	const nameHits = new Set(match.hit.filter((i) => i >= dir.length).map((i) => i - dir.length));
	const dirHits = new Set(match.hit.filter((i) => i < dir.length));
	const room = Math.max(1, W - 3); // the two-cell lead and one cell of margin
	const col = Math.min(Math.max(nameCol, visibleWidth(name)), room);
	const shownName = visibleWidth(name) <= col ? name : col <= 1 ? widthCut(name, col) : `${widthCut(name, col - 1)}…`;
	const dirRoom = room - col - 2;
	const shownDir = dir === "" || dirRoom < 4 ? "" : visibleWidth(dir) <= dirRoom ? dir : `${widthCut(dir, dirRoom - 1)}…`;
	const pad = shownDir === "" ? "" : " ".repeat(col - visibleWidth(shownName) + 2);
	const text = `${goldHits(shownName, nameHits, selected ? p.bold : "")}${pad}${shownDir === "" ? "" : goldHits(shownDir, dirHits, p.dim)}`;
	const width = visibleWidth(shownName) + pad.length + visibleWidth(shownDir);
	if (selected) return selectionBar(` ${text}`, width + 1, W);
	return mark === null ? `  ${text}` : `${p.dim}${mark}${p.reset} ${text}`;
}

/**
 * KC3 §4 — the counter row: `(n/total)`, where n is the 1-based
 * position of the SELECTION in the whole ranked list, not in the
 * visible window. The user needs to know where they are in the list,
 * which the five visible rows cannot tell them.
 *
 * When the source list was truncated the row SAYS SO. A file picker
 * that quietly lists 2,000 of 40,000 files and shows a confident
 * "(3/1998)" is lying by omission; this one admits the horizon.
 * (Graphite P2: the band's own rows no longer use it — the count rides
 * the key row and the horizon the band's name.)
 */
export function atCounterRow(selected: number, total: number, capped: boolean, W: number): string {
	const p = palette();
	const text = capped ? `  (${selected + 1}/${total}) · first ${AT_CAP} files only` : `  (${selected + 1}/${total})`;
	return `${p.dim}${widthCut(text, W)}${p.reset}`;
}

/** The band's state as the editor hands it over. `query`, `total` and
 *  `nameCol` (the widest file name in the whole list, so the folder
 *  column never moves while the person types) are Graphite P2's; absent,
 *  the band still draws. */
export interface AtPanelState {
	readonly matches: readonly AtMatch[];
	readonly selected: number;
	readonly capped: boolean;
	readonly query?: string;
	readonly total?: number;
	readonly nameCol?: number;
}

/**
 * KC3 §4, Graphite P2 — the whole band: the named hairline with the count
 * (`files · 8`, `2 of 8 match`, and `first 2000 only` when the walk was
 * cut), the windowed rows with their more-marks, and the key row with the
 * counter. Returned as plain strings for the menu-rows channel, which
 * already accounts them in chromeRows — the picker needs no geometry of
 * its own, which is the entire reason it rides that channel.
 */
export function atPanelRows(state: AtPanelState, W: number, height = 24): string[] {
	const total = state.total ?? state.matches.length;
	const query = state.query ?? "";
	const facts = `${query === "" ? `${total}` : `${state.matches.length} of ${total} match`}${state.capped ? ` · first ${AT_CAP} only` : ""}`;
	// TUI2-R1.5 ⑦(b) (VD-8): the band NAMES itself — with scrollback behind
	// it, nothing else says where the surface begins
	const rows: string[] = [bandHeader(`files · ${facts}`, W)];
	const { first, count } = bandWindow(state.matches.length, state.selected, bandVisible(height));
	const nameCol = state.nameCol ?? 0;
	for (let i = first; i < first + count; i += 1) rows.push(atRow(state.matches[i]!, i === state.selected, W, nameCol, moreMark(i, first, count, state.matches.length)));
	rows.push(bandKeyRow(["↑↓ move", "tab inserts", "esc"], state.selected, state.matches.length, W));
	return rows;
}

/**
 * TUI2-R1.5 ⑦(b) — the one row that turns a band into a surface. Shared
 * by the @ picker, the / menu and the session picker so the three read
 * the same way.
 *
 * R2: the label rides the RULE. It was a bare dim word on its own row —
 * which said "a surface starts here" only if you already knew that, and
 * it spent a row saying it. The dashed rule is the edge vocabulary the
 * composer and every panel now share, so a band opens the way everything
 * else does and the label tells you WHICH band in the same row.
 */
// R8b: bandHeader MOVED to tui-cells/strings.ts — the keys sheet needs
// it and lives there, and `components.ts` already imports that module,
// so the dependency only runs one way. Re-exported here so every
// existing import site is untouched.
export { bandHeader };
