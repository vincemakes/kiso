/**
 * R5 — THE TRANSCRIPT VIEWER, on the PRIMARY screen.
 *
 * The owner's question was never "how do I click" — it was "with that
 * many folds, which one am I about to open?". R4 answered it with a
 * printed ordinal and R4a retired that: a number you cannot type is not
 * a selector. The real bind is narrower and has nothing to do with the
 * mouse:
 *
 *   a COMMITTED row cannot be marked, because kiso never repaints it.
 *
 * So any "this one" marker has to live on a surface kiso DOES repaint.
 * That surface is this viewer, and inside it a keyboard cursor answers
 * the question completely — no mouse, no ordinal, no mode key to
 * memorise per fold. The pointer becomes optional decoration rather
 * than the mechanism, which is why this round ships without it.
 *
 * NOT the alternate buffer. The viewer occupies the live region exactly
 * as the keys sheet does (TUI2-R1.5 7(a)): while an overlay is up the
 * window is frozen, no LF is emitted, nothing enters the scrollback,
 * and closing takes the full-redraw path and restores every displaced
 * row. pi's viewer and the reference implementation's both take the
 * alternate screen; kiso does not have to, and a kill -9 inside a
 * primary-screen viewer leaves ordinary bytes and an intact scrollback
 * where an alt-screen death would strand the reader in the wrong
 * buffer.
 *
 * This module is PURE: entries + state + width → rows. It holds no
 * cells, mutates nothing, and never touches `cell.expanded` — the
 * viewer's expansion set is its OWN (see ViewerState.open). That is not
 * tidiness: the compositor recomputes `#committedLines` from cell
 * renders on every full redraw, and that number feeds the scroll floor,
 * so a viewer that expanded a committed cell in place would corrupt the
 * window arithmetic for the rest of the session.
 */

import { palette } from "./render.js";
import { visibleWidth } from "./components.js";

/** The gutter every viewer row carries: the cursor mark and its space. */
export const VIEWER_GUTTER = 3;

/** One expandable thing in the transcript. The compositor renders these
 *  from its committed cells at W − VIEWER_GUTTER; the viewer only
 *  arranges them. */
export interface ViewerEntry {
	/** the fold's own committed row, as the reader saw it */
	readonly head: string;
	/** the rows it stands for */
	readonly body: readonly string[];
}

export interface ViewerState {
	/** which entry the cursor is on */
	readonly cursor: number;
	/** the first flat row shown — the scroll position */
	readonly top: number;
	/** the entries expanded IN THE VIEWER. Never a cell mutation. */
	readonly open: ReadonlySet<number>;
}

export function viewerInit(entries: readonly ViewerEntry[]): ViewerState {
	// the cursor starts on the NEWEST fold — the one ctrl+o would have
	// opened, so the two mechanisms agree on their first answer.
	return { cursor: Math.max(0, entries.length - 1), top: 0, open: new Set() };
}

/** The flat row model: every row the viewer would show if it had room,
 *  each tagged with the entry it belongs to and whether it is that
 *  entry's head. The window is a slice of this. */
export function viewerFlat(entries: readonly ViewerEntry[], state: ViewerState): { entry: number; head: boolean; text: string }[] {
	const out: { entry: number; head: boolean; text: string }[] = [];
	for (const [i, e] of entries.entries()) {
		out.push({ entry: i, head: true, text: e.head });
		if (state.open.has(i)) for (const row of e.body) out.push({ entry: i, head: false, text: row });
	}
	return out;
}

/** The flat index of an entry's head row. */
function headRow(entries: readonly ViewerEntry[], state: ViewerState, entry: number): number {
	return viewerFlat(entries, state).findIndex((r) => r.entry === entry && r.head);
}

/** Move the cursor by `delta` entries, keeping it inside the window. */
export function viewerMove(entries: readonly ViewerEntry[], state: ViewerState, delta: number, rows: number): ViewerState {
	if (entries.length === 0) return state;
	const cursor = Math.max(0, Math.min(entries.length - 1, state.cursor + delta));
	const next = { ...state, cursor };
	return { ...next, top: clampTop(entries, next, rows) };
}

/** Scroll by `delta` ROWS without moving the cursor's entry — PgUp/PgDn
 *  and the wheel, if a pointer ever arrives. */
export function viewerScroll(entries: readonly ViewerEntry[], state: ViewerState, delta: number, rows: number): ViewerState {
	const flat = viewerFlat(entries, state).length;
	const top = Math.max(0, Math.min(Math.max(0, flat - rows), state.top + delta));
	return { ...state, top };
}

/** Toggle the entry under the cursor. Viewer-local, always. */
export function viewerToggle(entries: readonly ViewerEntry[], state: ViewerState, rows: number): ViewerState {
	const open = new Set(state.open);
	if (open.has(state.cursor)) open.delete(state.cursor);
	else open.add(state.cursor);
	const next = { ...state, open };
	return { ...next, top: clampTop(entries, next, rows) };
}

