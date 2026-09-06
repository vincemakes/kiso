/**
 * The SESSION PICKER's input controller — S5 (finding C10). TUI2-R2 ②:
 * the band's third occupant. Its filter is the @ picker's rank aimed at
 * the session id; this controller owns the keys, the compositor draws
 * the rows.
 *
 * The picker is MODAL in a way the @ picker is not: it opens before a
 * session exists, owns the whole composer (the buffer IS the filter
 * query, derived on every read rather than stored, so every buffer op —
 * backspace, the kills, paste — filters correctly with no handler of
 * its own), and the only ways out are a pick and an esc. That is why
 * the commit callback lives here rather than on the line channel: the
 * caller is waiting for an id, not for a turn.
 *
 * DECLARED MOVE (S5, 2026-09-06): `beginPick`, `#pickView`, `pickState`,
 * `#pickUp`, `#pickRows`, `#pickClose`, `#pickAccept` and the ↑↓ branch
 * stood in editor.ts; the bodies are the same, the buffer access goes
 * through the host.
 */
import { AT_VISIBLE } from "./at-picker.js";
import type { BandHost } from "./panel-input.js";
import { sessionFilter, type SessionCardView, type SessionPickState } from "./session-picker.js";

export class PickInput {
	#cards: (() => readonly SessionCardView[]) | null = null;
	#commit: ((id: string | null) => void) | null = null;
	#sel = 0;

	constructor(private readonly host: Pick<BandHost, "line" | "clear" | "reflow" | "render" | "syncMouse">) {}

	up(): boolean {
		return this.#cards !== null;
	}

	/** Open the picker on a bound card source. The composer is cleared
	 *  (the buffer becomes the filter query) and `onPick` receives the
	 *  chosen id — or null when the human leaves without picking, which
	 *  is a first-class outcome and not an error. */
	begin(cards: () => readonly SessionCardView[], onPick: (id: string | null) => void): void {
		this.#cards = cards;
		this.#commit = onPick;
		this.#sel = 0;
		this.host.syncMouse();
		this.host.clear();
		this.host.reflow();
		this.host.render();
	}

	/** The picker's state, derived: the full card list (the id column
	 *  measures over ALL of them, so the columns never jump), the
	 *  filtered matches, and the selection CLAMPED at read time — the
	 *  same correction discipline the @ picker uses, for the same
	 *  reason: narrowing can only ever shrink the list. */
	state(): SessionPickState | null {
		if (this.#cards === null) return null;
		const cards = this.#cards();
		const matches = sessionFilter(cards, this.host.line());
		return { cards, matches, selected: Math.max(0, Math.min(this.#sel, matches.length - 1)) };
	}

	/** The band's height estimate: the header + the windowed rows (or
	 *  the one "no match" row) + the counter. */
	rows(): number {
		const view = this.state();
		return view === null ? 0 : Math.min(Math.max(view.matches.length, 1), AT_VISIBLE) + 2;
	}

	/** ↑↓: the selection walks the matches and stops at both ends. True
	 *  when the picker owned the key (the caller renders). */
	arrow(dir: "up" | "down"): boolean {
		const view = this.state();
		if (view === null) return false;
		this.#sel = dir === "up" ? Math.max(0, view.selected - 1) : Math.min(Math.max(0, view.matches.length - 1), view.selected + 1);
		return true;
	}

	/** Close and hand the verdict back. The callback fires AFTER the
	 *  state is cleared, so a caller that re-enters (a second picker, a
	 *  session that starts) never sees the closing picker's rows. */
	close(id: string | null): void {
		const cb = this.#commit;
		this.#cards = null;
		this.#commit = null;
		this.#sel = 0;
		this.host.syncMouse();
		this.host.clear();
		this.host.reflow();
		cb?.(id);
		this.host.render();
	}

	/** Enter takes the SELECTED session. An empty match set takes
	 *  nothing and leaves the picker up: a picker that invented a pick
	 *  when the query matched nothing would resume the wrong session,
	 *  which is the one failure this surface must never have. */
	accept(): void {
		const view = this.state();
		if (view === null) return;
		const card = view.matches[view.selected];
		if (card === undefined) return;
		this.close(card.id);
	}
}
