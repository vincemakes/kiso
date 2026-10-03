/**
 * TUI2-R2 slices ①–③ — the session picker's PURE half: the durability
 * badge, the row, the band, and the filter.
 *
 * The row's STATE is the round's whole argument. kiso's claim is that a
 * session survives kill -9 and resumes from its durable prefix; the note
 * column makes it a thing you can READ before you pick: this one completed,
 * this one was cut mid-run and will resume exactly, this one is holding a
 * question for you. (0.40.1, owner's ruling: words, never glyphs — the
 * ✓ ✗ ▌ ? ◌ column that stood here said nothing the words did not.)
 *
 * Purity, as everywhere in this package: the cards are DATA the CLI
 * projects (session-cards.ts) and this module turns them into bytes. It
 * never reads a session, never asks the runtime anything, and holds no
 * state — which is what lets the picker band and the `kiso sessions`
 * listing render from ONE definition instead of two that drift.
 */

import { escapeTerminal, palette } from "./lines.js";
import { selectionBar, visibleWidth, widthCut } from "./components.js";
import { atEmbed, bandHeader, bandVisible, bandWindow, longestRun } from "./at-picker.js";

/** The projected card — structurally what apps/cli/src/session-cards.ts
 *  produces. Declared here as the tui's INPUT contract (the package
 *  imports nothing from the runtime, by rule). */
export interface SessionCardView {
	readonly id: string;
	/** REL-0152-D6b: the session's first substantive prompt. Optional so
	 *  a caller that has not got one still renders — the row simply
	 *  carries no title, which is where this picker started. */
	readonly title?: string;
	readonly badge: "uncertain" | "ask" | "interrupted" | "completed" | "failed" | "unknown";
	/** null when unknown — the row then says nothing about turns */
	readonly turns: number | null;
	readonly updatedAt: number;
	readonly uncertain: number;
	readonly asks: number;
	readonly outcome: string | null;
	/** 0.40.0: the realpath the session STARTED in, from its profile; null
	 *  when unknown (a legacy session). Absent = the caller did not say. */
	readonly workspace?: string | null;
	/** 0.40.0: the config profile its latest revision names, for a dim tag. */
	readonly profileName?: string | null;
	/** 0.40.0: its project was inferred by the one-time migration, never
	 *  recorded — the row says so. */
	readonly inferred?: boolean;
}

/** 0.40.0 — which sessions the picker shows. `here` is the running
 *  workspace's realpath; `all` is the person's choice; `unknown` counts
 *  the sessions with no recorded workspace (0.40.1), which the default view
 *  hides behind one header row.
 *
 *  0.40.1 (owner's ruling): the default view NEVER falls back to all. The
 *  fallback made every directory list every older session — 118 of them —
 *  which is the view the scope exists to prevent. */
export interface PickScopeState {
	readonly here: string;
	readonly all: boolean;
	readonly inHere: number;
	readonly total: number;
	readonly unknown: number;
}

/** The scope, as a pure function of the cards: CURRENT is the sessions
 *  whose recorded workspace IS the running one; a session with no recorded
 *  workspace is never "here" — unknown history is shown under ALL only. */
export function scopeSessions(cards: readonly SessionCardView[], here: string, wantAll: boolean): { readonly cards: readonly SessionCardView[]; readonly scope: PickScopeState } {
	const inHere = cards.filter((c) => c.workspace === here);
	const unknown = cards.filter((c) => c.workspace === null || c.workspace === undefined).length;
	return { cards: wantAll ? cards : inHere, scope: { here, all: wantAll, inHere: inHere.length, total: cards.length, unknown } };
}

/** The band's title — named after the command that opened it, then the
 *  scope and its counts. Graphite P1 (owner, 2026-09-30): the key that
 *  flips the scope moved to the key row, and a filter says how many of
 *  the scope match. */
