/**
 * v2c — the raw-mode single-line editor that REPLACES readline on the TTY
 * path. Root cause of the v2b drift (plan 2026-08-05-tui-v2b §11): readline
 * re-renders its line by CHARACTER count and assumes it owns the row
 * exclusively — a CJK wide character (2 cells) shifts every following
 * column, and the dock's redraws make the mismatch permanent. Patching
 * readline is a dead end; the TTY path draws its own input row instead.
 * Non-TTY paths keep readline untouched (pipe bytes unchanged).
 *
 * Zero dependencies. The eastAsianWidth table is a ~40-line subset (CJK
 * ideographs/kana/hangul/fullwidth/common wide symbols = 2, everything
 * else = 1). Known limitation, documented in the README: emoji ZWJ
 * clusters (family emoji etc.) are not guaranteed perfect — each code
 * point counts as its width.
 *
 * KC1 (the multi-line composer): the buffer is FLAT — 0x0A is a stored
 * code point in #chars, and the lines, the cursor's row/column and the
 * visible window are all DERIVED per read (never a second mutable
 * model, so every existing op — insert, kills, history stash, queue-pop
 * replace, panel stash/restore — works unchanged). Bracketed paste
 * (?2004h) unwraps and inserts its newlines LITERALLY; every newline
 * source funnels through the ONE normalizer in feed() (§3).
 */

import { charWidth, displayWidth, leadWidth, widthOf } from "./width.js";
// the width primitives moved to width.ts (W1, the single width
// authority) — re-exported so the editor's public surface is unchanged.
export { charWidth, displayWidth, widthOf };
import { palette } from "./render.js";
import {
	PICK_MAX,
	panelOptions,
	saferDegradedNote,
	type AskRuntime,
	type PanelPhase,
	type PanelState,
	type PanelVerdict,
	type PanelView,
	type PickRuntime,
	type SaferAnswer,
	type SaferOption,
} from "./approval-panel.js";
// KC3.5: the panel-slot dispatchers — the ask branch folded into the
// W21 lead/rows, so this file keeps ONE panel and one key owner.
import { askCommitCustom, askKey, askOnCustomRow, askStart, panelLead } from "./ask-panel.js";
import { AT_VISIBLE, atFilter, type AtItem, type AtMatch } from "./at-picker.js";
// TUI2-R2 ②: the session picker — the band's THIRD occupant. Its filter
// is the @ picker's rank aimed at the session id; the editor owns the
// keys, the compositor draws the rows.
import { sessionFilter, type SessionCardView, type SessionPickState } from "./session-picker.js";

// TUI v4 #16d: the input row is the blue brick + the edit area — the
// "you>" text is gone (the brick IS the prompt; the pipe path's readline
// prompt keeps its own "you> " — v2a line mode, byte-for-byte).
/**
 * TUI2-R3v2 ② — the mouse-mode bytes, stated once.
 *
 * ?1000 is the button-event report and ?1006 is the SGR encoding that
 * makes it parseable past column 95 (the legacy X10 encoding packs the
 * coordinate into one byte and simply breaks on a wide terminal). Both
 * go on together and come off together; a terminal left with either one
 * set is a terminal that prints escape bytes at the shell prompt.
 */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

export const PROMPT = "▌ ";
export const PROMPT_WIDTH = displayWidth(PROMPT);

/** v3 §04 — the slash-command menu's command table (English one-liners). */
export interface MenuItem {
	readonly name: string;
	readonly desc: string;
}
export const MENU_ITEMS: readonly MenuItem[] = [
	{ name: "/mode", desc: "switch the approval tier (manual/default/accept-edits/plan/bypass)" },
	{ name: "/model", desc: "list model profiles; switch with /model <name|provider/model>" },
	{ name: "/compact", desc: "summarize the older conversation to free context" },
	// the /resume+/clear mini-spec: the session-navigation pair
	{ name: "/clear", desc: "start a fresh conversation (the old session stays resumable)" },
	{ name: "/resume", desc: "switch to another session; /resume <id> goes directly" },
	{ name: "/think", desc: "show the last full thinking block" },
	{ name: "/last", desc: "show the most recent tool call's input and output" },
	{ name: "/status", desc: "show session id, event count, and context estimate" },
	// TUI2-R1 (E): the rent-ledger attribution — where the context went
	{ name: "/context", desc: "show where the context went — the last request's rent ledger" },
	{ name: "/help", desc: "print this list of commands" },
];

/** KC1 §3 — the newline code point. Every source (paste, Ctrl+J, the
 *  Shift+Enter encodings, a CRLF pair) normalizes to exactly ONE. */
const NEWLINE = 0x0a;

/** KC3 §3 — the picker's sigil, and the two characters that count as a
 *  word boundary before it. A `@` anywhere else (vince@example.com) is
 *  an ordinary character: the reference is a thing you START, not a
 *  thing an address accidentally becomes. */
const AT = 0x40;
const SPACE = 0x20;
const TAB = 0x09;

/** KC1 §5 — the composer's CEILING (adjudication A1): at most 6 visible
 *  rows. A ceiling only — N_visible clamps by the terminal's height so
 *  the geometry stays legal down to the compositor's enter gate (H = 4
 *  ⇒ one row, exactly today's minimum). */
const N_MAX = 6;
/** DC-7 — the longest OSC kiso will hold while waiting for a terminator.
 *  The reports it reads are tens of bytes; anything past this is a
 *  payload for someone else, and holding it is how the editor goes
 *  deaf. */
const OSC_MAX = 1024;

/** The dim "…" — the ONE truncation mark: the horizontal scroll's
 *  prefix (unchanged) and the viewport's hidden-rows markers. */
const ELLIPSIS = "\x1b[2m…\x1b[0m";

/**
 * The editor. Raw mode + bracketed paste (?2004h) on enter, restored on
 * exit. The input row is rendered by `onRender` (the CLI wires it to the
 * dock's redraw when docked, the editor's own self-render otherwise) —
 * the editor itself never writes while docked. The event handlers are
 * settable — the chat/resume contexts wire them after construction.
 */
