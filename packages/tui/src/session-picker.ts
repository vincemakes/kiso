/**
 * TUI2-R2 slices ①–③ — the session picker's PURE half: the durability
 * badge, the row, the band, and the filter.
 *
 * The badge is the round's whole argument. kiso's claim is that a
 * session survives kill -9 and resumes from its durable prefix; until
 * now that claim was a sentence in a README. A badge per row makes it a
 * thing you can SEE before you pick: this one completed, this one was
 * cut mid-run and will resume exactly, this one is holding a question
 * for you.
 *
 * The vocabulary (the palette's functional set — no new colour):
 *
 *   ✓ green   the run's terminal event says completed
 *   ✗ red     the terminal says anything else
 *   ▌ bold    no terminal event — interrupted mid-run
 *   ? warn    the uncertain ledger is not empty (overrides ▌)
 *   ◌ dim     a permission request nobody has answered
 *
 * Purity, as everywhere in this package: the cards are DATA the CLI
 * projects (session-cards.ts) and this module turns them into bytes. It
 * never reads a session, never asks the runtime anything, and holds no
 * state — which is what lets the picker band and the `kiso sessions`
 * listing render from ONE definition instead of two that drift.
 */

import { escapeTerminal, palette } from "./render.js";
import { selectionBar, visibleWidth, widthCut } from "./components.js";
import { atEmbed, bandHeader, longestRun, AT_VISIBLE, atWindow } from "./at-picker.js";

/** The projected card — structurally what apps/cli/src/session-cards.ts
 *  produces. Declared here as the tui's INPUT contract (the package
 *  imports nothing from the runtime, by rule). */
export interface SessionCardView {
	readonly id: string;
	/** REL-0152-D6b: the session's first substantive prompt. Optional so
	 *  a caller that has not got one still renders — the row simply
	 *  carries no title, which is where this picker started. */
	readonly title?: string;
	readonly badge: "uncertain" | "ask" | "interrupted" | "completed" | "failed";
	readonly turns: number;
	readonly updatedAt: number;
	readonly uncertain: number;
	readonly asks: number;
	readonly outcome: string | null;
}

/** The glyph per state — one cell each, so the badge column never
 *  shifts the id column (a column that moves per row reads as damage). */
export const BADGE_GLYPH: Readonly<Record<SessionCardView["badge"], string>> = {
	completed: "✓", // ✓
	failed: "✗", // ✗
	interrupted: "▌", // ▌ — the input brick: this session is mid-sentence
	uncertain: "?",
	ask: "◌", // ◌ — the dotted circle: a question with no answer in it yet
};

/** The badge, styled. The colour IS the meaning here (the mono
 *  discipline's three functional exceptions), so NO_COLOR degrades to
 *  the glyph alone — which is why the glyphs are distinct shapes and
 *  not three coloured dots. */