export function scopeTitle(scope: PickScopeState | null, filter: { readonly matches: number; readonly of: number } | null = null): string {
	const match = filter === null ? null : `${filter.matches} of ${filter.of} match`;
	if (scope === null) return match === null ? "resume" : `resume · ${match}`;
	if (scope.all) return `resume · every workspace · ${match ?? scope.total}`;
	return `resume · this workspace · ${match ?? `${scope.inHere} of ${scope.total}`}`;
}

/** A workspace path as a person reads it: the home directory as `~`. */
function tildePath(path: string): string {
	const home = process.env.HOME;
	return home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** 0.40.0 — the row's dim tags: the profile the session last ran under,
 *  and — only when the row is from ANOTHER workspace than `here` — where
 *  it came from. `here === null` means the listing is not scoped at all,
 *  so no row is foreign.
 *
 *  Fitted to `room`, degrading by the DC-2 rule (drop or shorten a whole
 *  part, never cut one mid-word): the full path, then `…/<last dir>`, then
 *  the path alone without the profile, then nothing. An inferred row keeps
 *  its "inferred" mark longest. */
function fitTags(card: SessionCardView, here: string | null, room: number): string {
	const profile = typeof card.profileName === "string" && card.profileName !== "" ? card.profileName : null;
	const foreign = here !== null && card.workspace !== undefined && card.workspace !== here;
	const where = !foreign ? null : card.workspace === null || card.workspace === undefined ? "workspace unknown" : tildePath(card.workspace);
	const short = where === null || card.workspace === null || card.workspace === undefined ? where : `\u2026/${card.workspace.split("/").filter((x) => x !== "").at(-1) ?? ""}`;
	const join = (parts: readonly (string | null)[]): string => {
		const kept = parts.filter((x): x is string => x !== null);
		return kept.length === 0 ? "" : ` \u00b7 ${kept.join(" \u00b7 ")}`;
	};
	// 0.40.0: an inferred project is a guess, and the row never presents a
	// guess as a record; the mark outlives the profile when room is short
	const mark = card.inferred === true ? "inferred" : null;
	for (const candidate of [join([profile, where, mark]), join([profile, short, mark]), join([short, mark]), join([profile, mark]), join([mark]), join([profile])]) {
		if (candidate !== "" && visibleWidth(candidate) <= room) return candidate;
	}
	return "";
}

/**
 * What the row SAYS about the state. The interrupted note is the
 * product's promise stated in the place the promise matters: the run
 * continues from its durable prefix, so picking this row costs nothing
 * that was already paid for.
 *
 * The ✗ note names the OUTCOME rather than flattening six endings into
 * one word — "aborted" and "max turns" are different things to have
 * happened, and a picker that calls both "failed" teaches the user
 * nothing.
 */
export function sessionNote(card: SessionCardView): string {
	switch (card.badge) {
		case "uncertain":
			return `${card.uncertain} uncertain — needs your verdict`;
		case "ask":
			return `${card.asks} ask${card.asks === 1 ? "" : "s"} pending`;
		case "interrupted":
			return "interrupted mid-run — resumes exactly";
		case "completed":
			return "completed clean";
		case "unknown":
			// 0.40.0 dogfood: no summary, or a log that could not be read —
			// said, never guessed
			return card.outcome ?? "no summary";
		default:
			return card.outcome === null || card.outcome === "error" ? "failed" : card.outcome.replaceAll("_", " ");
	}
}

/** The compact age — the picker's column, not the banner's sentence.
 *  `relativeTime` says "3d ago"; a column of ages does not need the
 *  word repeated on every row. */
export function sessionAge(updatedAt: number, now: number): string {
	const s = Math.max(0, now - updatedAt) / 1000;
	if (s < 60) return "now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d`;
	return `${Math.floor(d / 7)}w`;
}

/** The id column's width — computed over EVERY card, never over the
 *  filtered subset, so the columns do not jump while the user types
 *  (the whole reason a filter-as-you-type picker is usable). */
export function idColumn(cards: readonly SessionCardView[]): number {
	let w = 0;
	for (const c of cards) w = Math.max(w, visibleWidth(escapeTerminal(c.id)));
	return Math.min(Math.max(w, 1), 24);
}

/**
 * The filter — the @ picker's muscle, aimed at what the ROW SHOWS: a
 * case-insensitive SUBSEQUENCE, ranked by the longest contiguous run,
 * then by the haystack's length, then lexically. Identical determinism,
 * identical feel; a row under the cursor never moves because two
 * candidates tied.
 *
 * DC-13 (R2) — it used to search the ID and nothing else. That was
 * coherent while the id was the row's leading column; the owner's
 * ruling moved the TITLE there and retired the id from the row, and the
 * filter did not follow. The result is the worst kind of search: typing
 * what you can SEE returns nothing, and typing an id you cannot see
 * narrows the list for a reason the screen never explains.
 *
 * Both are searched, title FIRST. The id stays a haystack because
 * `kiso sessions` prints ids and a human who copied one must be able to
 * paste it here; a title hit outranks an id hit at equal run length,
 * because the title is what the person was reading.
 *
 * An empty query matches everything and keeps the caller's order (the
 * listing's newest-first), because "no query" is not a search — it is
 * the list.
 */
export function sessionFilter(cards: readonly SessionCardView[], query: string): SessionCardView[] {
	if (query === "") return [...cards];
	const lower = query.toLowerCase();
	const scored: { card: SessionCardView; run: number; onTitle: boolean; key: string }[] = [];
	for (const card of cards) {
		const shown = (card.title ?? card.id).toLowerCase();
		const onTitle = atEmbed(shown, lower);
		const hit = onTitle ?? atEmbed(card.id.toLowerCase(), lower);
		if (hit === null) continue;
		const key = onTitle !== null ? shown : card.id;
		scored.push({ card, run: longestRun(hit), onTitle: onTitle !== null, key });
	}
	scored.sort((a, b) => {
		if (a.run !== b.run) return b.run - a.run;
		if (a.onTitle !== b.onTitle) return a.onTitle ? -1 : 1;
		if (a.key.length !== b.key.length) return a.key.length - b.key.length;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	return scored.map((s) => s.card);
}

/**
 * The row's spans, built against a HARD budget — the badge, the id
 * column, the metadata, the note.
 *
 * The spans are appended in order of what the row is FOR and each one
 * is dropped whole rather than half-drawn when the budget runs out:
 * the badge and the id are the row's identity, the age/turns say
 * whether it is the one, and the note is the sentence that explains
 * the badge. A narrow terminal loses them from the right.
 *
 * The running width is the authority — never a formula computed up
 * front. That is what the invariant-① sweep across five widths in the
 * gate is for: a row that overflows does not truncate quietly here, it
 * CRASHES the compositor, so the arithmetic has to be provably right at
 * every width rather than right at eighty.
 */
/** REL-0152-D6b: what the title may take, and what it must leave. The
 *  reserve is the widest note this picker writes ("N uncertain
 *  executions"), so an actionable row keeps saying so. */
const TITLE_MAX = 44;
const NOTE_RESERVE = 22;

function rowSpans(card: SessionCardView, budget: number, now: number, idCol: number, here: string | null = null): { text: string; width: number } {
	const p = palette();
	let text = "";
	let w = 0;
	/** append a styled span iff its VISIBLE cells still fit */
	const put = (plain: string, styled: string): void => {
		const cells = visibleWidth(plain);
		if (w + cells > budget) return;
		text += styled;
		w += cells;
	};
	// 0.40.1 (owner's ruling): NO status glyph. The ✓ ✗ ▌ ? ◌ column is
	// gone; the state is a WORD, in the note column (sessionNote), where it
	// already said everything the glyph did.
	// R2 (owner, 2026-08-27) — the TITLE LEADS and the id is gone.
	//
	// The id was four characters of machine identity sitting in the column
	// the eye lands on first, and the title — the only span that answers
	// "which conversation is this?" — came after the meta. The order is
	// reversed: the title takes the left edge, the age and turn count go
	// right and dim, and the note keeps its reserve. The id is still
	// reachable where it is USED (`kiso sessions`, `/status`) — it left
	// the row it was never the subject of.
	// a row with no title at all falls back to the id: the id left the
	// row it was never the subject of, but a row must still IDENTIFY
	// something — an anonymous row is not a picker row. (In practice
	// `sessionTitle` returns "(no prompt)" rather than "", so this is
	// the seam for callers that build a card without records.)
	const title = card.title ?? card.id;
	if (title !== "") {
		const room = Math.max(0, Math.min(budget - w - 3 - NOTE_RESERVE, TITLE_MAX));
		const cut = widthCut(escapeTerminal(title), room);
		if (cut !== "") put(cut, `${p.bold}${cut}${p.reset}`);
	}
	const meta = `  ${sessionAge(card.updatedAt, now)}${card.turns === null ? "" : ` · ${card.turns} turn${card.turns === 1 ? "" : "s"}`}`;
	put(meta, `${p.dim}${meta}${p.reset}`);
	// 0.40.0: the tags are their OWN span, after the meta and before the
	// note, and they give way first — a long workspace path must never take
	// the age and the turn count down with it, nor the note's reserve.
	// the note is what the person acts on ("needs your verdict"), so it keeps
	// its WHOLE width — a tag that cut it would trade an action for a label
	const noteCells = sessionNote(card) === "" ? 0 : visibleWidth(sessionNote(card)) + 3;
	const tags = fitTags(card, here, Math.max(0, budget - w - noteCells));
	if (tags !== "") put(tags, `${p.dim}${tags}${p.reset}`);
	const note = widthCut(sessionNote(card), Math.max(0, budget - w - 3));
	if (note !== "") {
		// the ? note carries the warn tint — the row's own words are what
		// the user acts on, and the one that demands an action says so
		put(" · ", `${p.dim} · ${p.reset}`);
		put(note, card.badge === "uncertain" ? `${p.warn}${note}${p.reset}` : `${p.dim}${note}${p.reset}`);
	}
	return { text, width: w };
}

/** The picker's bound state — the editor owns it, the compositor reads
 *  it (the @ picker's contract, one surface over). */
export interface SessionPickState {
	readonly cards: readonly SessionCardView[];
	readonly matches: readonly SessionCardView[];
	readonly selected: number;
	/** 0.40.0: null when the picker was opened without a workspace. */
	readonly scope?: PickScopeState | null;
	/** Graphite P1: the filter as typed — the title lights the letters it
	 *  matched, and the band says how many match. Absent = no filter. */
	readonly query?: string;
}

/*
 * Graphite P1 — the /resume picker as a table (owner, 2026-09-30: option
 * B, revision 2, after comparing it with the reference picker).
 *
 * DECLARED CHANGES, each against the ruling it touches:
 *  - The row is a TABLE: the title, then a state word, the age and the
 *    turns in columns measured over every card in the scope (never the
 *    filtered subset — the idColumn rule, kept), so the eye reads down a
 *    column and nothing moves while the person types. The facts used to
 *    trail the title and start at a different cell on every row.
 *  - The state is a word only when it asks for attention. A finished
 *    session says nothing; `interrupted` is blue (unfinished work, the
 *    running card's colour), an ask or an uncertain side effect gold (it
 *    waits for the person), a failed ending red. 0.40.1's "words, never
 *    glyphs" stands — the quiet default is an empty cell, not a glyph.
 *  - The row under the cursor OPENS into a second row that says the
 *    whole note (sessionNote — one definition with `kiso sessions`), when
 *    the session started, its profile, and its id where they fit. The
 *    note used to be on every row; R2's "the id left the row" stands —
 *    it is on the opened card only.
 *  - 0.40.1's row counting the sessions with no workspace, above the
 *    list, is folded into the key row's `tab N more elsewhere` (N counts
 *    them with the rest). The default view still never falls back to
 *    every workspace; under tab they are listed, marked `unknown`.
 *  - The counter row joins the key row; the band shows eight sessions on
 *    a terminal 30 rows or taller, five below (it showed five).
 */

/** How many sessions the band shows: eight on a terminal 30 rows or
 *  taller, five below (owner, 2026-09-30). */
export function resumeVisible(height: number): number {
	return bandVisible(height); // Graphite P2: one window rule for every band
}

/** The window over the matches, with a scroll-off of one: while more lies
 *  past an edge, the cursor stays a row inside it, so the edge row that
 *  carries a more-mark is never the selected one. Stateless, like
 *  atWindow: the same (total, selected) always draws the same window. */
export function resumeWindow(total: number, selected: number, visible: number): { first: number; count: number } {
	return bandWindow(total, selected, visible);
}

/** The row's state word — empty for the quiet default, a finished session. */
export function sessionStateWord(card: SessionCardView): string {
	switch (card.badge) {
		case "interrupted":
			return "interrupted";
		case "ask":
			return `${card.asks} ask${card.asks === 1 ? "" : "s"}`;
		case "uncertain":
			return `${card.uncertain} uncertain`;
		case "completed":
			return "";
		default:
			// failed (the outcome's own words) and unknown ("no summary")
			return sessionNote(card);
	}
}

/** The state's colour: blue for unfinished work, gold for what waits for
 *  the person, red for a failed ending, dim for what is not known. Off a
 *  known ground gold falls back to the warn tint and blue to none. */
function stateTone(card: SessionCardView): string {
	const p = palette();
	switch (card.badge) {
		case "interrupted":
			return p.blue;
		case "ask":
		case "uncertain":
			return p.gold !== "" ? p.gold : p.warn;
		case "failed":
			return p.red;
		case "completed":
			return "";
		default:
			return p.dim;
	}
}

/** Where a row is from, for the workspace column (every-workspace view
 *  only): blank for this workspace, `unknown` for a session from before
 *  workspaces were recorded, the last directory — or on a wide terminal
 *  the path — for another. */
function whereOf(card: SessionCardView, here: string, wide: boolean): string {
	if (card.workspace === here) return "";
	if (card.workspace === null || card.workspace === undefined) return "unknown";
	return wide ? tildePath(card.workspace) : `…/${card.workspace.split("/").filter((x) => x !== "").at(-1) ?? ""}`;
}

/** A title fitted to its column: whole when it fits; otherwise cut by
 *  CELLS (a CJK character is two) with an ellipsis — on a space when one
 *  lies in the last two fifths, so a word is not halved needlessly. */
function fitTitle(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	if (room <= 1) return widthCut(text, Math.max(0, room));
	let cut = widthCut(text, room - 1);
	const sp = cut.lastIndexOf(" ");
	if (sp > cut.length * 0.6) cut = cut.slice(0, sp);
	return `${cut.trimEnd()}…`;
}

/** The columns — measured over EVERY card in the scope. `where` is
 *  non-null only in the every-workspace view. What gives way first as the
 *  width shrinks: the turns, then the workspace, then the state, then the
 *  age; the title keeps at least twelve cells while any column remains. */
interface ResumeColumns {
	readonly title: number;
	readonly state: number;
	readonly where: number;
	readonly age: number;
	readonly turns: number;
	/** the row's used width, its right margin included: the key row's
	 *  counter aligns to it */
	readonly table: number;
}
const TITLE_CAP = 60;
const TITLE_FLOOR = 12;
function resumeColumns(cards: readonly SessionCardView[], W: number, now: number, where: string | null): ResumeColumns {
	const wide = W >= 110;
	const width = (xs: readonly string[]): number => xs.reduce((m, x) => Math.max(m, visibleWidth(x)), 0);
	const longest = Math.max(1, width(cards.map((c) => escapeTerminal(c.title ?? c.id))));
	let parts = {
		state: width(cards.map(sessionStateWord)),
		where: where === null ? 0 : Math.min(wide ? 24 : 12, width(cards.map((c) => whereOf(c, where, wide)))),
		age: width(cards.map((c) => sessionAge(c.updatedAt, now))),
		turns: width(cards.map((c) => (c.turns === null ? "" : turnsOf(c.turns)))),
	};
	const avail = Math.max(0, W - 3); // the two-cell indent and one cell of right margin
	const used = (x: typeof parts): number => Object.values(x).reduce((s, v) => s + (v > 0 ? v + 2 : 0), 0);
	const floor = Math.min(longest, TITLE_FLOOR);
	for (const drop of ["turns", "where", "state", "age"] as const) {
		if (floor + used(parts) <= avail) break;
		parts = { ...parts, [drop]: 0 };
	}
	const title = Math.max(0, Math.min(longest, TITLE_CAP, avail - used(parts)));
	return { title, ...parts, table: 2 + title + used(parts) + 1 };
}

const turnsOf = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/** The title with the letters the filter matched in gold — what the
 *  person typed, in the colour of what the person says. */
function markMatches(title: string, query: string, base: string): string {
	const p = palette();
	const hit = query === "" ? null : atEmbed(title.toLowerCase(), query.toLowerCase());
	if (hit === null || hit.length === 0) return base === "" ? title : `${base}${title}${p.reset}`;
	const on = new Set(hit);
	const gold = p.gold !== "" ? p.gold : p.warn;
	let out = "";
	let i = 0;
	for (const ch of title) {
		out += on.has(i) ? `${p.reset}${p.bold}${gold}${ch}${p.reset}${base}` : ch;
		i += ch.length;
	}
	return `${base}${out}${p.reset}`;
}

/** ONE table row. Unselected it is indented two cells, or carries a dim
 *  more-mark in column 0 (column 1 stays empty, so the mark never reads
 *  as the title's first letter); selected it is the Graphite selection
 *  bar with the title in bold, its text still starting in column 2. */
function resumeRow(card: SessionCardView, selected: boolean, cols: ResumeColumns, W: number, now: number, query: string, where: string | null, mark: string | null): string {
	const p = palette();
	const title = fitTitle(escapeTerminal(card.title ?? card.id), cols.title);
	let text = `${markMatches(title, query, selected ? p.bold : "")}${" ".repeat(cols.title - visibleWidth(title))}`;
	if (cols.state > 0) {
		const word = sessionStateWord(card);
		const tone = stateTone(card);
		text += `  ${word === "" || tone === "" ? word : `${tone}${word}${p.reset}`}${" ".repeat(cols.state - visibleWidth(word))}`;
	}
	if (cols.where > 0 && where !== null) {
		const at = fitTitle(whereOf(card, where, W >= 110), cols.where);
		text += `  ${p.dim}${at}${p.reset}${" ".repeat(cols.where - visibleWidth(at))}`;
	}
	if (cols.age > 0) text += `  ${p.dim}${sessionAge(card.updatedAt, now).padStart(cols.age)}${p.reset}`;
	if (cols.turns > 0) text += `  ${p.dim}${(card.turns === null ? "" : turnsOf(card.turns)).padStart(cols.turns)}${p.reset}`;
	const w = cols.table - 3;
	if (selected) return selectionBar(` ${text}`, w + 1, W);
	return mark === null ? `  ${text}` : `${p.dim}${mark}${p.reset} ${text}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** When the session started, read from its id — the id IS the UTC stamp
 *  it was made at (apps/cli session-id.ts) — in local time. Null for an
 *  id that is not one. */
export function sessionStarted(id: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
	if (m === null) return null;
	const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
	if (Number.isNaN(t.getTime())) return null;
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${MONTHS[t.getMonth()]} ${t.getDate()} ${two(t.getHours())}:${two(t.getMinutes())}`;
}

/** The opened card's second row: the whole note (its state word in the
 *  state's colour, the rest dim), then — while they fit — when it
 *  started, its profile, where it is from (another workspace only), and
 *  its id. On the selection bar, like the row above it. */
function openedRow(card: SessionCardView, W: number, where: string | null): string {
	const p = palette();
	const room = Math.max(0, W - 3);
	const note = sessionNote(card);
	const dash = note.indexOf(" — ");
	const head = widthCut(dash < 0 ? note : note.slice(0, dash), room);
	const tone = stateTone(card);
	let text = tone === "" ? head : `${tone}${head}${p.reset}`;
	let w = visibleWidth(head);
	const facts: string[] = [];
	if (dash >= 0) facts.push(note.slice(dash));
	const started = sessionStarted(card.id);
	if (started !== null) facts.push(` · started ${started}`);
	if (typeof card.profileName === "string" && card.profileName !== "") facts.push(` · profile ${card.profileName}`);
	if (where !== null && typeof card.workspace === "string" && card.workspace !== where) facts.push(` · ${tildePath(card.workspace)}`);
	if (card.title !== undefined && card.title !== card.id) facts.push(` · ${card.id}`);
	for (const f of facts) {
		const cells = visibleWidth(escapeTerminal(f));
		if (w + cells > room) break;
		text += `${p.dim}${escapeTerminal(f)}${p.reset}`;
		w += cells;
	}
	return selectionBar(` ${text}`, w + 1, W);
}

/** The key row: what the keys do, then the selection's place in the whole
 *  filtered list, aligned to the table's right edge. The keys give way
 *  from the least needed — the scope's, then the arrows' — and enter and
 *  esc stay while anything does. */
function resumeKeyRow(state: SessionPickState, W: number, table: number): string {
	const p = palette();
	const total = state.matches.length;
	const count = total === 0 ? "0/0" : `${state.selected + 1}/${total}`;
	const scope = state.scope ?? null;
	const elsewhere = scope === null ? 0 : scope.total - scope.inHere;
	const tab = scope === null ? null : scope.all ? "tab this workspace" : elsewhere > 0 ? `tab ${elsewhere} more elsewhere` : null;
	const keys = ["↑↓ move", "⏎ resumes", tab, "esc"].filter((k): k is string => k !== null);
	const edge = Math.min(W, Math.max(table, visibleWidth(keys.join(" · ")) + count.length + 5));
	const fits = (ks: readonly string[]): boolean => 2 + visibleWidth(ks.join(" · ")) + 2 + count.length + 1 <= edge;
	let kept = keys;
	for (const drop of [tab, "↑↓ move", "⏎ resumes", "esc"]) {
		if (fits(kept)) break;
		kept = kept.filter((k) => k !== drop);
	}
	const text = kept.join(" · ");
	const gap = Math.max(1, edge - 1 - 2 - visibleWidth(text) - count.length);
	return `${p.dim}${widthCut(`  ${text}${" ".repeat(gap)}${count}`, W)}${p.reset}`;
}

/** What the empty input says while the picker is up: typing there filters. */
export const RESUME_FILTER_HINT = "filter by title or id";

/**
 * The whole band: the named hairline, the windowed table with the
 * selected row opened, and the key row. Returned as plain strings for the
 * menu-rows channel, which already accounts them in chromeRows — the
 * picker needs no geometry of its own, which is the entire reason it
 * rides that channel. `height` is the terminal's: it sets how many
 * sessions show (resumeVisible).
 */
export function sessionPickerRows(state: SessionPickState, W: number, now: number, height = 24): string[] {
	const p = palette();
	const scope = state.scope ?? null;
	const query = state.query ?? "";
	const rows: string[] = [bandHeader(scopeTitle(scope, query === "" ? null : { matches: state.matches.length, of: state.cards.length }), W)];
	// the workspace column shows only when every workspace is listed
	const where = scope !== null && scope.all ? scope.here : null;
	const cols = resumeColumns(state.cards, W, now, where);
	if (state.matches.length === 0) {
		// an empty view says why, rather than an empty band
		const empty = query !== "" ? `nothing matches “${escapeTerminal(query)}”` : scope !== null && !scope.all && scope.inHere === 0 ? "no session from this workspace yet" : "nothing to resume yet";
		rows.push(`${p.dim}${widthCut(`  ${empty}`, W)}${p.reset}`);
		rows.push(resumeKeyRow(state, W, cols.table));
		return rows;
	}
	const { first, count } = resumeWindow(state.matches.length, state.selected, resumeVisible(height));
	for (let i = first; i < first + count; i += 1) {
		const mark = i === first && first > 0 ? "↑" : i === first + count - 1 && first + count < state.matches.length ? "↓" : null;
		rows.push(resumeRow(state.matches[i]!, i === state.selected, cols, W, now, query, where, mark));
		if (i === state.selected) rows.push(openedRow(state.matches[i]!, W, where));
	}
	rows.push(resumeKeyRow(state, W, cols.table));
	return rows;
}

/**
 * Slice ③ — the `kiso sessions` TTY row: the same projection, printed
 * rather than picked. No selection bar (nothing is selected on a
 * listing) and no leading indent: this row starts at column 1 like
 * every other line a shell command prints.
 *
 * DC-16: it keeps the ID, and the picker row does not. Sharing one
 * projection is what stops the two surfaces drifting — that is this
 * module's whole design and it stays — but "share the projection" is
 * not "be the same row". The owner's ruling was about the PICKER, where
 * the id was four characters of machine identity in the column the eye
 * lands on first. A LISTING is the surface you read to copy an id OUT
 * of: it is what `/resume <id>` and the filter's id haystack both
 * assume exists, and deleting the id here quietly falsified both. The
 * id goes LAST and dim — present for the hand that needs it, out of the
 * way of the eye that does not.
 */
export function sessionListRow(card: SessionCardView, W: number, now: number, idCol: number, here: string | null = null): string {
	const p = palette();
	const tail = `  ${card.id}`;
	const { text, width } = rowSpans(card, Math.max(1, W - visibleWidth(tail)), now, idCol, here);
	if (width + visibleWidth(tail) > W) return text; // a terminal too narrow for both keeps the words
	return `${text}${p.dim}${tail}${p.reset}`;
}

/** Slice ③ — the listing's last line: the count, and the one thing the
 *  user can do next. */
export function sessionListFooter(count: number, W: number): string {
	const p = palette();
	return `${p.dim}${widthCut(`${count} session${count === 1 ? "" : "s"} · kiso resume picks interactively`, W)}${p.reset}`;
}

/** 0.40.1 — the `kiso sessions` TTY listing's line for the sessions with no
 *  recorded workspace: counted, never listed, and the flag that lists them.
 *  Empty when there are none. */
export function sessionListUnknownLine(unknown: number, W: number): string {
	if (unknown === 0) return "";
	const p = palette();
	return `${p.dim}${widthCut(`${unknown} older session${unknown === 1 ? "" : "s"} without a workspace \u00b7 --all`, W)}${p.reset}`;
}

/** 0.40.0 — the `kiso sessions` TTY listing's FIRST line: which sessions
 *  follow, and both counts. The listing never falls back the way the
 *  picker does: a listing that says "0 of 5 from this workspace" and how
 *  to see the rest is already the honest answer. */
export function sessionListHeader(inHere: number, total: number, all: boolean, W: number): string {
	const p = palette();
	const plural = (n: number): string => `${n} session${n === 1 ? "" : "s"}`;
	const text = all ? `all ${plural(total)}` : `${inHere} of ${plural(total)} from this workspace \u00b7 --all lists every one`;
	return `${p.dim}${widthCut(text, W)}${p.reset}`;
}