export class Editor {
	#chars: number[] = [];
	#cursor = 0;
	#scroll = 0; // chars scrolled off the left of the CURSOR'S LINE (width-based reflow; KC1: line-local, so a single-line buffer is unchanged)
	// KC1 §2 — the ONE new ephemeral field: the desired column for the
	// ↑/↓ walk (a long line's column 20 → a short line clamps to 5 → the
	// next long line RETURNS to 20). Set on the first vertical move,
	// kept across consecutive ones, reset by any horizontal move, insert
	// or delete. Never stashed — it is a walk's state, not the buffer's.
	#verticalGoalCol: number | null = null;
	#questionCb: ((answer: string) => void) | null = null;
	// W21: the panel state machine — the approval/trust panel owns the
	// interaction while up: the digit/y/n/esc/tab routing, the rule
	// input, the tab-amend feedback, the phase/selection the compositor
	// renders. The menu never opens while a panel is up; the pre-panel
	// buffer is stashed at open and restored at close (commit AND
	// cancel) — the panel's rule/feedback text never leaks into the
	// user's next turn.
	#panel: {
		view: PanelView;
		phase: PanelPhase;
		/** TUI2-R3v2 ①: the highlighted row, 0-based into panelOptions. */
		cursor: number;
		/** TUI2-R3v2 ①: one dim line the panel owes the human after a
		 *  gesture that could not do what it offered. Cleared by the next
		 *  gesture — a stale apology is its own kind of lie. */
		note: string | null;
		/** TUI2-R3v2 ③: the caller's safer-options provider. Absent = the
		 *  button degrades honestly rather than pretending. R3v2-F1: it may
		 *  now resolve a FAILURE that names its cause, not only `null`. */
		safer: (() => Promise<SaferAnswer>) | undefined;
		/** TUI2-R3v2 ③: the safer list's walk, once the answer landed. */
		saferRun: { options: readonly SaferOption[]; cursor: number } | null;
		/** KC3.5: the ask's walk — non-null exactly for an ask view. */
		ask: AskRuntime | null;
		/** TUI2-R2 ④: the pick panel's cursor + phase; null on every other
		 *  flavour. */
		pick: PickRuntime | null;
		onCommit: (v: PanelVerdict) => void;
		stash: { chars: number[]; cursor: number; scroll: number };
	} | null = null;
	#pasting = false;
	/**
	 * REL-0152-D8 — the paste capsule.
	 *
	 * A paste large enough to break the composer's layout is held HERE
	 * and shown in the buffer as `[Pasted text #N +M lines]`. The buffer
	 * is the display; this map is the content; the line that LEAVES the
	 * editor is the content again. That ordering is the whole design —
	 * the capsule can never truncate what gets sent, because expansion
	 * happens on the way out and reads from a map the display cannot
	 * edit.
	 *
	 * A capsule the human deletes is a paste that never happened: the
	 * token is gone, the expansion finds nothing to replace, and the
	 * entry is simply never read. That is how you take a paste back.
	 *
	 * The map is per-editor and grows by one entry per large paste in a
	 * session — bounded by how many times a human can press cmd-V, and
	 * every entry is text they chose to paste and may still submit.
	 */
	#pastes = new Map<number, string>();
	/**
	 * REL-0152-D16 — which file each `[Image #N]` capsule stands for.
	 *
	 * D15 made ctrl+V fetch the clipboard and it worked; then it inserted
	 * the PATH, the path began with `/`, and the composer handed it to
	 * the slash-command dispatcher. A feature that reaches the last step
	 * and gives the result to the wrong parser has not shipped.
	 *
	 * So the buffer carries a token and this carries the file. The token
	 * is what the LINE is — the dispatcher sees `[Image #1]`, which is
	 * not a command and never could be — and the CLI reads this map when
	 * it builds the turn. Unlike the text capsule, the image is NOT
	 * expanded into the line on the way out: a path is not something the
	 * model should be sent, and a transcript full of temp-file names is
	 * not something the human should have to read.
	 */
	#attachments = new Map<number, string>();
	#attachSeq = 0;
	#pasteSeq = 0;
	/** The buffer index where the in-flight paste began; null outside one. */
	#pasteAt: number | null = null;
	/**
	 * REL-0152-D9 — the in-flight paste's characters, held OUT of the
	 * buffer until the paste ends.
	 *
	 * Every character used to go through #insert, which splices one code
	 * point and then reflows — and a reflow scans the line to find the
	 * cursor's bounds and measures its width. That is linear work per
	 * character, so a paste cost time in the SQUARE of its size: measured
	 * on the shipped build, 10k characters took 33ms and 30k took 278ms,
	 * with a 100k paste heading for three seconds of a frozen composer.
	 * The owner's report: the capsule appears, but only after a long wait.
	 *
	 * Held here, the whole run splices in ONCE and reflows ONCE, so the
	 * cost is linear and the arithmetic is done on a finished string
	 * rather than re-done at every character of it. It survives across
	 * chunks by construction — a terminal delivers a large paste in many
	 * reads, and this is a field, not a local.
	 */
	#pasteRun: number[] | null = null;
	/**
	 * REL-0152-D11/D15 — the clipboard hook.
	 *
	 * A terminal cannot put binary into a byte stream, so pasting an image
	 * sends no image. D11 keyed on an EMPTY bracketed paste, reasoning
	 * that the paste would still arrive with nothing in it. Half right:
	 * with no TEXT on the clipboard many terminals send no paste at all,
	 * so there was no empty paste to react to and the owner's cmd+V and
	 * ctrl+V both did nothing.
	 *
	 * ctrl+V is the gesture that always arrives — 0x16, a byte the editor
	 * has always received and thrown away as "other control". The empty
	 * paste stays wired too, because terminals differ and one that does
	 * send it should behave the same. Two doors, one room.
	 *
	 * The editor does not know what a clipboard is and must not: this
	 * package renders and reads keys, and reaching into the operating
	 * system from it would put a platform dependency under every gate in
	 * the suite. The CLI supplies the hook; the editor supplies the
	 * moment. It returns the text to insert (a path, for the CLI's
	 * attachment scan to pick up) or null when there was nothing.
	 */
	#onClipboardPaste: (() => string | null) | null = null;
	/** TUI2-R3v2 ①: one-shot — a panel that just closed swallows the
	 *  habitual trailing enter rather than submitting the restored draft. */
	#swallowEnter = false;
	/** TUI2-R3v2 ②: whether SGR 1006 reporting is currently enabled. */
	#mouseOn = false;
	/** TUI2-R3v2 ③: the safer ask's generation. A panel the human escaped
	 *  must not be resurrected by a promise nobody is waiting for. */
	#saferToken = 0;
	/** TUI2-R3v2 ②: where the compositor put the panel's option rows this
	 *  frame (absolute 1-based screen rows). The editor owns no geometry —
	 *  it asks the surface that placed them. */
	#panelRows: (() => { top: number; count: number; first?: number } | null) | null = null;
	#lineCb: ((line: string) => void) | null = null;
	#pendingLines: string[] = []; // submits before onLine is wired (startup) — never dropped
	#sigintCb: (() => void) | null = null;
	#eotCb: (() => void) | null = null;
	// W18: the escape LIST — the run-abort (chat) and the /compact cancel
	// (dispatch) coexist; a listener removes itself via an unarmed guard
	// (the compact's handler no-ops after its abort has fired).
	#escapeCbs: (() => void)[] = [];
	// KC2 §2: the redirect LIST — mirrors #escapeCbs. The editor FORWARDS
	// the gesture with the buffer's text; it never interprets it. What a
	// redirect MEANS (abort the run, then run THIS ahead of the queue) is
	// the CLI's — here it is only "these two keys, pressed together, hand
	// the line over by a different door than Enter's".
	#redirectCbs: ((line: string) => void)[] = [];
	// W15: the expand-key list (ctrl+r) — the CLI's dispatch decides the
	// target (a live cell toggles in place; a committed cell appends the
	// expanded block). Mirrors the escape list: multiple listeners can
	// coexist; the editor never interprets the key itself.
	#expandCbs: (() => void)[] = [];
	#onRender: () => void;
	/** TUI2-R1 (D): the keys sheet — a static one-screen overlay opened by
	 *  `?` on an empty composer and closed by the next key, whatever it
	 *  is. Deliberately a BOOLEAN and not a panel: the panel machinery
	 *  exists for interactions (a lead, a status, a reducer, a stashed
	 *  buffer), and the sheet has no interaction to speak of. */
	#sheetOpen = false;
	#menuOpen = false; // v3 §04: the slash-command menu
	#menuSel = 0;
	// KC3 §3 — the @ file picker. THREE fields and no more: the armed
	// bit, the selection, and the per-open SNAPSHOT of the file list.
	// The query is deliberately NOT stored — it is derived from the
	// buffer and the cursor on every read (the KC1 flat-buffer
	// discipline: never a second mutable model). That is what makes
	// backspacing past the `@` close the picker with no handler
	// anywhere, and what keeps every existing op — the kills, paste,
	// the history stash, the queue-pop replace — correct for free.
	#atOpen = false;
	#atSel = 0;
	// the list is snapshotted AT OPEN and held for that open's lifetime
	// (§4: no index, no watcher, no re-listing per keystroke). An armed
	// bit with no token under the cursor is inert by construction — the
	// next open re-snapshots, so a stale list can never be shown.
	#atList: readonly AtItem[] | null = null;
	#atItems: (() => readonly AtItem[]) | null = null;
	// TUI2-R2 ② — the session picker. Two fields: the bound source (its
	// presence IS "the picker is up") and the selection. The query, like
	// the @ picker's, is DERIVED from the buffer on every read rather
	// than stored — so every existing buffer op (backspace, the kills,
	// paste) filters correctly with no handler of its own.
	//
	// The picker is MODAL in a way the @ picker is not: it opens before
	// a session exists, owns the whole composer, and the only ways out
	// are a pick and an esc. That is why the commit callback lives here
	// rather than on the line channel — the caller is waiting for an id,
	// not for a turn.
	#pickCards: (() => readonly SessionCardView[]) | null = null;
	#pickCommit: ((id: string | null) => void) | null = null;
	#pickSel = 0;
	// A2 (the feel): the session-scoped input history — every submitted TURN
	// line (never a question answer), capped at 100, never persisted. ↑↓
	// navigate it ONLY from an empty input or while already browsing.
	#history: string[] = [];
	#historyIdx: number | null = null;
	#preBrowse: number[] = [];
	// UD-1: minimal draft undo. Two stacks of FROZEN snapshots beside
	// the one mutable buffer (the KC1 flat-buffer discipline holds —
	// the stacks are history, never a second projection). A checkpoint
	// is pushed only by a gesture about to discard ≥1 code point (the
	// kills, the menu-esc clear, each queue-pop replacement, the
	// @-apply splice); typing and single backspace push nothing — v1
	// is loss-recovery, not char-granular edit history. ctrl+z
	// restores text+cursor exactly; ctrl+y mirrors; undo never
	// discards (what it replaces always lands on the redo stack).
	// Both stacks clear on submit/clearLine — a sent turn is in the
	// durable log and the ↑ history, not a loss.
	#undoStack: { chars: readonly number[]; cursor: number }[] = [];
	#redoStack: { chars: readonly number[]; cursor: number }[] = [];
	// W22: the pending-turn queue's bound state — the CLI's live slots
	// (chat.ts). ↑ pops the LAST queued message into the buffer and
	// enters the pop-mode (the walk: repeated ↑ pop older ones, each
	// replacing the line); esc in the pop-mode pops once more and ENDS
	// the mode — the next esc at rest rides the escapeCbs (the
	// interrupt survives). The chips themselves are the compositor's
	// bindQueue; this is the keys only.
	#queueState: () => readonly string[] = () => [];
	#queuePop: (() => string | null) | null = null;
	#queuePopMode = false;
	#pending = ""; // an incomplete ESC/CSI/OSC prefix across chunks
	/** DC-7: the terminal's own reports (OSC). Never a keystroke. */
	#oscCb: ((body: string) => void) | null = null;
	#decoder = new TextDecoder();
	#entered = false;
	#onData: (raw: Uint8Array) => void;
	#closedResolve!: () => void;
	readonly closed: Promise<void>;

	constructor(onRender: () => void) {
		this.#onRender = onRender;
		this.#onData = (raw) => this.feed(raw);
		this.closed = new Promise((resolve) => {
			this.#closedResolve = resolve;
		});
	}

	/**
	 *  DC-7 — the terminal answering a question kiso asked it.
	 *
	 *  The body is everything between `ESC ]` and the terminator, verbatim
	 *  and unparsed (`11;rgb:ffff/ffff/ffff`). The editor's job ends at
	 *  keeping it out of the draft; deciding what a report MEANS belongs to
	 *  whoever asked the question.
	 */
	onOsc(cb: (body: string) => void): void {
		this.#oscCb = cb;
	}

	onLine(cb: (line: string) => void): void {
		this.#lineCb = cb;
		// Flush submits that arrived before the handler was wired (typed
		// during startup) — readline buffered these; the editor must too.
		for (const line of this.#pendingLines) cb(line);
		this.#pendingLines.length = 0;
	}

	onSigint(cb: () => void): void {
		this.#sigintCb = cb;
	}

	onEot(cb: () => void): void {
		this.#eotCb = cb;
	}

	onEscape(cb: () => void): void {
		this.#escapeCbs.push(cb);
	}

	#onModeCycle: (() => void) | null = null;

	/** R3a — Shift+Tab: the approval-tier cycle. The MEANING lives in the
	 *  CLI (which tier follows which); the editor only reports the key. */
	onModeCycle(cb: () => void): void {
		this.#onModeCycle = cb;
	}

	onExpand(cb: () => void): void {
		this.#expandCbs.push(cb);
	}

	/** KC2 §2: the redirect chain — the gesture hands the buffer's text
	 *  over while the run is told to stop. Mirrors onEscape (a list, so
	 *  listeners can coexist); the line arrives already gone from the
	 *  composer, exactly as a submit's does. */
	/** REL-0152-D11/D15: where to get the clipboard's contents when the
	 *  human asks for them — ctrl+V, or an empty paste. The CLI owns the
	 *  platform, the editor owns the moment. */
	onClipboardPaste(cb: () => string | null): void {
		this.#onClipboardPaste = cb;
	}

	/** REL-0152-D16: the files this line's `[Image #N]` capsules stand
	 *  for, by their number. The CLI resolves them when it builds the
	 *  turn; a capsule the human deleted is simply never looked up. */
	attachments(): Map<number, string> {
		return new Map(this.#attachments);
	}

	onRedirect(cb: (line: string) => void): void {
		this.#redirectCbs.push(cb);
	}

	/** W22: bind the pending-turn queue — the CLI's live slots. The ↑
	 *  pop walks them (each pop leaves the queue, cancelling the turn);
	 *  esc ends the walk after one more pop. */
	bindQueue(state: () => readonly string[], pop: () => string | null): void {
		this.#queueState = state;
		this.#queuePop = pop;
	}

	/** The whole buffer as text (the CLI's line()/clearLine()). */
	line(): string {
		return String.fromCodePoint(...this.#chars);
	}

	/** TUI2-R1 (D): whether the keys sheet is up — the compositor's slot
	 *  read (bound like the menu and the picker). */
	sheetOpen(): boolean {
		return this.#sheetOpen;
	}

	clearLine(): void {
		this.#undoStack.length = 0; // UD-1
		this.#redoStack.length = 0;
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	// ---- KC1 §5: the DERIVED line model (the buffer stays FLAT) ----

	/** The lines as [start, end) index pairs — the 0x0A itself EXCLUDED.
	 *  A buffer without a newline is exactly ONE line spanning the whole
	 *  buffer: today's shape, derived. */
	#lineBounds(): { start: number; end: number }[] {
		const out: { start: number; end: number }[] = [];
		let start = 0;
		for (let i = 0; i < this.#chars.length; i += 1) {
			if (this.#chars[i] === NEWLINE) {
				out.push({ start, end: i });
				start = i + 1;
			}
		}
		out.push({ start, end: this.#chars.length });
		return out;
	}

	/** The cursor's line index — the first line whose end it has not
	 *  passed (a cursor resting ON a newline belongs to the line that
	 *  newline closes, never to the next one). */
	#cursorLine(bounds: { start: number; end: number }[]): number {
		for (let i = 0; i < bounds.length; i += 1) {
			if (this.#cursor <= bounds[i]!.end) return i;
		}
		return bounds.length - 1;
	}

	/** The cursor's OWN line — the unit of the horizontal scroll and of
	 *  the line-local A/E/U/K (A3). */
	#cursorBounds(): { start: number; end: number } {
		const bounds = this.#lineBounds();
		return bounds[this.#cursorLine(bounds)]!;
	}

	/** KC1 §5 — N_visible = min(lineCount, N_MAX, max(1, H − 3 − the
	 *  menu/queue bands)). The height clamp guarantees legal geometry
	 *  down to the compositor's enter gate; the compositor re-applies the
	 *  SAME formula against the frame's real bands (it alone knows their
	 *  folded row counts), so this is the editor's honest estimate and
	 *  the frame's clamp is the authority. */
	#visibleRows(lineCount: number): number {
		const H = process.stdout.rows ?? 24;
		const bands = (this.#menuOpen ? this.#menuFiltered().length : 0) + this.#atRows() + this.#pickRows() + this.#queueState().length;
		return Math.max(1, Math.min(lineCount, N_MAX, Math.max(1, H - 3 - bands)));
	}

	/** The dock's input-row state — ADDITIVE (§5): `line` + `cursor` keep
	 *  their legacy meaning (the CURSOR LINE's visible slice and the
	 *  cursor's display column in it — a single-line buffer yields
	 *  today's exact values, and a legacy one-row consumer keeps
	 *  working), and the composer's own view rides beside them.
	 *
	 *  The window is DERIVED per read — no persistent #vscroll:
	 *  visibleStart = clamp(cursorLine − N_visible + 1, 0, lineCount −
	 *  N_visible), so it trails the cursor, can never hide it, and no
	 *  stash / restore / clear / submit path has new state to carry. A
	 *  dim "…" marks whichever edge hides rows. */
	dockState(): { line: string; cursor: number; lines: string[]; cursorRow: number; cursorCol: number } {
		const bounds = this.#lineBounds();
		const cursorLine = this.#cursorLine(bounds);
		const n = this.#visibleRows(bounds.length);
		const first = Math.max(0, Math.min(cursorLine - n + 1, bounds.length - n));
		const lines: string[] = [];
		for (let i = first; i < first + n; i += 1) {
			const b = bounds[i]!;
			// the cursor's own row carries the horizontal scroll (and its
			// "…"); the other rows render whole and cap at the frame's wall
			const from = i === cursorLine ? b.start + this.#scroll : b.start;
			const scrolled = i === cursorLine && this.#scroll > 0 ? ELLIPSIS : "";
			const above = i === first && first > 0 ? ELLIPSIS : "";
			const below = i === first + n - 1 && first + n < bounds.length ? ELLIPSIS : "";
			lines.push(`${above}${scrolled}${String.fromCodePoint(...this.#chars.slice(from, b.end))}${below}`);
		}
		const cursorRow = cursorLine - first;
		// the window trails the cursor, so the hidden-above marker can only
		// share the cursor's row in the degenerate one-row window (a tiny
		// terminal) — where it shifts the column like the scroll's does
		const marks = (cursorRow === 0 && first > 0 ? 1 : 0) + (this.#scroll > 0 ? 1 : 0);
		const cursorCol = marks + widthOf(this.#chars.slice(bounds[cursorLine]!.start + this.#scroll, this.#cursor));
		return { line: lines[cursorRow]!, cursor: cursorCol, lines, cursorRow, cursorCol };
	}

	/** v3 §04: the menu's visible state for the dock — null when closed. */
	menuState(): { items: readonly MenuItem[]; selected: number } | null {
		if (!this.#menuOpen) return null;
		return { items: this.#menuFiltered(), selected: this.#menuSel };
	}

	/** v3 §04: the filtered command list for the current buffer — open
	 *  only while the line is "/" + something (a bare "/" waits). */
	#menuFiltered(): MenuItem[] {
		const line = this.line();
		if (!line.startsWith("/") || line === "/") return [];
		return MENU_ITEMS.filter((m) => m.name.startsWith(line));
	}

	#refreshMenu(): void {
		if (this.#panel !== null) return; // W21: the menu never opens while the panel owns the keys
		const f = this.#menuFiltered();
		this.#menuOpen = f.length > 0;
		if (this.#menuSel >= f.length) this.#menuSel = 0;
		this.#onRender();
	}

	/** KC3 §3 — bind the file source. The tui owns no file list and
	 *  never touches a disk (input is data, output is bytes): the CLI
	 *  feeds the paths, and until it does, the picker cannot open at
	 *  all — which is exactly why every non-@ scenario and every
	 *  consumer that does not bind (the recovery flow, the existing
	 *  gates) is byte-identical. */
	bindAtItems(source: () => readonly AtItem[]): void {
		this.#atItems = source;
	}

	/**
	 * KC3 §3 — the token under the cursor, DERIVED. Scans back from the
	 * cursor within the CURSOR'S LINE for the `@` that opens it:
	 *  - whitespace before finding one → there is no token (the space
	 *    ended it);
	 *  - an `@` that is not itself at a word boundary → inert (the
	 *    email case: the `@` of vince@example.com opens nothing);
	 *  - otherwise the token runs from that `@` to the CURSOR — never
	 *    to the end of the line, so `@ra|.js` narrows on "ra".
	 * Line-local: the start of any line of a multi-line composer is a
	 * boundary, exactly like the start of the buffer.
	 */
	#atToken(): { start: number; query: string } | null {
		const b = this.#cursorBounds();
		for (let i = this.#cursor - 1; i >= b.start; i -= 1) {
			const cp = this.#chars[i]!;
			if (cp === SPACE || cp === TAB) return null;
			if (cp !== AT) continue;
			const before = i > b.start ? this.#chars[i - 1]! : null;
			if (before !== null && before !== SPACE && before !== TAB) return null; // mid-word
			return { start: i, query: String.fromCodePoint(...this.#chars.slice(i + 1, this.#cursor)) };
		}
		return null;
	}

	/** KC3 §3 — the picker's full state, or null when it is not up. Up
	 *  requires ALL of: armed, nobody with higher precedence holding the
	 *  keys, a live token under the cursor, and at least one match (the
	 *  menu's precedent — a panel with nothing in it is noise, and the
	 *  keys fall back to their ordinary meanings). */
	#atView(): { matches: AtMatch[]; selected: number; capped: boolean; start: number } | null {
		if (!this.#atOpen || this.#atList === null) return null;
		if (this.#panel !== null || this.#menuOpen) return null;
		const token = this.#atToken();
		if (token === null) return null;
		const { matches, capped } = atFilter(this.#atList, token.query);
		if (matches.length === 0) return null;
		// the selection CLAMPS at read time rather than being corrected
		// on every edit — narrowing the query can only ever shrink the
		// list, and a clamp is the whole correction that needs
		return { matches, selected: Math.min(this.#atSel, matches.length - 1), capped, start: token.start };
	}

	#atUp(): boolean {
		return this.#atView() !== null;
	}

	/** KC3 §4 — the picker's visible state for the dock; null when
	 *  closed. The compositor windows it and draws the counter. */
	atState(): { matches: readonly AtMatch[]; selected: number; capped: boolean } | null {
		const view = this.#atView();
		if (view === null) return null;
		return { matches: view.matches, selected: view.selected, capped: view.capped };
	}

	/** KC3 §3 — arm the picker at a freshly typed `@`. The gate is the
	 *  KC2 precedence pattern: the approval panel, the slash menu and a
	 *  pending question each own the keys first. A paste is literal text
	 *  (guarded by the caller). The history browse and the queue-pop
	 *  walk are NOT re-tested here because typing has already ended them
	 *  — #insert leaves both before a character ever lands. */
	#atArm(): void {
		if (this.#atItems === null) return;
		// TUI2-R2 ②: not inside a session filter. An `@` typed into the
		// picker's query is a character in a session id, and a file picker
		// opening over a session picker would put two bands in one slot.
		if (this.#pickUp()) return;
		if (this.#panel !== null || this.#menuOpen || this.#questionCb !== null) return;
		if (this.#atToken() === null) return; // not at a word boundary
		this.#atOpen = true;
		this.#atSel = 0;
		this.#atList = this.#atItems(); // §5: listed per OPEN, never per keystroke
		this.#syncMouse();
	}

	#atClose(): void {
		this.#atOpen = false;
		this.#atSel = 0;
		this.#atList = null;
		this.#syncMouse();
	}

	/**
	 * KC3 §3 — accept: the token becomes `@<path> `.
	 *
	 * The CANONICAL PATH and a trailing space, and nothing else — the
	 * file's CONTENT is never inserted. That is the whole product
	 * decision: the model is handed a reference it can choose to read,
	 * so an @ mention costs a path's worth of tokens instead of a
	 * file's, and the model's own read_file call is what pays for the
	 * bytes it actually needs.
	 *
	 * Only [token.start, cursor) is replaced, so text after the cursor
	 * survives and a multi-line buffer keeps every other line.
	 */
	#atAccept(): void {
		const view = this.#atView();
		if (view === null) return;
		const insert = [...`@${view.matches[view.selected]!.path} `].map((ch) => ch.codePointAt(0)!);
		if (this.#cursor - view.start >= 1) this.#checkpoint(); // UD-1
		this.#chars.splice(view.start, this.#cursor - view.start, ...insert);
		this.#cursor = view.start + insert.length;
		this.#atClose();
		this.#reflow();
		this.#onRender();
	}

	/** KC3 §4 — the picker's band height, the editor's honest estimate
	 *  (the compositor re-applies the clamp against the frame's REAL
	 *  folded rows, exactly as it does for the menu): the windowed rows
	 *  plus the counter row. */
	#atRows(): number {
		const view = this.#atView();
		return view === null ? 0 : Math.min(view.matches.length, AT_VISIBLE) + 1;
	}

	// ── TUI2-R2 ② — the session picker ───────────────────────────────

	/** Open the picker on a bound card source. The composer is cleared
	 *  (the buffer becomes the filter query) and `onPick` receives the
	 *  chosen id — or null when the human leaves without picking, which
	 *  is a first-class outcome and not an error. */
	beginPick(cards: () => readonly SessionCardView[], onPick: (id: string | null) => void): void {
		this.#pickCards = cards;
		this.#pickCommit = onPick;
		this.#pickSel = 0;
		this.#syncMouse();
		this.#chars = [];
		this.#cursor = 0;
		this.#reflow();
		this.#onRender();
	}

	/** The picker's state, derived: the full card list (the id column
	 *  measures over ALL of them, so the columns never jump), the
	 *  filtered matches, and the selection CLAMPED at read time — the
	 *  same correction discipline the @ picker uses, for the same
	 *  reason: narrowing can only ever shrink the list. */
	#pickView(): SessionPickState | null {
		if (this.#pickCards === null) return null;
		const cards = this.#pickCards();
		const matches = sessionFilter(cards, this.line());
		return { cards, matches, selected: Math.max(0, Math.min(this.#pickSel, matches.length - 1)) };
	}

	pickState(): SessionPickState | null {
		return this.#pickView();
	}

	#pickUp(): boolean {
		return this.#pickCards !== null;
	}

	/** The band's height estimate: the header + the windowed rows (or
	 *  the one "no match" row) + the counter. */
	#pickRows(): number {
		const view = this.#pickView();
		return view === null ? 0 : Math.min(Math.max(view.matches.length, 1), AT_VISIBLE) + 2;
	}

	/** Close and hand the verdict back. The callback fires AFTER the
	 *  state is cleared, so a caller that re-enters (a second picker, a
	 *  session that starts) never sees the closing picker's rows. */
	#pickClose(id: string | null): void {
		const cb = this.#pickCommit;
		this.#pickCards = null;
		this.#pickCommit = null;
		this.#pickSel = 0;
		this.#syncMouse();
		this.#chars = [];
		this.#cursor = 0;
		this.#reflow();
		cb?.(id);
		this.#onRender();
	}

	/** Enter takes the SELECTED session. An empty match set takes
	 *  nothing and leaves the picker up: a picker that invented a pick
	 *  when the query matched nothing would resume the wrong session,
	 *  which is the one failure this surface must never have. */
	#pickAccept(): void {
		const view = this.#pickView();
		if (view === null) return;
		const card = view.matches[view.selected];
		if (card === undefined) return;
		this.#pickClose(card.id);
	}

	/** One-shot question mode: the NEXT submit answers, not a turn. */
	question(_query: string, cb: (answer: string) => void): void {
		this.#questionCb = cb;
	}

	/** Cancel a pending question — the buffer stays (its text becomes the
	 *  next turn on Enter, the readline re-emit equivalent). */
	cancelQuestion(): void {
		this.#questionCb = null;
	}

	/** W21: open the approval panel. The current buffer is stashed
	 *  (restored at close — commit AND cancel), the panel takes the
	 *  keys and the input row's lead, the menu closes. */
	beginPanel(view: PanelView, onCommit: (v: PanelVerdict) => void, opts?: { safer?: () => Promise<SaferAnswer> }): void {
		this.#panel = {
			view,
			phase: "options",
			cursor: 0,
			note: null,
			safer: opts?.safer,
			saferRun: null,
			ask: view.ask === undefined ? null : askStart(view.ask),
			// TUI2-R2 ④: the pick's walk — present exactly when the view is
			// a pick, the same contract the ask's runtime has.
			pick: view.pick === undefined ? null : { cursor: 0, phase: "options" as const },
			onCommit,
			stash: { chars: this.#chars, cursor: this.#cursor, scroll: this.#scroll },
		};
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#menuOpen = false;
		this.#menuSel = 0;
		this.#queuePopMode = false; // W22: the panel owns the keys while up
		this.#atClose(); // KC3 §3: and the picker closes with everything else
		this.#syncMouse();
		this.#onRender();
	}

	/** W21: cancel the panel — the SIGINT path's pair to beginPanel. */
	cancelPanel(): void {
		this.#panelClose({ action: "cancel" });
	}

	/** W21: the compositor's bound view — the phase/selection while the
	 *  panel is up, null otherwise. */
	panelState(): PanelState | null {
		const panel = this.#panel;
		if (panel === null) return null;
		return {
			view: panel.view,
			phase: panel.phase,
			cursor: panel.cursor,
			...(panel.note === null ? {} : { note: panel.note }),
			...(panel.saferRun === null ? {} : { safer: panel.saferRun }),
			...(panel.ask === null ? {} : { ask: panel.ask }),
			...(panel.pick === null ? {} : { pick: panel.pick }),
		};
	}

	enter(): void {
		if (this.#entered) return;
		this.#entered = true;
		process.stdin.setRawMode(true);
		// TUI2-R3v2 ②: the DEFENSIVE reset, first byte out.
		//
		// Mouse reporting is process state the terminal keeps, not state we
		// keep, so a previous kiso that died with a panel open (kill -9, a
		// panic, a closed laptop) left the terminal reporting clicks to
		// whatever ran next — and nothing in that dead process can ever
		// clean up after it. A fresh process is the only thing left that
		// can, so it does, unconditionally, before it draws anything.
		process.stdout.write(MOUSE_OFF);
		process.stdout.write("\x1b[?2004h"); // bracketed paste ON
		process.stdin.on("data", this.#onData);
		this.#onRender();
	}

	exit(): void {
		if (!this.#entered) return;
		this.#entered = false;
		process.stdin.off("data", this.#onData);
		// TUI2-R3v2 ②: unconditional, and BEFORE raw mode goes away — a
		// terminal left reporting mouse events prints escape bytes at the
		// shell prompt on every click and every scroll, and the user's only
		// fix is `reset`. The flag is not consulted: exit() is the last
		// chance this process gets, and emitting six harmless bytes twice
		// is not a cost worth reasoning about.
		process.stdout.write(MOUSE_OFF);
		this.#mouseOn = false;
		process.stdout.write("\x1b[?2004l"); // bracketed paste OFF
		// REL-0161: the hardware cursor was hidden for the session's whole
		// life (the compositor's entry reset); this is the one place kiso
		// hands the terminal back. kill -9 skips it — the same exposure
		// the reference implementation accepts; the entry repair covers
		// the next kiso, and `reset` covers the shell.
		process.stdout.write("\x1b[?25h");
		process.stdin.setRawMode(false);
		this.#closedResolve();
	}

	/**
	 * TUI2-R3v2 ② — mouse reporting follows the SELECTION SURFACES and
	 * nothing else.
	 *
	 * While it is on, the terminal's own text selection changes behaviour
	 * (shift+drag still selects on every terminal that matters, but plain
	 * drag-to-copy does not), so leaving it on for the whole session would
	 * tax every copy-paste in the product to pay for a gesture that only
	 * means something while a list is up. It goes on when one opens and
	 * off when it closes — and both calls are idempotent, because the
	 * surfaces nest (a panel can open over a picker) and the bytes must
	 * not depend on the order they unwind in.
	 */
	#setMouse(on: boolean): void {
		if (this.#mouseOn === on) return;
		this.#mouseOn = on;
		if (this.#entered) process.stdout.write(on ? MOUSE_ON : MOUSE_OFF);
	}

	/** The surfaces that own a selection — the approval/ask/pick panel, the
	 *  session picker and the @ picker. Any one of them up = reporting on. */
	#syncMouse(): void {
		this.#setMouse(this.#panel !== null || this.#pickCards !== null || this.#atUp());
	}

	/** The row's own render when the dock is inactive (a TTY without a
	 *  real size): \r + clear + blue brick prompt + visible + cursor
	 *  column. */
	selfRender(): void {
		const p = palette();
		const st = this.dockState();
		const W = (process.stdout.columns ?? 0) || 80; // a degenerate 0 size (no TIOCSWINSZ) falls back
		// W21: the panel's lead owns the row while up (the brick returns
		// when the panel closes).
		const panel = this.#panel;
		const lead = panel !== null ? panelLead(panel.view, panel.phase, panel.cursor, panel.ask ?? undefined) : `${p.bold}${PROMPT}${p.reset}`;
		// W23: the ONE width authority — leadWidth(lead), the ANSI-stripped
		// visible width (the styled panel lead / the styled brick measure
		// the same as their plain text — a lead can never measure
		// differently at the editor than at the compositor)
		const leadW = leadWidth(lead);
		const cursorCol = Math.min(1 + leadW + st.cursor, W);
		process.stdout.write(`\r\x1b[0K${lead}${st.line}\x1b[${cursorCol}G`);
	}

	// ---- input ----

	/** Feed raw stdin bytes — the parser. Public for unit tests. */
	feed(raw: Uint8Array): void {
		const text = this.#pending + this.#decoder.decode(raw, { stream: true });
		this.#pending = "";
		// TUI2-R1 (D): the sheet is up — ANY key closes it, and the key
		// that closed it is CONSUMED. The whole chunk goes, deliberately:
		// an arrow key is three bytes, and closing on the first while
		// letting `[A` fall through as literal text would be a sheet that
		// types into your composer on the way out. A dismissal costs one
		// keystroke; that is the entire contract.
		if (this.#sheetOpen) {
			this.#sheetOpen = false;
			this.#onRender();
			return;
		}
		let i = 0;
		while (i < text.length) {
			const c = text[i];
			// TUI2-R3v2 ①: the one-shot enter guard a just-closed panel arms
			// (see #panelClose). It sits at the very top of the loop because
			// the byte it must not let through is the FIRST byte after the
			// close, and it disarms on anything else in the same breath.
			if (this.#swallowEnter) {
				this.#swallowEnter = false;
				if (this.#panel === null && (c === "\x0d" || c === "\x0a")) {
					i += 1;
					continue;
				}
			}
			if (this.#panel !== null) {
				// W21: the panel owns the keys — a digit CONFIRMS its row in
				// the options phase, tab opens the amend (approval only), esc
				// backs out (amend → options, options → cancel), enter takes
				// the highlighted row. CSI/SS3 and the editing keys still ride
				// the normal chain below (the amend line is free text);
				// ctrl-c still rides the SIGINT handler (which cancels the
				// panel).
				const panel = this.#panel;
				// KC3.5: an ASK panel routes its own keys — the digits pick
				// (single-select advances, multi toggles), space toggles at
				// the cursor, `t` opens the type-your-own line (the
				// rule-input phase's shape: the buffer is the editor's, so
				// only esc and enter are intercepted while typing), esc
				// declines the whole call. Everything else falls through to
				// the ordinary editing chain below.
				// TUI2-R2 ④: a PICK panel routes its own keys — a digit moves
				// the cursor to that option (never commits: the choice is
				// CONFIRMED, so a mistyped digit is a mistake you can see
				// before it takes effect), `t` opens the type-it line, enter
				// commits, esc backs out then cancels. The swallow rule below
				// is the ask's, for the ask's reason: a typed `/` must not arm
				// the menu under a panel that owns the keys.
				if (panel.pick !== null) {
					const typing = panel.pick.phase === "custom";
					if (c === "\x1b" && !text.slice(i + 1).startsWith("[") && !text.slice(i + 1).startsWith("O")) {
						this.#pickPanelEsc();
						i += 1;
						continue;
					}
					if (c === "\x0d" || c === "\x0a") {
					// REL-0152-D10: a newline inside a PASTE is content, never a
					// commit. Bracketed paste marks its own boundaries, so a
					// \n between them is a line of the pasted text and nothing
					// else. Without this, pasting a stack trace into a typed
					// panel phase submitted the first line and dropped the
					// rest into the composer behind the closed panel — the
					// owner asked whether the type-your-own box takes a paste,
					// and the answer was no, in the worst way.
					if (this.#pasting) {
						this.#insert(NEWLINE);
						i += c === "\x0d" && text[i + 1] === "\x0a" ? 2 : 1;
						continue;
					}
						this.#pickPanelEnter();
						i += 1;
						continue;
					}
					if (!typing && c !== undefined && c >= "1" && c <= "9") {
						this.#pickPanelDigit(Number(c) - 1);
						i += 1;
						continue;
					}
					if (!typing && (c === "t" || c === "T")) {
						panel.pick = { cursor: panel.pick.cursor, phase: "custom" };
						this.#chars = [];
						this.#cursor = 0;
						this.#scroll = 0;
						this.#onRender();
						i += 1;
						continue;
					}
					if (!typing && c !== undefined && c >= " " && c !== "\x7f") {
						i += 1;
						continue;
					}
				}
				if (panel.ask !== null) {
					const typing = panel.ask.phase === "custom";
					if (c === "\x1b" && !text.slice(i + 1).startsWith("[") && !text.slice(i + 1).startsWith("O")) {
						this.#askStep("esc");
						i += 1;
						continue;
					}
					if (c === "\x0d" || c === "\x0a") {
					// REL-0152-D10: a newline inside a PASTE is content, never a
					// commit. Bracketed paste marks its own boundaries, so a
					// \n between them is a line of the pasted text and nothing
					// else. Without this, pasting a stack trace into a typed
					// panel phase submitted the first line and dropped the
					// rest into the composer behind the closed panel — the
					// owner asked whether the type-your-own box takes a paste,
					// and the answer was no, in the worst way.
					if (this.#pasting) {
						this.#insert(NEWLINE);
						i += c === "\x0d" && text[i + 1] === "\x0a" ? 2 : 1;
						continue;
					}
						this.#askStep(typing ? "commit" : "enter");
						i += 1;
						continue;
					}
					// REL-0152-D4 — on the custom row a printable key is TEXT.
					// The row names typing as its purpose and then swallowed
					// the first thing you typed; only enter or `t` opened the
					// phase. Now the keystroke opens it AND lands in the
					// buffer, so the character you meant is the character you
					// get. This is checked BEFORE the shortcut branch below on
					// purpose: on this row "3" and "t" are the start of an
					// answer, not a pick and not a mode key. Everywhere else
					// in the list they keep their fast-path meaning exactly.
					if (askOnCustomRow(panel.view.ask!, panel.ask) && c !== undefined && c >= " " && c !== "\x7f") {
						this.#askStep("type");
						this.#insert(c.codePointAt(0)!);
						this.#onRender();
						i += 1;
						continue;
					}
					if (!typing && (c === " " || (c !== undefined && c >= "1" && c <= "4") || c === "t" || c === "T")) {
						this.#askStep(c === " " ? "space" : c === "T" ? "t" : c);
						i += 1;
						continue;
					}
					// an ask at rest swallows stray PRINTABLE keys — the panel
					// owns them, and a typed "/" or "@" must not arm the menu
					// or the picker underneath. Two things are never
					// swallowed: the CSI/SS3 introducer, because ←/↑/↓ are
					// the ask's own keys and the parser below routes them
					// (the T-Q1 red), and the CONTROL characters, because
					// ctrl-c must still reach the SIGINT handler that
					// cancels the panel — W21's own rule, and what the T-Q6
					// race red caught: an abort with the panel up did
					// nothing at all.
					if (!typing && c !== undefined && c >= " " && c !== "\x7f") {
						i += 1;
						continue;
					}
				}
				if (c === "\x1b" && !text.slice(i + 1).startsWith("[") && !text.slice(i + 1).startsWith("O")) {
					this.#panelEsc();
					i += 1;
					continue;
				}
				if (c === "\t") {
					if (panel.phase === "options") this.#panelTab();
					i += 1;
					continue;
				}
				if (c === "\x0d" || c === "\x0a") {
				// REL-0152-D10: a newline inside a PASTE is content, never a
				// commit. Bracketed paste marks its own boundaries, so a
				// \n between them is a line of the pasted text and nothing
				// else. Without this, pasting a stack trace into a typed
				// panel phase submitted the first line and dropped the
				// rest into the composer behind the closed panel — the
				// owner asked whether the type-your-own box takes a paste,
				// and the answer was no, in the worst way.
				if (this.#pasting) {
					this.#insert(NEWLINE);
					i += c === "\x0d" && text[i + 1] === "\x0a" ? 2 : 1;
					continue;
				}
					this.#panelEnter();
					i += 1;
					continue;
				}
				// TUI2-R3v2 ③: the safer list answers the SAME keys the approval
				// list does — one interaction model means the new surface is not
				// an exception to it. A digit takes its row (the way back
				// included, as the last one).
				if (panel.phase === "safer" && c !== undefined && c >= "1" && c <= "9") {
					this.#saferConfirm(Number(c) - 1);
					i += 1;
					continue;
				}
				// while the ask is in flight the panel owns every printable key
				// and answers to none of them — esc (above) is the only gesture
				// with a meaning, and a stray letter must not reach the composer.
				if (panel.phase === "asking" && c !== undefined && c >= " " && c !== "\x7f") {
					i += 1;
					continue;
				}
				// TUI2-R3v2 ① — the digit CONFIRMS, and it confirms on the
				// keypress.
				//
				// The retired model made a digit a selection and Enter the
				// commit, which meant the fastest path through an approval was
				// two keys and the hint line had to teach both. The list makes
				// the digit redundant as a selector — the bar is already showing
				// what is selected — so the digit becomes what a human pressing
				// a number on a numbered list means by it: THAT one.
				//
				// A digit past the list is INERT (the R2 pick panel's rule,
				// inherited whole): an option nobody has is never taken, and a
				// mistyped 7 must not fall through to the composer underneath.
				//
				// The guard is the options phase and nothing else. The typed
				// phase is prose — that is the R2 slice-⑧ finding, and it is
				// why this branch sits below the enter/esc/tab handlers and
				// above nothing at all: "yes, run 13 of them" keeps its digits.
				if (panel.phase === "options" && panel.ask === null && panel.pick === null && c !== undefined && c >= "1" && c <= "9") {
					this.#panelConfirm(Number(c) - 1);
					i += 1;
					continue;
				}
				// TUI2-R2 ⑧, carried forward — the shortcut keys belong to the
				// OPTIONS phase and to it alone.
				//
				// `y`/`n` used to be applied in every phase of every flavour:
				// the `i += 1; continue;` sat OUTSIDE the phase check, so a
				// phase where the key meant nothing swallowed it anyway — and a
				// phase where a letter means nothing is exactly a phase where a
				// human is typing prose. Every y and n vanished from the line,
				// silently. "yes, run it now" committed as "es, ru it ow".
				//
				// The guard survives the migration unchanged in spirit and
				// simpler in fact: there is now ONE typed phase instead of
				// three, and the letters reach only the list.
				//
				// The letters stay because they are the two answers this panel
				// has always taken and a decade of muscle memory types them.
				// They are ALIASES for rows, not a second model: `y` is the
				// first option, `n` is the last, and on an approval the last
				// option opens the composer — so the old "n then enter" still
				// lands the same bare denial it always did.
				const optionsPhase =
					panel.pick === null && // a pick has no yes and no no
					panel.phase === "options" && // the amend line is prose
					(panel.ask === null || panel.ask.phase === "options"); // and so is a typed ask answer
				if (optionsPhase && panel.ask === null) {
					if (c === "y" || c === "Y") {
						this.#panelConfirm(0);
						i += 1;
						continue;
					}
					if (c === "n" || c === "N") {
						this.#panelConfirm(panelOptions(panel.view).length - 1);
						i += 1;
						continue;
					}
				}
			}
			if (c === "\x1b") {
				const rest = text.slice(i + 1);
				if (rest.startsWith("[")) {
					// TUI2-R3v2 ②: `<` joins the parameter class.
					//
					// An SGR 1006 mouse report is `\x1b[<0;COL;ROWM`, and the
					// retired character class ([0-9;?]) did not contain `<`. The
					// match failed, the branch below PARKED the whole thing as an
					// incomplete CSI, and #pending grew forever: every keystroke
					// after the first click was appended to a sequence that could
					// never complete. The editor went deaf. It never happened
					// because nothing ever enabled reporting — which is exactly
					// the kind of latent break turning a feature on discovers.
					const m = rest.match(/^\[([0-9;?<]*)([A-Za-z~])/);
					if (m === null) {
						this.#pending = text.slice(i); // incomplete CSI — wait for more
						break;
					}
					this.#csi(m[1]!, m[2]!);
					i += m[0]!.length + 1;
				} else if (rest.startsWith("]")) {
					// DC-7: an OSC is a message FROM the terminal — a background
					// colour answer, a theme-change notice, a clipboard report.
					// There was no branch for it, so the bytes fell through to
					// the literal-text path and the answer was typed into the
					// draft. The terminator is BEL **or** ST: Apple Terminal
					// answers `ESC ] 11 ; rgb:… BEL`, and ST is the standard.
					const end = /\x07|\x1b\\/.exec(rest);
					if (end === null) {
						const tail = text.slice(i);
						// The unterminated case is the SGR-1006 hazard by another
						// door: park it and a stream that never terminates grows
						// #pending forever until the editor goes deaf. A report
						// long enough to be a payload (OSC 52 carries a whole
						// clipboard) is not one we read, so past the cap it is
						// dropped rather than held.
						if (tail.length > OSC_MAX) {
							i = text.length;
							break;
						}
						this.#pending = tail; // incomplete OSC — wait for more
						break;
					}
					this.#oscCb?.(rest.slice(1, end.index));
					i += 1 + end.index + end[0]!.length;
				} else if (rest.startsWith("O")) {
					i += 3; // SS3 (function keys) — ignored
				} else if (rest.startsWith("\x0d") && this.#composerIdle()) {
					// KC2 §2 — Alt+Enter. A terminal sends Alt+X as ESC and X in
					// ONE write, so SAME-CHUNK is the whole test: no timer, no
					// hold, nothing parked. The identical two bytes arriving in
					// SEPARATE chunks are NOT combined — they fall to the branch
					// below, where the bare Esc fires at once (its immediacy is
					// exactly what a hold would spend) and the next chunk's CR
					// submits: today's two gestures, untouched.
					this.#redirect();
					i += 2; // both bytes belong to the one gesture
				} else if (this.#menuOpen) {
					// v3 §04: Esc closes the menu and clears the buffer.
					// CA-4: the closing esc consumes its burst (the `i += 1`
					// convention) — a double-esc can never abort the turn.
					if (this.#chars.length > 0) this.#checkpoint(); // UD-1
					this.#chars = [];
					this.#cursor = 0;
					this.#scroll = 0;
					this.#verticalGoalCol = null;
					this.#refreshMenu();
					i += 1;
				} else if (this.#pickUp()) {
					// TUI2-R2 ②: esc leaves the picker with nothing picked.
					// The caller reads null and exits 0 — declining to resume
					// is a normal thing to do, not a failure, so it must not
					// fall through to the escapeCbs (which mean "abort the
					// run" and there is no run yet).
					this.#pickClose(null);
					i += 1;
				} else if (this.#atUp()) {
					// KC3 §3: esc closes the picker and leaves the BUFFER
					// ALONE — unlike the menu's esc, which clears it. The
					// sentence around the reference is still being written,
					// and a dismissed picker must not take it away. CA-4:
					// the closing esc consumes its burst, so it can never
					// also abort the run.
					this.#atClose();
					this.#onRender();
					i += 1;
				} else if (this.#queuePopMode) {
					// W22: esc in the pop-mode — ONE more pop, then the
					// mode ends: the next esc at rest rides the escapeCbs
					// (the interrupt chain survives the walk).
					this.#queuePopMode = false;
					this.#queuePopIntoBuffer();
					i += 1;
				} else if (this.#historyIdx !== null) {
					// A2: Esc exits the history browse — the pre-browse
					// (empty) input returns. CA-4: the exiting esc consumes
					// its burst — a double-esc can never abort the turn.
					this.#historyIdx = null;
					this.#chars = [...this.#preBrowse];
					this.#cursor = this.#chars.length;
					this.#reflow();
					this.#onRender();
					i += 1;
				} else {
					for (const cb of [...this.#escapeCbs]) cb();
					i += 1;
				}
			} else if (c === "\x0d" || c === "\x0a") {
				// KC1 §3 — the ONE newline normalizer. Inside a paste every
				// boundary (LF, CR, CRLF) becomes EXACTLY one 0x0A; a paste's
				// trailing CR at a CHUNK boundary parks in #pending (the
				// existing CSI-resume mechanism) and resolves against the next
				// chunk's leading LF, so a CR|LF pair split by the stdin read
				// is still ONE newline. Outside a paste: Ctrl+J (LF) inserts,
				// Enter (CR) submits — and a typed CRLF pair submits ONCE (the
				// LF is consumed with it, never landing in the fresh buffer).
				// A lone interactive CR never parks: the submit is immediate.
				if (c === "\x0d" && i + 1 === text.length && this.#pasting) {
					this.#pending = text.slice(i);
					break;
				}
				const consumed = c === "\x0d" && text[i + 1] === "\x0a" ? 2 : 1;
				if (this.#pasting || c === "\x0a") {
					this.#insert(NEWLINE);
				} else {
					this.#submit();
				}
				i += consumed;
			} else if (c === "\x7f" || c === "\x08") {
				this.#backspace();
				i += 1;
			} else if (c === "\x03") {
				this.#sigintCb?.();
				i += 1;
			} else if (c === "\x04") {
				this.#eotCb?.();
				i += 1;
			} else if (c === "\x15") {
				this.#killToStart();
				i += 1;
			} else if (c === "\x0b") {
				this.#killToEnd();
				i += 1;
			} else if (c === "\x17") {
				this.#killWord();
				i += 1;
			} else if (c === "\x1a" || c === "\x1f") {
				this.#undoOp(); // UD-1: ctrl+z (and the readline ctrl+_)
				i += 1;
			} else if (c === "\x19") {
				this.#redoOp(); // UD-1: ctrl+y
				i += 1;
			} else if (c === "\x01") {
				this.#cursor = this.#cursorBounds().start; // A3: line-local (a single line starts at 0 — unchanged)
				this.#reflow();
				this.#onRender();
				i += 1;
			} else if (c === "\x05") {
				this.#cursor = this.#cursorBounds().end; // A3: line-local (a single line ends at the buffer's end)
				this.#reflow();
				this.#onRender();
				i += 1;
			} else if (c === "\t" && this.#menuOpen) {
				// v3 §04: Tab completes the buffer to the selected command.
				const f = this.#menuFiltered();
				const m = f[this.#menuSel];
				if (m !== undefined) {
					this.#chars = [...m.name].map((ch) => ch.codePointAt(0)!);
					this.#cursor = this.#chars.length;
					this.#reflow();
					this.#refreshMenu();
				}
				i += 1;
			} else if (c === "\t" && this.#atUp()) {
				// KC3 §3: Tab accepts the selected path — the token becomes
				// `@<path> `. Never the file's content.
				this.#atAccept();
				i += 1;
			} else if (c === "\x16") {
				// REL-0152-D15: ctrl+V asks for the clipboard. Inert with no
				// hook wired, and 0x16 must NEVER reach the buffer — an
				// unhandled control byte in a prompt is a corrupt prompt.
				const file = this.#onClipboardPaste?.() ?? null;
				if (file !== null && file !== "") {
					// REL-0152-D16: the capsule goes in the buffer, the file
					// goes beside it. See #attachments.
					this.#attachSeq += 1;
					this.#attachments.set(this.#attachSeq, file);
					for (const ch of `[Image #${this.#attachSeq}]`) this.#insert(ch.codePointAt(0)!);
					this.#onRender();
				}
				i += 1;
			} else if (c === "\x12") {
				// W15: the expand key (ctrl+r) — rides the chain like a
				// command, the editor just forwards it.
				for (const cb of [...this.#expandCbs]) cb();
				i += 1;
			} else if (c === "?" && this.#composerIdle() && this.#chars.length === 0) {
				// TUI2-R1 (D): `?` opens the keys sheet — but ONLY on an
				// empty composer with nobody else holding the keys. Mid-text
				// it is the question mark a human is typing, and #composerIdle
				// already encodes "no panel, no menu, no picker, no browse".
				// The precedence can only ever ADD: every state that used to
				// insert a `?` still inserts one.
				this.#sheetOpen = true;
				this.#onRender();
				i += 1;
			} else if (c !== undefined && c < " ") {
				i += 1; // other control — ignored
			} else {
				this.#insert(text.codePointAt(i)!);
				i += c!.length;
			}
		}
	}

	/**
	 * TUI2-R3v2 ② — one gesture, and only one: a plain LEFT PRESS on an
	 * option row is that row's digit.
	 *
	 * Everything else is dropped, and the list of everything else is the
	 * point. A release (`m`) is not a second click. Button 64/65 is the
	 * wheel — scrolling past a panel must not answer it. Bit 32 is a
	 * motion report, so a drag over the list is a drag, not four
	 * approvals. Buttons 1 and 2 are middle and right, which mean paste
	 * and context-menu everywhere else and would mean "approve" here.
	 * The stakes are a side effect the human did not ask for, and an
	 * ambiguous mouse event is not consent.
	 */
	#mouseEvent(params: string, press: boolean): void {
		if (!press) return; // the press already decided; the release is noise
		const [button, , row] = params.slice(1).split(";").map(Number);
		if (button !== 0) return; // wheel (64/65), motion (32+), middle/right
		// TUI2-R3v2 ③: a click works on BOTH lists — one interaction model
		// means the safer alternatives are clickable for the same reason the
		// original choices are.
		if (this.#panel === null || (this.#panel.phase !== "options" && this.#panel.phase !== "safer")) return;
		const span = this.#panelRows?.();
		if (span == null || row === undefined || !Number.isFinite(row)) return;
		const offset = row - span.top;
		if (offset < 0 || offset >= span.count) return; // outside the list — inert
		if (this.#panel.phase === "safer") this.#saferConfirm(offset);
		else this.#panelConfirm((span.first ?? 0) + offset);
	}

	/** TUI2-R3v2 ②: the compositor reports where it PUT the option rows.
	 *  The editor does no row arithmetic of its own — the surface that
	 *  placed them is the only thing that can say where they are, and a
	 *  second copy of that sum is how a hit-test comes to disagree with
	 *  the picture. */
	bindPanelRows(fn: (() => { top: number; count: number; first?: number } | null) | null): void {
		this.#panelRows = fn;
	}

	#csi(params: string, final: string): void {
		// TUI2-R3v2 ②: an SGR 1006 report — `\x1b[<b;col;rowM` (press) or
		// `...m` (release). It is routed FIRST because a `<` parameter is
		// never anything else, and because a mouse byte must never fall
		// through to a key handler.
		if (params.startsWith("<")) {
			this.#mouseEvent(params, final === "M");
			return;
		}
		// R3a — Shift+Tab (CSI Z, the universal back-tab encoding) cycles
		// the approval tier. Composer-idle ONLY: a panel, picker, menu,
		// history browse or question owns its keys first (the W21 gate),
		// and a mid-word back-tab has no meaning the composer would miss.
		if (final === "Z" && params === "" && this.#composerIdle()) {
			this.#onModeCycle?.();
			return;
		}
		// KC1 §4 — Shift+Enter WHERE THE TERMINAL ENCODES IT: kitty's
		// CSI-u (ESC [ 13;2 u) and xterm's modifyOtherKeys (ESC [ 27;2;13 ~).
		// Never claimed universal — Ctrl+J is the everywhere baseline; a
		// terminal that sends neither simply never reaches this row. The
		// chunk-split safety is the existing #pending CSI resume.
		if ((final === "u" && params === "13;2") || (final === "~" && params === "27;2;13")) {
			this.#insert(NEWLINE);
			return;
		}
		// KC2 §2 — Ctrl+Enter, the SAME two encodings with modifier 5
		// (1 + ctrl): kitty's CSI-u and xterm's modifyOtherKeys. Never
		// claimed universal — a terminal that encodes neither sends a plain
		// CR, which is an ordinary submit/queue (the safe degrade). The
		// chunk-split safety is the existing #pending CSI resume, shared
		// with Shift+Enter above. Outside the normal composer state the
		// sequence is simply unknown, exactly like any other stray CSI.
		if ((final === "u" && params === "13;5") || (final === "~" && params === "27;5;13")) {
			if (this.#composerIdle()) this.#redirect();
			return;
		}
		if (final === "~") {
			const n = Number(params);
			if (n === 3) this.#delete();
			else if (n === 200) {
				this.#pasting = true;
				this.#pasteAt = this.#cursor; // REL-0152-D8: where the capsule will go
				this.#pasteRun = []; // REL-0152-D9: collect, do not insert
			} else if (n === 201) {
				this.#pasting = false;
				this.#commitPaste();
				this.#onRender();
			}
		} else if (final === "A" || final === "B") {
			// v3 §04: the menu owns ↑↓ while open (the selection, never the
			// cursor). A2 (the feel): otherwise ↑↓ navigate the session history
			// — ONLY from an empty input or while already browsing; mid-edit
			// the cursor semantics are unchanged (↑↓ do nothing). W21: the
			// panel owns the keys while up (↑↓ do nothing — the panel has no
			// ↑↓ role).
			if (this.#panel !== null) {
				// W21: the panel owns the keys. KC3.5: an ask uses ↑↓ for
				// the option cursor (the approval panel still has no ↑↓ role).
				if (this.#panel.pick !== null && this.#panel.pick.phase === "options") {
					// TUI2-R2 ④: ↑↓ walk the pick's cursor — the same list the
					// digits address, the other muscle.
					const n = Math.min(this.#panel.view.pick!.options.length, PICK_MAX);
					const cur = this.#panel.pick.cursor;
					this.#panel.pick = { cursor: final === "A" ? Math.max(0, cur - 1) : Math.min(Math.max(0, n - 1), cur + 1), phase: "options" };
				} else if (this.#panel.ask !== null && this.#panel.ask.phase === "options") this.#askStep(final === "A" ? "up" : "down");
				// TUI2-R3v2 ①: the approval/simple panel joins them. It was the
				// one panel flavour with no ↑↓ role, because it had no cursor to
				// move; it has one now, and the gesture is the same one the
				// pick, the ask, the session picker and the @ picker already
				// answer to. ONE interaction model is the round's acceptance
				// criterion, and this branch is where it stops being four.
				else if (this.#panel.phase === "safer") this.#saferMove(final === "A" ? -1 : 1);
				else if (this.#panel.phase !== "asking") this.#panelMove(final === "A" ? -1 : 1);
			} else if (this.#pickUp()) {
				// TUI2-R2 ②: the session picker owns ↑↓ while up — the
				// SELECTION, never the composer's line walk and never the
				// history browse. It sits above both because the picker is
				// modal: there is no turn to recall and no second line to
				// walk to while it is open.
				const view = this.#pickView()!;
				this.#pickSel = final === "A" ? Math.max(0, view.selected - 1) : Math.min(Math.max(0, view.matches.length - 1), view.selected + 1);
			} else if (this.#menuOpen) {
				if (final === "A") this.#menuSel = Math.max(0, this.#menuSel - 1);
				else this.#menuSel = Math.min(this.#menuFiltered().length - 1, this.#menuSel + 1);
			} else if (this.#atUp()) {
				// KC3 §3: the picker owns ↑↓ while up — the SELECTION, never
				// the cursor and never the composer's line walk. It sits
				// ABOVE the multi-line branch on purpose: a picker opened on
				// line 2 of a composer must still select.
				const view = this.#atView()!;
				this.#atSel = final === "A" ? Math.max(0, view.selected - 1) : Math.min(view.matches.length - 1, view.selected + 1);
			} else if (this.#chars.includes(NEWLINE)) {
				// KC1 §4: a MULTI-LINE buffer's ↑↓ walk its lines. The
				// history and the queue-pop below stay gated on an EMPTY
				// buffer — a multi-line buffer is never empty, so the
				// precedence can only ever add, never take.
				this.#verticalMove(final === "A" ? -1 : 1);
			} else if (final === "A" && this.#queuePop !== null && (this.#queuePopMode || this.line() === "") && this.#queueState().length > 0) {
				// W22: ↑ pops the LAST queued message into the buffer — the
				// walk: repeated presses pop older ones (each replaces the
				// line, the cursor at the end); esc ends the mode after one
				// more pop. Mid-edit the pop never fires (the A2
				// non-destructive feel, mirroring the history browse).
				this.#queuePopMode = true;
				this.#queuePopIntoBuffer();
			} else if (this.#historyIdx !== null || this.line() === "") {
				this.#historyMove(final === "A" ? -1 : 1);
			}
			this.#onRender();
		} else if (final === "D") {
			// KC3.5: ← walks the ask BACK a question (the ‹ n/m › walk); at
			// question one it stays put — esc is the decline, never ←.
			if (this.#panel?.ask != null && this.#panel.ask.phase === "options") this.#askStep("left");
			else this.#move(-1);
		} else if (final === "C") {
			this.#move(1);
		} else if (final === "H") {
			this.#cursor = this.#cursorBounds().start; // A3: Home follows Ctrl+A — line-local
			this.#reflow();
		} else if (final === "F") {
			this.#cursor = this.#cursorBounds().end; // A3: End follows Ctrl+E — line-local
			this.#reflow();
		}
	}

	/** KC1 §4 — the ↑/↓ walk. The cursor keeps its DESIRED column across
	 *  a short line: the goal is captured at the FIRST vertical move and
	 *  survives consecutive ones (#reflow clears it, so any horizontal
	 *  move / insert / delete ends the walk); a step past either end
	 *  stays put. */
	#verticalMove(delta: number): void {
		const bounds = this.#lineBounds();
		const cur = this.#cursorLine(bounds);
		const next = cur + delta;
		if (next < 0 || next >= bounds.length) return;
		const from = bounds[cur]!;
		const goal = this.#verticalGoalCol ?? widthOf(this.#chars.slice(from.start, this.#cursor));
		const to = bounds[next]!;
		this.#cursor = this.#indexAtWidth(to.start, to.end, goal);
		this.#reflow();
		this.#verticalGoalCol = goal; // the walk re-arms it (the reflow's reset is for every OTHER key)
	}

	// ---- W21 / TUI2-R3v2 ①: the panel state machine ----

	/** ↑↓ — the bar walks the list and STOPS at both ends. A list that
	 *  wraps makes the fastest gesture (hold ↓ to reach the bottom) into
	 *  a gamble about where you landed, and the bottom option here is the
	 *  denial. */
	#panelMove(delta: -1 | 1): void {
		const panel = this.#panel;
		if (panel === null || panel.phase !== "options") return;
		const n = panelOptions(panel.view).length;
		panel.cursor = Math.max(0, Math.min(n - 1, panel.cursor + delta));
		this.#onRender();
	}

	/**
	 * Take the option at `index` — the ONE place a panel choice resolves,
	 * whether the human pressed a digit, pressed ⏎ on the bar, typed the
	 * y/n alias, or clicked the row (slice ②). Four gestures, one branch:
	 * a click cannot mean something a digit does not.
	 *
	 * Every kind but `deny` on an approval resolves IMMEDIATELY. That is
	 * the round's whole claim — the durable rule included, because the
	 * rule the machinery supports is exactly "this tool", and asking the
	 * human to confirm a value they cannot change was the old model's
	 * ceremony, not a safeguard.
	 */
	#panelConfirm(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.phase !== "options") return;
		const options = panelOptions(panel.view);
		const option = options[index];
		if (option === undefined) return; // a digit past the list is inert
		panel.cursor = index;
		switch (option.kind) {
			case "allow":
				this.#panelClose({ action: "allow", reason: "" });
				return;
			case "rule":
				this.#panelClose({ action: "allow-rule", rule: panel.view.name });
				return;
			case "safer":
				this.#panelSafer();
				return;
			case "deny":
				// the approval flavor's denial is "let me tell it what to do
				// instead", so it opens the composer; the simple flavors have
				// nothing to tell anyone and resolve on the spot.
				if (panel.view.flavor === "approval") this.#panelAmend();
				else this.#panelClose({ action: "deny", reason: "" });
				return;
		}
	}

	/**
	 * Option 3 — "show me safer ways to do this".
	 *
	 * The round's ONE new model request, and every branch here exists to
	 * keep it honest.
	 *
	 * It fires ONLY from this method, which only this option reaches —
	 * that is the entire mechanism behind the zero-ambient-rent claim,
	 * and it is why the claim is checkable rather than asserted: a
	 * session that never presses 3 never enters this branch, and the
	 * trace shows no side-query line.
	 *
	 * The in-flight phase is VISIBLE because this is a network call: a
	 * button that goes quiet for two seconds reads as broken, and the
	 * human is standing in front of a paused run.
	 *
	 * Every failure — a throw, a null, an empty list, no provider bound
	 * at all — lands on the SAME honest branch and puts back every
	 * original choice. There is deliberately no retry and no partial
	 * state: the alternative to "I could not get them" is either a lie or
	 * a spinner that never ends, and both are worse than the sentence.
	 *
	 * R3v2-F1: one of those failures can now name its cause, and the
	 * sentence says it. That is a widening of the COPY, not of the
	 * branch — there is still exactly one failure path, it still restores
	 * every original choice, and a provider that has nothing to add still
	 * resolves `null` and still gets the line it always got. A cause is
	 * only ever spoken when the caller could prove it; a diagnosis the
	 * product cannot prove would be worse than the unqualified line it
	 * replaced.
	 *
	 * The generation token is the guard against a late answer: a panel
	 * the human escaped (or that a SIGINT cancelled) must not be
	 * resurrected two seconds later by a promise nobody is waiting for.
	 */
	#panelSafer(): void {
		const panel = this.#panel;
		if (panel === null) return;
		const ask = panel.safer;
		panel.phase = "asking";
		panel.note = null;
		this.#onRender();
		const token = ++this.#saferToken;
		const settle = (answer: SaferAnswer): void => {
			// the panel that asked must still be the panel on screen
			if (this.#panel !== panel || token !== this.#saferToken) return;
			// R3v2-F1: a non-list answer is a failure, and it may name its
			// cause. Which sentence that earns is decided where the
			// sentences live; here we only route to the same one branch
			// every failure has always taken.
			const options = Array.isArray(answer) ? (answer as readonly SaferOption[]) : null;
			if (options === null || options.length === 0) {
				panel.phase = "options";
				panel.note = saferDegradedNote(answer);
				panel.cursor = 0;
				this.#onRender();
				return;
			}
			panel.phase = "safer";
			panel.saferRun = { options, cursor: 0 };
			this.#onRender();
		};
		if (ask === undefined) {
			settle(null); // no provider bound — the button says so rather than lying
			return;
		}
		void Promise.resolve()
			.then(ask)
			.then(settle)
			.catch(() => settle(null));
	}

	/** Take a row of the SAFER list. The alternatives route through the
	 *  EXISTING amend channel — choosing a safer command is a denial with
	 *  instructions, which is a verdict the product already has; the last
	 *  row is the way back and decides nothing. */
	#saferConfirm(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.saferRun === null) return;
		const { options } = panel.saferRun;
		if (index === options.length) {
			// "back to the original choices"
			panel.phase = "options";
			panel.saferRun = null;
			panel.cursor = 0;
			this.#onRender();
			return;
		}
		const chosen = options[index];
		if (chosen === undefined) return; // past the list — inert
		this.#panelClose({ action: "deny", reason: `run this instead: ${chosen.command}` });
	}

	/** ↑↓ inside the safer list — the way back is its last row, so the
	 *  bar reaches it like any other. */
	#saferMove(delta: -1 | 1): void {
		const panel = this.#panel;
		if (panel === null || panel.saferRun === null) return;
		const last = panel.saferRun.options.length; // + the way-back row
		panel.saferRun = { options: panel.saferRun.options, cursor: Math.max(0, Math.min(last, panel.saferRun.cursor + delta)) };
		this.#onRender();
	}

	/** The typed phase — the one place the panel takes prose. The buffer
	 *  starts empty and the cursor stays where the human left it, so esc
	 *  can put the bar back exactly where it was. */
	#panelAmend(): void {
		const panel = this.#panel;
		if (panel === null) return;
		panel.phase = "amend";
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	/** tab — the amend alias, unchanged as a GESTURE: it opens the same
	 *  typed phase the last option does, from anywhere in the list. The
	 *  simple flavors never had it and still do not. */
	#panelTab(): void {
		const panel = this.#panel;
		if (panel === null || panel.view.flavor !== "approval") return;
		panel.cursor = panelOptions(panel.view).length - 1;
		this.#panelAmend();
	}

	/** esc — back out of the typed phase to the list (the buffer clears,
	 *  the bar stays on the option that opened it), or cancel the panel.
	 *  The old model had a third step, the deselect, because a selection
	 *  could be "none"; a list always has a selection, so esc from the
	 *  list means what it means everywhere else in the product. */
	#panelEsc(): void {
		const panel = this.#panel;
		if (panel === null) return;
		// TUI2-R3v2 ③: esc out of the safer list — or out of the ask while
		// it is still in flight — returns to the original choices, exactly
		// as the way-back row does. The in-flight answer is orphaned by the
		// generation token; nothing it does can reopen this list.
		if (panel.phase === "safer" || panel.phase === "asking") {
			this.#saferToken += 1;
			panel.phase = "options";
			panel.saferRun = null;
			panel.cursor = 0;
			this.#onRender();
			return;
		}
		if (panel.phase !== "options") {
			panel.phase = "options";
			this.#chars = [];
			this.#cursor = 0;
			this.#scroll = 0;
			this.#verticalGoalCol = null;
			this.#onRender();
			return;
		}
		this.#panelClose({ action: "cancel" });
	}

	/**
	 * enter — send the typed note, or TAKE THE HIGHLIGHTED OPTION.
	 *
	 * The second half is the round. The retired model's enter-at-rest did
	 * nothing at all, on the theory that an accidental return must never
	 * approve; what it actually produced was a panel that ignored the key
	 * every human presses first. The safeguard is real but it belongs on
	 * WHERE THE BAR STARTS, not on whether the key works: the bar opens on
	 * the option whose blast radius is one tool call the human is looking
	 * at, and every irreversible-er choice is a deliberate ↑↓ away.
	 *
	 * An empty note in the typed phase is the bare denial — the W21
	 * mapping, untouched: no words means the run aborts, words mean the
	 * model gets them and proposes a new call.
	 */
	#panelEnter(): void {
		const panel = this.#panel;
		if (panel === null) return;
		if (panel.phase === "amend") {
			this.#panelClose({ action: "deny", reason: this.line() });
			return;
		}
		// TUI2-R3v2 ③: in the safer list, enter takes the highlighted
		// alternative — the same gesture, one surface over.
		if (panel.phase === "safer" && panel.saferRun !== null) {
			this.#saferConfirm(panel.saferRun.cursor);
			return;
		}
		if (panel.phase === "asking") return; // nothing to confirm yet
		this.#panelConfirm(panel.cursor);
	}

	/**
	 * KC3.5 — one ask key: the pure reducer decides, this method applies.
	 * The buffer is cleared on every phase change so the type-your-own
	 * line starts empty and its text never leaks back into the options
	 * (the rule-input phase's own discipline). A step that produced a
	 * RESULT closes the panel with it — the stash/restore is the W21
	 * path, identical for an answer and for a decline.
	 */
	#askStep(key: string): void {
		const panel = this.#panel;
		if (panel === null || panel.ask === null) return;
		const spec = panel.view.ask!;
		const before = panel.ask.phase;
		// REL-0152-D8: a typed ask answer is a line leaving the editor too —
		// pasting a stack trace into "type your own answer" must send the
		// stack trace, not the capsule that stands for it.
		const step = key === "commit" ? askCommitCustom(spec, panel.ask, this.#expandPastes(this.line())) : askKey(spec, panel.ask, key);
		panel.ask = step.state;
		if (step.state.phase !== before) {
			this.#chars = [];
			this.#cursor = 0;
			this.#scroll = 0;
		}
		if (step.result !== undefined) {
			this.#panelClose({ action: "answers", result: step.result });
			return;
		}
		this.#onRender();
	}

	/**
	 * TUI2-R2 ④ — the pick panel's three keys.
	 *
	 * A digit MOVES the cursor rather than committing. The list is short
	 * and the digits are adjacent on the keyboard; a picker that acted on
	 * the keypress would make a mistyped 3 a model switch, and the whole
	 * point of a confirm step is that the choice is visible before it is
	 * taken.
	 */
	#pickPanelDigit(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		// a digit past the list is INERT — an option nobody has is never
		// selected, and the cursor stays where the human left it
		if (index < 0 || index >= Math.min(panel.view.pick!.options.length, PICK_MAX)) return;
		panel.pick = { cursor: index, phase: "options" };
		this.#onRender();
	}

	/** enter — the typed line when there is one (an EMPTY line is not a
	 *  choice and commits nothing), else the option under the cursor. */
	#pickPanelEnter(): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		if (panel.pick.phase === "custom") {
			const line = this.line().trim();
			if (line === "") return;
			this.#panelClose({ action: "picked", result: { custom: line } });
			return;
		}
		if (panel.view.pick!.options.length === 0) return; // nothing to take
		this.#panelClose({ action: "picked", result: { index: panel.pick.cursor } });
	}

	/** esc — back out of the type-it line first, then cancel the panel.
	 *  Two escapes, two meanings, exactly as the approval panel's
	 *  rule/amend phases already work. */
	#pickPanelEsc(): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		if (panel.pick.phase === "custom") {
			panel.pick = { cursor: panel.pick.cursor, phase: "options" };
			this.#chars = [];
			this.#cursor = 0;
			this.#scroll = 0;
			this.#onRender();
			return;
		}
		this.#panelClose({ action: "cancel" });
	}

	#panelClose(verdict: PanelVerdict): void {
		const panel = this.#panel;
		if (panel === null) return;
		this.#panel = null;
		this.#syncMouse();
		// TUI2-R3v2 ①: swallow ONE bare enter after the panel goes away.
		//
		// This is the hazard the instant confirm creates and it is not
		// hypothetical: "y⏎" and "1⏎" are what a decade of y/n prompts
		// taught everyone's fingers, and the panel used to need both bytes.
		// It needs one now — so the second one lands in a composer that has
		// just had the user's PRE-PANEL DRAFT restored into it, and submits
		// it. Answering an approval would send a half-written message.
		//
		// The guard is one-shot and expires on any other key, so it can
		// never eat an enter the user meant: by the time they have typed
		// anything at all, it is gone.
		this.#swallowEnter = true;
		// the pre-panel buffer returns — the panel's amend text never leaks
		// into the user's next turn (commit AND cancel).
		this.#chars = [...panel.stash.chars];
		this.#cursor = panel.stash.cursor;
		this.#scroll = panel.stash.scroll;
		this.#onRender();
		panel.onCommit(verdict);
	}

	// ---- editing ----

	#insert(cp: number): void {
		// REL-0152-D9: inside a paste the character is COLLECTED, not
		// inserted — see #pasteRun. Every other caller (a typed key, a
		// ctrl+J newline) is outside a paste and lands below unchanged.
		if (this.#pasteRun !== null) {
			this.#pasteRun.push(cp);
			return;
		}
		if (this.#historyIdx !== null) this.#historyIdx = null; // editing leaves the browse
		this.#queuePopMode = false; // W22: editing leaves the pop-walk too
		this.#chars.splice(this.#cursor, 0, cp);
		this.#cursor += 1;
		this.#reflow();
		if (!this.#pasting) this.#refreshMenu();
		// KC3 §3: a TYPED `@` arms the picker; a PASTED one never does —
		// a paste is content, and content that happens to contain an
		// address must not open a file browser mid-sentence.
		if (cp === AT && !this.#pasting) this.#atArm();
	}

	#backspace(): void {
		if (this.#cursor === 0) return;
		if (this.#historyIdx !== null) this.#historyIdx = null; // editing leaves the browse
		this.#queuePopMode = false; // W22: editing leaves the pop-walk too
		this.#chars.splice(this.#cursor - 1, 1);
		this.#cursor -= 1;
		this.#reflow();
		if (!this.#pasting) this.#refreshMenu();
	}

	#delete(): void {
		if (this.#cursor >= this.#chars.length) return;
		this.#chars.splice(this.#cursor, 1);
		this.#reflow();
		if (!this.#pasting) this.#refreshMenu();
	}

	#move(delta: number): void {
		this.#cursor = Math.max(0, Math.min(this.#chars.length, this.#cursor + delta));
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

	// ---- UD-1: the undo machinery ----

	/** The caps: entries and total code points (a D13-class 260KB paste
	 *  fits with room). Evict oldest; both stacks share the shape. */
	static readonly #UNDO_CAP = 64;
	static readonly #UNDO_CP_CAP = 2 * 1024 * 1024;

	#snap(): { chars: readonly number[]; cursor: number } {
		return { chars: [...this.#chars], cursor: this.#cursor };
	}

	#sameSnap(a: { chars: readonly number[]; cursor: number }, b: { chars: readonly number[]; cursor: number }): boolean {
		return a.cursor === b.cursor && a.chars.length === b.chars.length && a.chars.every((c, i) => c === b.chars[i]);
	}

	#capStack(stack: { chars: readonly number[]; cursor: number }[]): void {
		while (stack.length > Editor.#UNDO_CAP) stack.shift();
		let total = stack.reduce((n, s) => n + s.chars.length, 0);
		while (stack.length > 1 && total > Editor.#UNDO_CP_CAP) total -= stack.shift()!.chars.length;
	}

	/** Push the CURRENT state before a destructive gesture. Always
	 *  clears the redo stack (a new destruction forks history); the
	 *  push itself is deduped against the top. */
	#checkpoint(): void {
		this.#redoStack.length = 0;
		const cur = this.#snap();
		const top = this.#undoStack.at(-1);
		if (top !== undefined && this.#sameSnap(top, cur)) return;
		this.#undoStack.push(cur);
		this.#capStack(this.#undoStack);
	}

	#restoreSnap(s: { chars: readonly number[]; cursor: number }): void {
		this.#chars = [...s.chars];
		this.#cursor = s.cursor;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#reflow();
		this.#refreshMenu();
		if (!this.#pasting) this.#onRender();
	}

	#undoOp(): void {
		const prev = this.#undoStack.pop();
		if (prev === undefined) return;
		this.#redoStack.push(this.#snap());
		this.#capStack(this.#redoStack);
		this.#restoreSnap(prev);
	}

	#redoOp(): void {
		const next = this.#redoStack.pop();
		if (next === undefined) return;
		this.#undoStack.push(this.#snap());
		this.#capStack(this.#undoStack);
		this.#restoreSnap(next);
	}

	#killToStart(): void {
		const { start } = this.#cursorBounds(); // A3: line-local (0 on a single line — unchanged)
		if (this.#cursor > start) this.#checkpoint(); // UD-1
		this.#chars.splice(start, this.#cursor - start);
		this.#cursor = start;
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

	#killToEnd(): void {
		const { end } = this.#cursorBounds(); // A3: line-local (the buffer's end on a single line — unchanged)
		if (end > this.#cursor) this.#checkpoint(); // UD-1
		this.#chars.splice(this.#cursor, end - this.#cursor);
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

	/** Ctrl+W — the word kill. The newline rides as a non-space code
	 *  point (a kill at a line's start joins it to the one above, the
	 *  readline behavior); A3 scopes A/E/U/K, not W. */
	#killWord(): void {
		let i = this.#cursor;
		while (i > 0 && this.#chars[i - 1] === 0x20) i -= 1; // trailing spaces
		while (i > 0 && this.#chars[i - 1] !== 0x20) i -= 1; // the word
		if (i < this.#cursor) this.#checkpoint(); // UD-1
		this.#chars.splice(i, this.#cursor - i);
		this.#cursor = i;
		this.#reflow();
	}

	/** KC1/KC2 — the buffer LEAVES: the flat chars, the cursor, the
	 *  horizontal scroll, the ↑/↓ goal, the menu and the pop-walk all
	 *  reset together (W22: a departing line ends the pop-walk, so the
	 *  next esc at rest interrupts again). Shared by the submit and the
	 *  redirect — the two doors a line can leave by. */
	/**
	 * REL-0152-D8 — how big a paste has to be before it is a capsule.
	 *
	 * LINES first, because lines are what actually break the layout: the
	 * composer grows a row per line and walks up the terminal. The
	 * character bound catches the pathological one-liner, which wraps to
	 * the same screenful by another route.
	 *
	 * Below both, the paste is left exactly as it arrived. A four-line
	 * snippet is something you want to SEE in the composer, and a capsule
	 * there would be pure obstruction.
	 */
	static #PASTE_LINES = 8;
	static #PASTE_CHARS = 900;

	/** The token a capsule shows as. Parsed back by the same regexp on
	 *  the way out — one definition, so the two can never drift. */
	static #capsuleText(id: number, lines: number): string {
		return `[Pasted text #${id} +${lines} line${lines === 1 ? "" : "s"}]`;
	}
	static #CAPSULE = /\[Pasted text #(\d+) \+\d+ lines?\]/g;

	/**
	 * Close an in-flight paste: if it was large, swap the pasted run out
	 * of the buffer for its capsule and keep the text.
	 *
	 * The swap is a splice at the recorded start, so a paste in the
	 * MIDDLE of a line leaves the prose on both sides of it untouched —
	 * the capsule is a character run like any other from here on, and
	 * every editing operation in this file works on it without knowing
	 * it exists.
	 */
	/** REL-0152-D9: code points to a string WITHOUT spreading the whole
	 *  array into one call. `String.fromCodePoint(...run)` throws
	 *  RangeError on a large paste — the argument list is the stack — and
	 *  a composer that crashes on a big paste is worse than one that is
	 *  slow. Chunked, it is linear and bounded. */
	static #textOf(run: readonly number[]): string {
		const CHUNK = 4096;
		let out = "";
		for (let i = 0; i < run.length; i += CHUNK) out += String.fromCodePoint(...run.slice(i, i + CHUNK));
		return out;
	}

	/**
	 * Close an in-flight paste: the collected run goes into the buffer in
	 * ONE splice — as itself when it is small, as its capsule when it is
	 * not (REL-0152-D8).
	 *
	 * The splice is at the recorded start, so a paste in the MIDDLE of a
	 * line leaves the prose on both sides untouched — what lands is a
	 * character run like any other from here on, and every editing
	 * operation in this file works on it without knowing it exists.
	 */
	#commitPaste(): void {
		let run = this.#pasteRun ?? [];
		const start = this.#pasteAt ?? this.#cursor;
		this.#pasteRun = null;
		this.#pasteAt = null;
		if (run.length === 0) {
			// REL-0152-D11: an empty paste is the image case — see
			// #onEmptyPaste. Anything it returns is ordinary text from here
			// on and takes the same route as if it had been typed.
			const file = this.#onClipboardPaste?.() ?? null;
			if (file === null || file === "") return;
			this.#attachSeq += 1;
			this.#attachments.set(this.#attachSeq, file);
			run = [...`[Image #${this.#attachSeq}]`].map((ch) => ch.codePointAt(0)!);
		}
		if (this.#historyIdx !== null) this.#historyIdx = null;
		this.#queuePopMode = false;
		const pasted = Editor.#textOf(run);
		const lines = pasted.split("\n").length;
		const small = lines < Editor.#PASTE_LINES && run.length < Editor.#PASTE_CHARS;
		let placed: number[];
		if (small) {
			placed = run;
		} else {
			this.#pasteSeq += 1;
			this.#pastes.set(this.#pasteSeq, pasted);
			placed = [...Editor.#capsuleText(this.#pasteSeq, lines)].map((ch) => ch.codePointAt(0)!);
		}
		this.#chars.splice(start, 0, ...placed);
		this.#cursor = start + placed.length;
		this.#reflow();
		this.#refreshMenu();
	}

	/**
	 * The way out: every capsule token becomes its text again.
	 *
	 * Applied to the line the editor HANDS OVER, never to the buffer —
	 * so what the human sees stays short and what the model receives is
	 * what the human pasted. A token whose entry is missing (a stale id
	 * recalled from history after the map moved on) is left standing as
	 * literal text rather than silently becoming an empty string: a
	 * visible oddity beats a silent deletion of someone's paste.
	 */
	#expandPastes(line: string): string {
		if (this.#pastes.size === 0) return line;
		return line.replace(Editor.#CAPSULE, (whole, id: string) => this.#pastes.get(Number(id)) ?? whole);
	}

	#takeLine(): string {
		const line = String.fromCodePoint(...this.#chars);
		this.#undoStack.length = 0; // UD-1: a sent turn is not a loss
		this.#redoStack.length = 0;
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#menuOpen = false;
		this.#menuSel = 0;
		this.#queuePopMode = false;
		this.#atClose(); // KC3 §3: a departing line takes its picker with it
		return line;
	}

	/** A2: the history remembers submitted TURN lines — never question
	 *  answers, never empties; adjacent duplicates collapse, the tail
	 *  caps at 100. A redirect is a turn, so it is remembered too. */
	#remember(line: string): void {
		if (this.#history[this.#history.length - 1] !== line) {
			this.#history.push(line);
			// R3a: the persistence seam — the CLI owns the file (the tui
			// stays I/O-free); adjacent-duplicate collapse already applied
			this.#persistHistory?.(line);
		}
		if (this.#history.length > 100) this.#history.shift();
	}

	#persistHistory: ((line: string) => void) | null = null;

	/** R3a — cross-session input history: seed the recall buffer and
	 *  register the append sink. The cap and the adjacent-duplicate
	 *  collapse are unchanged; the seed takes the TAIL of what the CLI
	 *  loaded. Never persists question answers (#remember's callers
	 *  already exclude them). */
	bindHistory(seed: readonly string[], persist: (line: string) => void): void {
		this.#history = seed.slice(-100).filter((l) => l !== "");
		this.#persistHistory = persist;
	}

	/** KC2 §2 — the NORMAL composer state: the redirect gesture is live
	 *  ONLY here. The approval panel, the slash menu, the history browse
	 *  and the queue-pop walk each OWN their keys first (the W21 "the
	 *  panel owns the keys" design, restated as a gate); a pending
	 *  question is the panel's dock-less twin (askPanel routes to
	 *  question() when the dock cannot render, so the ask owns the keys
	 *  there too); and a bracketed paste is literal TEXT, where an ESC CR
	 *  is the pasted content's own bytes and never a keypress. In every
	 *  one of those states the two bytes fall through to today's
	 *  handling — two gestures, unchanged. */
	#composerIdle(): boolean {
		return (
			this.#panel === null &&
			!this.#menuOpen &&
			!this.#atUp() && // KC3 §3: the @ picker owns the keys while up, exactly like the menu
			!this.#pickUp() && // TUI2-R2 ②: and so does the session picker — `?` is a query character there
			this.#historyIdx === null &&
			!this.#queuePopMode &&
			!this.#pasting &&
			this.#questionCb === null
		);
	}

	/**
	 * KC2 §2 — the gesture's meaning, kept as small as it can honestly be.
	 *
	 * An EMPTY buffer carries no correction, so the gesture degenerates to
	 * the bare Esc: the abort alone, nothing submitted. With text, the
	 * line leaves exactly as a submit's does and the listeners decide (the
	 * CLI aborts a live run and front-jumps the correction; idle, it is
	 * simply an Enter). UNWIRED — the recovery flow never binds it — the
	 * gesture IS a submit: a line is never lost to a missing binding.
	 */
	#redirect(): void {
		if (this.#chars.length === 0) {
			for (const cb of [...this.#escapeCbs]) cb();
			return;
		}
		if (this.#redirectCbs.length === 0) {
			this.#submit();
			return;
		}
		const line = this.#takeLine();
		this.#remember(line);
		for (const cb of [...this.#redirectCbs]) cb(line);
		this.#onRender();
	}

	#submit(): void {
		// TUI2-R2 ②: the session picker takes Enter before anything else —
		// while it is up there is no turn to submit and no line to send.
		if (this.#pickUp()) {
			this.#pickAccept();
			return;
		}
		// KC3 §3: Enter ACCEPTS while the picker is up — the same rule the
		// menu's A1 feel established (complete first, let the user read
		// what they got, and let the NEXT Enter send it). An @ reference
		// that submitted on the first Enter would send the fragment.
		if (this.#atUp()) {
			this.#atAccept();
			return;
		}
		if (this.#menuOpen) {
			// A1 (the feel): Enter submits the EXACT selection directly; a
			// PARTIAL selection COMPLETES the buffer (the Tab semantics)
			// without submitting — the user reviews and presses Enter
			// again. The old behavior executed the completed command on
			// the first Enter, before the user had seen the completion.
			const m = this.#menuFiltered()[this.#menuSel];
			if (m !== undefined && m.name !== this.line()) {
				this.#chars = [...m.name].map((ch) => ch.codePointAt(0)!);
				this.#cursor = this.#chars.length;
				this.#reflow();
				this.#refreshMenu();
				this.#onRender();
				return; // completed, not executed
			}
		}
		const line = this.#takeLine();
		// REL-0152-D8: the capsule expands ON THE WAY OUT. The consumer
		// gets what was pasted; the HISTORY keeps the short form, so ↑
		// recalls a readable line that still expands when it is sent
		// again (the map outlives the buffer, by design).
		const sent = this.#expandPastes(line);
		const cb = this.#questionCb;
		this.#questionCb = null;
		if (cb !== null) {
			cb(sent);
		} else if (this.#lineCb !== null) {
			this.#lineCb(sent);
		} else {
			this.#pendingLines.push(sent); // nobody wired yet — hold it
		}
		if (cb === null && line !== "") this.#remember(line);
		this.#onRender();
	}

	/** A2: step the history browse; a delta past the newest exits back to
	 *  the pre-browse input. */
	#historyMove(delta: number): void {
		if (this.#history.length === 0) return;
		if (this.#historyIdx === null) {
			this.#preBrowse = this.#chars; // entering from an empty input
			this.#historyIdx = this.#history.length - 1;
		} else {
			const next = this.#historyIdx + delta;
			if (next < 0) return; // the oldest entry — stay
			this.#historyIdx = next;
			if (next >= this.#history.length) {
				this.#historyIdx = null; // past the newest — exit the browse
				this.#chars = [...this.#preBrowse];
				this.#cursor = this.#chars.length;
				this.#reflow();
				return;
			}
		}
		this.#chars = [...this.#history[this.#historyIdx]!].map((ch) => ch.codePointAt(0)!);
		this.#cursor = this.#chars.length;
		this.#reflow();
	}

	/** W22: pop the LAST queued message into the buffer (the walk's
	 *  step — ↑ enters/stays in the pop-mode, esc's pop ends it). The
	 *  chip leaves the queue (cancelled in the CLI), the line becomes
	 *  the popped text, the cursor sits at the end. */
	#queuePopIntoBuffer(): void {
		if (this.#queuePop === null) return;
		const line = this.#queuePop();
		if (line === null) return;
		if (this.#chars.length > 0) this.#checkpoint(); // UD-1: a mid-walk edit is recoverable
		this.#chars = [...line].map((ch) => ch.codePointAt(0)!);
		this.#cursor = this.#chars.length;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	// ---- width-based horizontal scroll ----

	#reflow(): void {
		// KC1: any key that reaches the reflow ended a ↑/↓ walk (the walk
		// itself re-arms the goal right after its own reflow call).
		this.#verticalGoalCol = null;
		const W = (process.stdout.columns ?? 0) || 80; // degenerate 0 falls back to 80
		// W21: the panel's phase lead owns the input row while up — the
		// line's max width follows the lead (the rule/amend leads are
		// wider than the brick).
		// W23: the ONE width authority — leadWidth(lead) — the cap follows
		// the lead the editor itself renders (the panel lead when the panel
		// owns the keys, the brick otherwise): maxW = W − walls − lead.
		const lead = this.#panel !== null ? panelLead(this.#panel.view, this.#panel.phase, this.#panel.cursor, this.#panel.ask ?? undefined) : PROMPT;
		const leadW = leadWidth(lead);
		const maxW = Math.max(1, W - leadW - 4); // W6: the box's walls (2+2) — the visible line fits the box's inner width; the "…" rides inside
		// KC1: the scroll is the CURSOR LINE's own offset — a single-line
		// buffer's line starts at 0, so the math is today's exactly. The
		// clamp catches a walk onto a line SHORTER than the old offset.
		const { start, end } = this.#cursorBounds();
		this.#scroll = Math.min(this.#scroll, end - start);
		const curCol = widthOf(this.#chars.slice(start, this.#cursor));
		const scrolledW = widthOf(this.#chars.slice(start, start + this.#scroll));
		if (curCol < scrolledW) {
			this.#scroll = this.#indexAtWidth(start, end, curCol) - start;
		} else if (curCol >= scrolledW + maxW) {
			this.#scroll = this.#indexAtWidth(start, end, Math.max(0, curCol - maxW + 1)) - start;
		}
	}

	/** The first index in [start, end] whose display width from `start`
	 *  reaches `target` — the width-based column walk (a wide char never
	 *  splits: the index lands BEFORE it). */
	#indexAtWidth(start: number, end: number, target: number): number {
		let w = 0;
		for (let i = start; i < end; i += 1) {
			if (w >= target) return i;
			w += charWidth(this.#chars[i]!);
		}
		return end;
	}
}
