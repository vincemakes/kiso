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
import { visibleWidth, widthCut } from "./components.js";
import { atEmbed, bandHeader, longestRun, AT_VISIBLE, atWindow } from "./at-picker.js";

/** The projected card — structurally what apps/cli/src/session-cards.ts
 *  produces. Declared here as the tui's INPUT contract (the package
 *  imports nothing from the runtime, by rule). */
export interface SessionCardView {
	readonly id: string;
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
 * The filter — the @ picker's muscle, aimed at the session id: a
 * case-insensitive SUBSEQUENCE, ranked by the longest contiguous run,
 * then by id length, then lexically. Identical determinism, identical
 * feel; a row under the cursor never moves because two ids tied.
 *
 * An empty query matches everything and keeps the caller's order (the
 * listing's newest-first), because "no query" is not a search — it is
 * the list.
 */
export function sessionFilter(cards: readonly SessionCardView[], query: string): SessionCardView[] {
	if (query === "") return [...cards];
	const lower = query.toLowerCase();
	const scored: { card: SessionCardView; run: number }[] = [];
	for (const card of cards) {
		const hit = atEmbed(card.id.toLowerCase(), lower);
		if (hit === null) continue;
		scored.push({ card, run: longestRun(hit) });
	}
	scored.sort((a, b) => {
		if (a.run !== b.run) return b.run - a.run;
		if (a.card.id.length !== b.card.id.length) return a.card.id.length - b.card.id.length;
		return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
	});
	return scored.map((s) => s.card);
}

/** The row's spans, unstyled-width accounted: the badge (1 cell), the
 *  id column, then the metadata. The note is the flexible span — it
 *  gives way first, because the id and the state are what the row is
 *  FOR. */
function rowSpans(card: SessionCardView, W: number, now: number, idCol: number): { text: string; width: number } {
	const p = palette();
	const id = widthCut(escapeTerminal(card.id), idCol);
	const pad = " ".repeat(Math.max(0, idCol - visibleWidth(id)));
	const meta = `${sessionAge(card.updatedAt, now)} · ${card.turns} turn${card.turns === 1 ? "" : "s"}`;
	// 4 = the leading badge cell + its space + the two spaces before the meta
	const fixed = 2 + idCol + 2 + visibleWidth(meta);
	const room = Math.max(0, W - fixed - 3); // " · " before the note
	const note = room > 0 ? widthCut(sessionNote(card), room) : "";
	// the ? note carries the warn tint — the row's own words are what the
	// user acts on, and the one that demands an action says so
	const noteStyled = note === "" ? "" : card.badge === "uncertain" ? `${p.warn}${note}${p.reset}` : `${p.dim}${note}${p.reset}`;
	const text = `${sessionBadge(card.badge)} ${id}${pad}  ${p.dim}${meta}${p.reset}${note === "" ? "" : `${p.dim} · ${p.reset}${noteStyled}`}`;
	const width = 2 + visibleWidth(id) + pad.length + 2 + visibleWidth(meta) + (note === "" ? 0 : 3 + visibleWidth(note));
	return { text, width };
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
	const { text, width } = rowSpans(card, W, now, idCol);
	if (!selected) return `  ${text}`;
	const inner = text.replaceAll(p.reset, `${p.reset}${p.rv}`);
	return `${p.rv} ${inner}${" ".repeat(Math.max(0, W - width - 2))} ${p.rvEnd}`;
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

/** Slice ③ — the `kiso sessions` TTY row: the SAME projection, printed
 *  rather than picked. No selection bar (nothing is selected on a
 *  listing) and no leading indent: this row starts at column 1 like
 *  every other line a shell command prints. */
export function sessionListRow(card: SessionCardView, W: number, now: number, idCol: number): string {
	return rowSpans(card, W, now, idCol).text;
}

/** Slice ③ — the listing's last line: the count, and the one thing the
 *  user can do next. */
export function sessionListFooter(count: number, W: number): string {
	const p = palette();
	return `${p.dim}${widthCut(`${count} session${count === 1 ? "" : "s"} · kiso resume picks interactively`, W)}${p.reset}`;
}