/** `a` — every entry at once, or none if they are all already open. */
export function viewerToggleAll(entries: readonly ViewerEntry[], state: ViewerState, rows: number): ViewerState {
	const all = entries.length > 0 && entries.every((_, i) => state.open.has(i));
	const open = all ? new Set<number>() : new Set(entries.map((_, i) => i));
	const next = { ...state, open };
	return { ...next, top: clampTop(entries, next, rows) };
}

/** Keep the cursor's head row inside the window. */
function clampTop(entries: readonly ViewerEntry[], state: ViewerState, rows: number): number {
	const flat = viewerFlat(entries, state);
	const at = headRow(entries, state, state.cursor);
	if (at < 0) return 0;
	const maxTop = Math.max(0, flat.length - rows);
	let top = Math.min(state.top, maxTop);
	if (at < top) top = at;
	if (at >= top + rows) top = at - rows + 1;
	return Math.max(0, Math.min(top, maxTop));
}

/**
 * The viewer's rows, at most `rows` of them, every one exactly one
 * physical row no wider than W (invariant ① — the same crash gate the
 * live region obeys, because these rows go through the same emitter).
 *
 * The marks: `▸` the cursor on a closed entry, `▾` the cursor on an
 * open one, `│` an open entry's body. Under NO_COLOR the marks ARE the
 * state — the tint is emphasis over a fact the characters already
 * carry (law 1.3), so a pipe of this surface loses nothing.
 */
export function viewerRows(entries: readonly ViewerEntry[], state: ViewerState, W: number, rows: number): string[] {
	const p = palette();
	const flat = viewerFlat(entries, state);
	const out: string[] = [];
	for (const line of flat.slice(state.top, state.top + rows)) {
		const onCursor = line.entry === state.cursor && line.head;
		const open = state.open.has(line.entry);
		// The mark carries STATE, the weight carries the CURSOR. Two facts,
		// two channels — and the first draft collapsed them: a non-cursor
		// head printed a blank, so an entry that was OPEN stopped saying
		// so the moment you moved off it. Law 1.3 wants the fact in the
		// characters, and it is the characters that survive a pipe.
		//
		//   ▾  open        (always, cursor or not)
		//   ▸  the cursor, on a closed entry
		//   │  an open entry's body
		//      a closed entry nobody is pointing at
		const mark = line.head ? (open ? "▾" : onCursor ? "▸" : " ") : "│";
		const gutter = onCursor ? `${p.bold}${mark}${p.reset} ` : `${p.dim}${mark}${p.reset} `;
		const row = ` ${gutter}${line.text}`;
		out.push(open ? shade(row, W) : cut(row, W));
	}
	return out;
}

/**
 * An open entry's rows take the VERBATIM SURFACE — `wash`, the same
 * background DC-3 gave the human's own words and inline code. It is
 * ground-resolved already, and with no ground it degrades to reverse
 * video, which is correct on any ground (ground.ts rung 4).
 *
 * Padded to the full width so the block reads as ONE thing rather than
 * a ragged stack. Under NO_COLOR `wash` is empty and the row's bytes
 * are untouched — the ▾ and │ marks carry the state on their own, which
 * is law 1.3's requirement, not a consolation.
 */
function shade(row: string, W: number): string {
	const p = palette();
	const body = cut(row, W);
	if (p.wash === "") return body;
	return `${p.wash}${body}${" ".repeat(Math.max(0, W - visibleWidth(body)))}${p.washEnd}`;
}

/** The last resort — the row is cut at W rather than overflowing it. */
function cut(row: string, W: number): string {
	if (visibleWidth(row) <= W) return row;
	let out = "";
	let n = 0;
	for (let i = 0; i < row.length; ) {
		if (row[i] === "\x1b") {
			const j = row.indexOf("m", i);
			if (j < 0) break;
			out += row.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (n >= W - 1) break;
		out += row[i];
		n += 1;
		i += 1;
	}
	return `${out}…${palette().reset}`;
}

/** The viewer's affordance row — what the keys do, where they are
 *  useful (the PICKER_HINT convention). */
export function viewerHint(state: ViewerState, entries: readonly ViewerEntry[]): string {
	const openHere = state.open.has(state.cursor);
	return `↑↓ move · ⏎ ${openHere ? "collapses" : "expands"} · a ${entries.every((_, i) => state.open.has(i)) && entries.length > 0 ? "collapses all" : "expands all"} · esc closes`;
}

/** The viewer's band header — what surface this is, and how much of it. */
export function viewerTitle(entries: readonly ViewerEntry[]): string {
	return `transcript · ${entries.length} ${entries.length === 1 ? "fold" : "folds"}`;
}