export function sessionBadge(badge: SessionCardView["badge"]): string {
	const p = palette();
	const g = BADGE_GLYPH[badge];
	if (badge === "completed") return `${p.green}${g}${p.reset}`;
	if (badge === "failed") return `${p.red}${g}${p.reset}`;
	if (badge === "interrupted") return `${p.bold}${g}${p.reset}`;
	if (badge === "uncertain") return `${p.warn}${g}${p.reset}`;
	return `${p.dim}${g}${p.reset}`;
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

function rowSpans(card: SessionCardView, budget: number, now: number, idCol: number): { text: string; width: number } {
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
	// the badge: one glyph + one space, styled as a unit (the glyph's own
	// SGR spans make it unmeasurable by `put`'s plain/styled pair)
	if (w + 2 <= budget) {
		text += `${sessionBadge(card.badge)} `;
		w += 2;
	}
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
	const meta = `  ${sessionAge(card.updatedAt, now)} · ${card.turns} turn${card.turns === 1 ? "" : "s"}`;
	put(meta, `${p.dim}${meta}${p.reset}`);
	const note = widthCut(sessionNote(card), Math.max(0, budget - w - 3));
	if (note !== "") {
		// the ? note carries the warn tint — the row's own words are what
		// the user acts on, and the one that demands an action says so
		put(" · ", `${p.dim} · ${p.reset}`);
		put(note, card.badge === "uncertain" ? `${p.warn}${note}${p.reset}` : `${p.dim}${note}${p.reset}`);
	}
	return { text, width: w };
}

/**
 * ONE picker row. The selection is a FULL-ROW reverse bar — the R1.5
 * ⑧ ruling's shape, shared with the @ picker and the user chip: a
 * two-cell marker in an eighty-column row is a selection you have to
 * hunt for.
 *
 * The inner spans close with rvEnd inside the bar (never SGR 0, which
 * would punch a hole in it) — the same composition atRow uses.
 */
export function sessionRow(card: SessionCardView, selected: boolean, W: number, now: number, idCol: number): string {
	const p = palette();
	// both forms spend two cells of the width on their frame — the
	// unselected row's indent, the bar's own leading/trailing cell — so
	// the spans are built against the same budget either way and the
	// selection cannot change the columns
	const { text, width } = rowSpans(card, Math.max(0, W - 2), now, idCol);
	if (!selected) return `  ${text}`;
	// R2: one bar, in one place — and with it §2.1's rule that dim never
	// sits on the wash. The age/turns/note spans were dim INSIDE the bar,
	// grey on grey, on the row the cursor was pointing at.
	return selectionBar(text, width, W);
}

/** The counter row — the SELECTION's 1-based place in the whole
 *  filtered list, which the visible window cannot tell the user. */
export function sessionCounterRow(selected: number, total: number, W: number): string {
	const p = palette();
	return `${p.dim}${widthCut(total === 0 ? "  (0/0)" : `  (${selected + 1}/${total})`, W)}${p.reset}`;
}

/** The picker's bound state — the editor owns it, the compositor reads
 *  it (the @ picker's contract, one surface over). */
export interface SessionPickState {
	readonly cards: readonly SessionCardView[];
	readonly matches: readonly SessionCardView[];
	readonly selected: number;
}

/**
 * The whole band: the `sessions` header (R1.5 ⑦(b) — a band names
 * itself or it reads as more scrollback), at most AT_VISIBLE windowed
 * rows, then the counter. Returned as plain strings for the menu-rows
 * channel, which already accounts them in chromeRows — the picker needs
 * no geometry of its own, which is the entire reason it rides that
 * channel.
 */
export function sessionPickerRows(state: SessionPickState, W: number, now: number): string[] {
	const rows: string[] = [bandHeader("sessions", W)];
	const col = idColumn(state.cards);
	if (state.matches.length === 0) {
		const p = palette();
		rows.push(`${p.dim}${widthCut("  no session matches", W)}${p.reset}`);
		rows.push(sessionCounterRow(0, 0, W));
		return rows;
	}
	const { first, count } = atWindow(state.matches.length, state.selected, AT_VISIBLE);
	for (let i = first; i < first + count; i += 1) rows.push(sessionRow(state.matches[i]!, i === state.selected, W, now, col));
	rows.push(sessionCounterRow(state.selected, state.matches.length, W));
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
export function sessionListRow(card: SessionCardView, W: number, now: number, idCol: number): string {
	const p = palette();
	const tail = `  ${card.id}`;
	const { text, width } = rowSpans(card, Math.max(1, W - visibleWidth(tail)), now, idCol);
	if (width + visibleWidth(tail) > W) return text; // a terminal too narrow for both keeps the words
	return `${text}${p.dim}${tail}${p.reset}`;
}

/** Slice ③ — the listing's last line: the count, and the one thing the
 *  user can do next. */
export function sessionListFooter(count: number, W: number): string {
	const p = palette();
	return `${p.dim}${widthCut(`${count} session${count === 1 ? "" : "s"} · kiso resume picks interactively`, W)}${p.reset}`;
}
