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

import { escapeTerminal, palette } from "./render.js";
import { selectionBar, visibleWidth, widthCut } from "./components.js";

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
function splitPath(path: string): { dir: string; name: string } {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/**
 * KC3 §4 — ONE row of the panel.
 *
 * Two columns: the file's NAME on the left with its matched characters
 * bold, and the DIRECTORY dim on the right, pushed to the far edge.
 * The name is what the user is aiming at; the directory is what tells
 * two same-named files apart, which is why it is present but quiet.
 *
 * The selected row carries `→` on the inverse band (SGR 7, closed with
 * 27 — never SGR 0, so it composes inside the row's own spans).
 *
 * The `hit` indices are over the FULL path, so they are shifted by the
 * directory's length to land on the name. A hit that falls INSIDE the
 * directory is simply not drawn bold — the directory column is
 * uniformly dim by design (a bold fragment in a right-aligned dim
 * column reads as damage, not as information).
 *
 * The row never exceeds W: the name cuts first (it is the flexible
 * column), and the directory is dropped entirely before the name is
 * cut to nothing.
 */
export function atRow(match: AtMatch, selected: boolean, W: number): string {
	const p = palette();
	const { dir, name } = splitPath(escapeTerminal(match.path));
	// the name's own matched positions, mapped out of the full path
	const marks = new Set(match.hit.filter((i) => i >= dir.length).map((i) => i - dir.length));
	// TUI2-R1.5 ⑧ (VD-9): the directory rides NEXT TO the name it
	// qualifies. It used to be right-aligned to the band's far edge, which
	// on a 100-column terminal put `src/` some eighty columns from the
	// `parser.ts` it belongs to: the eye had to cross the whole row to
	// learn which parser.ts this was, and the column read as a second list.
	// Adjacent and dim, it is what it always meant to be — a qualifier.
	// the name is the flexible column and the qualifier gives way first: a
	// narrow window keeps the thing being aimed at.
	const room = Math.max(1, W - 2);
	const suffix = dir === "" ? "" : widthCut(`  — ${dir}`, Math.max(0, room - 4));
	const nameRoom = Math.max(1, room - visibleWidth(suffix));
	const shownName = widthCut(name, nameRoom);
	let painted = "";
	for (let i = 0; i < shownName.length; i += 1) {
		painted += marks.has(i) ? `${p.bold}${shownName[i]}${p.reset}` : shownName[i];
	}
	const text = `${painted}${suffix === "" ? "" : `${p.dim}${suffix}${p.reset}`}`;
	const width = visibleWidth(shownName) + visibleWidth(suffix);
	if (!selected) return `  ${text}`;
	// TUI2-R1.5 ⑧ (VD-9): the selection is a FULL-ROW bar — the W16 chip
	// mechanism, which the user chip and the turn fold already use. A
	// two-cell `→ ` marker on the inverse band is one character of
	// highlight in an eighty-column row, and the walkthrough could barely
	// find it. The bar spans the row's whole width so the selection is
	// visible from anywhere on the line. Mono discipline: reverse video,
	// no new colours.
	//
	// R2: the composition is selectionBar's — one copy, and with it the
	// §2.1 rule that dim never sits on the wash (the directory column was
	// rendering grey-on-grey inside the bar, i.e. the half of the row the
	// selection was meant to help you read).
	return selectionBar(`${painted}${suffix === "" ? "" : `${p.dim}${suffix}${p.reset}`}`, width, W);
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
 */
export function atCounterRow(selected: number, total: number, capped: boolean, W: number): string {
	const p = palette();
	const text = capped ? `  (${selected + 1}/${total}) · first ${AT_CAP} files only` : `  (${selected + 1}/${total})`;
	return `${p.dim}${widthCut(text, W)}${p.reset}`;
}

/**
 * KC3 §4 — the whole band: at most AT_VISIBLE windowed rows, then the
 * counter. Returned as plain strings for the menu-rows channel, which
 * already accounts them in chromeRows — the picker needs no geometry
 * of its own, which is the entire reason it rides that channel.
 */
export function atPanelRows(state: { matches: readonly AtMatch[]; selected: number; capped: boolean }, W: number): string[] {
	const { first, count } = atWindow(state.matches.length, state.selected);
	// TUI2-R1.5 ⑦(b) (VD-8): the band NAMES itself. It renders frameless
	// directly above the composer, so with scrollback behind it there was
	// nothing to say where the surface began — the rows read as more
	// history. One dim row is enough to make it UI. Mono discipline: dim
	// text, no rule, no colour.
	const rows: string[] = [bandHeader("files", W)];
	for (let i = first; i < first + count; i += 1) rows.push(atRow(state.matches[i]!, i === state.selected, W));
	rows.push(atCounterRow(state.selected, state.matches.length, state.capped, W));
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
export function bandHeader(label: string, W: number): string {
	const p = palette();
	const head = `\u2500\u2500\u2500 ${label} `;
	return `${p.dim}${widthCut(`${head}${"\u2500".repeat(Math.max(1, W - head.length))}`, Math.max(1, W))}${p.reset}`;
}
