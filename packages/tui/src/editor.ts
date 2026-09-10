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

import { breakable, charWidth, displayWidth, leadWidth, widthOf } from "./width.js";
// the width primitives moved to width.ts (W1, the single width
// authority) — re-exported so the editor's public surface is unchanged.
export { charWidth, displayWidth, widthOf };
import { palette } from "./lines.js";
import { type PanelState, type PanelVerdict, type PanelView, type SaferAnswer } from "./approval-panel.js";
// KC3.5: the panel-slot dispatchers — the ask branch folded into the
// W21 lead/rows, so this file keeps ONE panel and one key owner.
import { panelLead } from "./ask-panel.js";
import { AT_VISIBLE, atFilter, type AtItem, type AtMatch } from "./at-picker.js";
// TUI2-R2 ②: the session picker — the band's THIRD occupant. Its filter
// is the @ picker's rank aimed at the session id; the editor owns the
// keys, the compositor draws the rows.
import { type SessionCardView, type SessionPickState } from "./session-picker.js";
// S5 (C10): the two bands with state machines of their own — the
// approval/ask/pick panel and the session picker — are controllers.
// The editor parses bytes and lends them the composer through
// #bandHost; they answer keys.
import { PanelInput, type BandHost, type BandKey } from "./panel-input.js";
import { PickInput } from "./pick-input.js";

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
/**
 * R5 — the viewer's key table, as a pure function of the input chunk.
 *
 * Pure so it can be gated without a terminal. Anything not in the table
 * returns null and is SWALLOWED by the caller: a surface that owns the
 * screen must not let stray bytes fall through into the composer behind
 * it, which is the defect the sheet's whole-chunk dismissal avoids by a
 * different route.
 */
export function viewerCommand(text: string): "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end" | "close" | null {
	switch (text) {
		case "\x1b[A":
		case "k":
			return "up";
		case "\x1b[B":
		case "j":
			return "down";
		case "\r":
		case "\n":
		case " ":
			return "toggle";
		case "a":
			return "all";
		case "\x1b[5~":
			return "pageUp";
		case "\x1b[6~":
			return "pageDown";
		case "\x1b[H":
		case "g":
			return "home";
		case "\x1b[F":
		case "G":
			return "end";
		case "\x1b":
		case "q":
		case "\x12": // ctrl+r — the key that opens it also puts it away
			return "close";
		default:
			return null;
	}
}

/** E1 §1 — the two-byte alt spellings of word motion and word deletion.
 *  A table because one gesture has several encodings, and a table is
 *  what keeps them from drifting into several features. */
const ALT_WORD = new Map<string, "left" | "right" | "killBack" | "killFwd">([
	["b", "left"],
	["f", "right"],
	["d", "killFwd"],
	["\x7f", "killBack"],
	["\x08", "killBack"],
]);

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
	// R4 (C4d): the committed transcript belongs to the terminal and can
	// never be re-wrapped in place (ADR-0046); this appends it re-folded.
	{ name: "/rewrap", desc: "re-print the recent prose at the current width" },
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
/** TMUX-F1 ①: a CSI parameter string longer than this with no final byte
 *  is not a sequence any terminal sends; it is dropped rather than held, so
 *  a runaway can never park the editor. */
const CSI_MAX = 64;
/** TMUX-F1 ②: identical arrow sequences in ONE read at or past this count
 *  are a wheel notch, not a hand — treated as one press. */
const ARROW_BURST = 3;

/** The dim "…" — the ONE truncation mark. OR-11 retired its other use
 *  (the horizontal scroll's prefix) with the scroll itself; what is left
 *  is the viewport's hidden-rows markers, above and below. */
/** R3: built per call from the palette — `dim` is an absolute grey once
 *  the ground is known, so a frozen SGR 2 here would be the one span
 *  that ignores it. */
const ellipsis = (): string => {
	const p = palette();
	return `${p.dim}\u2026${p.reset}`;
};

/**
 * DC-55 — the composer's DISPLAY form of the buffer.
 *
 * A tab is kept as U+0009 in `#chars`, because the submitted line and
 * the durable event must carry the indentation the human pasted. It
 * cannot be PAINTED as itself: the terminal expands it to the next tab
 * stop while `charWidth(0x09)` returns 1, so the row on screen becomes
 * wider than the row kiso measured — invariant ① in its literal form —
 * and every cursor column after it is wrong by the same amount.
 *
 * So the projection shows `→`, ONE code point for one code point: every
 * index and every cursor column the compositor computes from this string
 * stays true. `line()` and `#chars` never see it.
 *
 * ONE CELL, not an expansion to a tab stop. A tab's width is a property
 * of its POSITION, and `charWidth(cp)` takes a code point with no
 * context to answer that from. CJK's two cells work because two is a
 * property of the character; these are different problems, and reusing
 * that path for this one would be a mis-fit that surfaces later as
 * drift. The cost is stated in design §8: a pasted block's alignment in
 * the composer is approximate, while the block itself is exact.
 *
 * The dim is safe for the reason the ellipsis above is: `cursorCol`
 * COUNTS markers and sums the buffer's own widths — it never measures
 * this string — so an SGR span in it has never been part of the
 * arithmetic.
 */
const shown = (chars: readonly number[]): string => {
	if (!chars.includes(0x09)) return String.fromCodePoint(...chars);
	const p = palette();
	return chars.map((cp) => (cp === 0x09 ? `${p.dim}\u2192${p.reset}` : String.fromCodePoint(cp))).join("");
};

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
	// KC1 §2 — the ONE new ephemeral field: the desired column for the
	// ↑/↓ walk (a long line's column 20 → a short line clamps to 5 → the
	// next long line RETURNS to 20). Set on the first vertical move,
	// kept across consecutive ones, reset by any left/right move, insert
	// or delete. Never stashed — it is a walk's state, not the buffer's.
	#verticalGoalCol: number | null = null;
	#questionCb: ((answer: string) => void) | null = null;
	/** The approval / ask / pick panel — its state machine and its keys
	 *  live in PanelInput (S5); the editor lends it the composer through
	 *  #bandHost. */
	readonly #panelInput = new PanelInput(this.#bandHost());
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
	// W15: the expand-key list (ctrl+o) — the CLI's dispatch decides the
	// target (a live cell toggles in place; a committed cell appends the
	// expanded block). Mirrors the escape list: multiple listeners can
	// coexist; the editor never interprets the key itself.
	#expandCbs: (() => void)[] = [];
	#thinkCbs: (() => void)[] = [];
	#editorCbs: (() => void)[] = [];
	/** E1 §3 — ctrl+x. Same shape as the expand key: the editor owns the
	 *  KEY, the CLI owns what it means. */
	#copyCbs: (() => void)[] = [];
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
	// not for a turn. S5: the state and the keys live in PickInput.
	readonly #pickInput = new PickInput(this.#bandHost());
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
	/** The terminal's own account of its colour scheme (`CSI ? 997 ; 1|2 n`).
	 *  Its OWN channel, never `#oscCb`: OSC 11 reports a COLOUR that kiso
	 *  reads a ground out of, this reports the GROUND itself, and a
	 *  listener wanting one must not be handed the other. */
	#colorSchemeCb: ((scheme: "dark" | "light") => void) | null = null;
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
	onColorScheme(cb: (scheme: "dark" | "light") => void): void {
		this.#colorSchemeCb = cb;
	}

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

	/** E1 §3 — the copy key (ctrl+x). */
	onCopy(cb: () => void): void {
		this.#copyCbs.push(cb);
	}

	onExpand(cb: () => void): void {
		this.#expandCbs.push(cb);
	}

	/** §2.3: the thinking key (ctrl+t) — the chain-level action, wired
	 *  exactly like ctrl+o because it is the same kind of thing: a switch
	 *  the compositor throws, never an interpretation the editor makes. */
	onThink(cb: () => void): void {
		this.#thinkCbs.push(cb);
	}

	/** §2.4: the external-editor key (ctrl+g). */
	onEditor(cb: () => void): void {
		this.#editorCbs.push(cb);
	}

	/** §2.4 — hand the terminal to an external program, and take it back.
	 *
	 *  `run` receives the composer's text and returns what should replace
	 *  it, or null to leave it alone (no editor configured, the editor
	 *  failed, nothing changed). The SPAWN is the caller's: this package is
	 *  pure terminal — input is data, output is bytes, zero runtime deps —
	 *  so what lives here is the handover and nothing else.
	 *
	 *  NOT `exit()` / `enter()`. Those are the session's boundary: exit()
	 *  also resolves the closed promise, which tells the layer above that
	 *  the session is over. Suspending is a different act with the same
	 *  terminal moves, and conflating them would end the session every time
	 *  someone opened their editor. */
	externalEdit(run: (text: string) => string | null): void {
		const before = this.line();
		let next: string | null = null;
		process.stdin.off("data", this.#onData);
		process.stdout.write(MOUSE_OFF);
		process.stdout.write("\x1b[?2004l"); // bracketed paste OFF — the child's, not ours
		process.stdout.write("\x1b[?25h"); // and it needs a cursor to draw
		process.stdin.setRawMode(false);
		try {
			next = run(before);
		} finally {
			// the handover comes back whatever the child did, including
			// throwing: a terminal left in the child's mode is unusable and
			// the human has no way to ask for it back.
			process.stdin.setRawMode(true);
			process.stdout.write(MOUSE_OFF);
			this.#mouseOn = false;
			process.stdout.write("\x1b[?2004h");
			process.stdin.on("data", this.#onData);
		}
		if (next !== null && next !== before) {
			this.#chars = [...next].map((ch) => ch.codePointAt(0)!);
			this.#cursor = this.#chars.length;
			this.#reflow();
		}
		this.#onRender();
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

	/** R5 — the transcript viewer's key routing. The editor owns no
	 *  viewer STATE (the compositor does, because the entries are its
	 *  cells); it only reports whether the viewer is up and forwards the
	 *  commands, the same shape the expand key already uses. */
	#viewerUp: (() => boolean) | null = null;
	#viewerCbs = new Set<(cmd: "open" | "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end" | "close") => void>();
	bindViewer(isUp: () => boolean, cb: (cmd: "open" | "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end" | "close") => void): void {
		this.#viewerUp = isUp;
		this.#viewerCbs.add(cb);
	}
	#viewerSend(cmd: "open" | "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end" | "close"): void {
		for (const cb of [...this.#viewerCbs]) cb(cmd);
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

	/** The cursor's OWN LOGICAL line — the unit of the line-local A/E/U/K
	 *  (A3) and of the `@` token scan. The visual rows a long line folds
	 *  into are `#visualRows`; these two answer different questions and
	 *  OR-11 kept them apart deliberately. */
	#cursorBounds(): { start: number; end: number } {
		const bounds = this.#lineBounds();
		return bounds[this.#cursorLine(bounds)]!;
	}

	/** OR-11 — the row's width budget: the SAME number the compositor
	 *  gives the row (W23's one formula), against the lead that is
	 *  actually drawn. The fold and the cursor math both ask here. */
	#budget(): number {
		const W = (process.stdout.columns ?? 0) || 80;
		const ps = this.#panelInput.state();
		const lead = ps !== null ? panelLead(ps.view, ps.phase, ps.cursor, ps.ask) : this.#inputLead();
		return Math.max(1, W - leadWidth(lead) - 1);
	}

	/** The `[Pasted text #N +M lines]` tokens inside [start, end).
	 *  A capsule is ONE thing on screen and one thing to the cursor, so a
	 *  fold never lands inside it: it is cut when drawn if it is wider
	 *  than the row, and it is never split into two. */
	#capsules(start: number, end: number): readonly { start: number; end: number }[] {
		const text = String.fromCodePoint(...this.#chars.slice(start, end));
		const units: number[] = [];
		// the regex indexes UTF-16 units; the buffer is code points
		let cp = start;
		for (const ch of text) {
			units.push(cp);
			cp += 1;
			if (ch.length === 2) units.push(cp - 1); // a surrogate pair is one code point
		}
		units.push(end);
		const out: { start: number; end: number }[] = [];
		for (const m of text.matchAll(Editor.#CAPSULE)) {
			const i = m.index ?? 0;
			out.push({ start: units[i] ?? start, end: units[i + m[0].length] ?? end });
		}
		return out;
	}

	/** OR-11 — one logical line's VISUAL rows, as [start, end) into
	 *  #chars. The rows TILE the line exactly: no character is dropped and
	 *  none is shown twice, which is what lets the cursor map back.
	 *
	 *  The break, in order:
	 *   1. everything fits — one row;
	 *   2. the cut falls on a CJK boundary (either side breakable) — take
	 *      it, because looking further back for a space would leave the
	 *      row half empty for text that breaks anywhere;
	 *   3. otherwise the last whitespace RUN that fits: the whole run ends
	 *      the row it is on, so a continuation row never begins with a
	 *      space — unless the run itself straddles the budget, where ①
	 *      wins and the leftover spaces open the next row (OR11-F1);
	 *   4. otherwise a hard break at the last code point that fits — never
	 *      inside a wide character, because `#indexAtWidth` is that walk. */
	#foldLine(start: number, end: number, budget: number): { start: number; end: number }[] {
		const rows: { start: number; end: number }[] = [];
		const atoms = this.#capsules(start, end);
		let from = start;
		while (from < end) {
			const fits = this.#fitsWithin(from, end, budget);
			if (fits >= end) break;
			let cut = fits;
			const atom = atoms.find((a) => a.start < cut && cut < a.end);
			if (atom !== undefined) {
				// the capsule keeps its own row: start one before it when
				// there is text ahead of it, otherwise let it run whole.
				cut = atom.start > from ? atom.start : atom.end;
			} else if (!breakable(this.#chars[fits] ?? 0) && !breakable(this.#chars[fits - 1] ?? 0)) {
				let w = -1;
				for (let i = cut - 1; i > from; i -= 1) {
					if (this.#chars[i] === SPACE) {
						w = i;
						break;
					}
				}
				if (w >= 0) {
					while (this.#chars[w + 1] === SPACE && w + 1 < end) w += 1;
					// OR11-F1: capped at `fits`. Ending the row with the WHOLE
					// run is what keeps a continuation row from opening with a
					// space — but that is a preference, and invariant ① is
					// not: every row kiso produces measures ≤ W, because
					// autowrap is off and the terminal will not save it. A run
					// STRADDLING the boundary was carrying the row past the
					// budget (34 letters + 12 spaces + 20 letters at width 40
					// measured 46 against 39). When the run itself does not
					// fit, the row stops at the budget and the leftover spaces
					// open the next row.
					cut = Math.min(w + 1, fits);
				}
			}
			if (cut <= from || cut >= end) break; // no progress, or the rest fits
			rows.push({ start: from, end: cut });
			from = cut;
		}
		rows.push({ start: from, end });
		return rows;
	}

	/** OR-11 — every VISUAL row of the buffer, in order. ONE fold, built
	 *  once per read; `dockState`, the cursor mapping and the ↑/↓ walk all
	 *  READ this table rather than folding again. */
	#visualRows(): { start: number; end: number }[] {
		const budget = this.#budget();
		const out: { start: number; end: number }[] = [];
		for (const b of this.#lineBounds()) out.push(...this.#foldLine(b.start, b.end, budget));
		return out;
	}

	/** The visual row the cursor is on: the LAST row it can belong to. At
	 *  a fold boundary that is the row the next character would go on; at
	 *  a newline it is the row the newline closes, never the next line. */
	#cursorVisualRow(rows: readonly { start: number; end: number }[]): number {
		let hit = 0;
		for (let i = 0; i < rows.length; i += 1) {
			if (rows[i]!.start <= this.#cursor && this.#cursor <= rows[i]!.end) hit = i;
		}
		return hit;
	}

	/** KC1 §5 — N_visible = min(lineCount, N_MAX, max(1, H − 3 − the
	 *  menu/queue bands)). The height clamp guarantees legal geometry
	 *  down to the compositor's enter gate; the compositor re-applies the
	 *  SAME formula against the frame's real bands (it alone knows their
	 *  folded row counts), so this is the editor's honest estimate and
	 *  the frame's clamp is the authority. */
	#visibleRows(lineCount: number): number {
		const H = process.stdout.rows ?? 24;
		const bands = (this.#menuOpen ? this.#menuFiltered().length : 0) + this.#atRows() + this.#pickInput.rows() + this.#queueState().length;
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
		// OR-11: VISUAL rows. One logical line may be several of them, and
		// the window, the markers and the cursor all count them the same
		// way — N_MAX has always been about how tall the box may get, and
		// a folded line is as tall as a pasted one.
		const rows = this.#visualRows();
		const cursorLine = this.#cursorVisualRow(rows);
		const n = this.#visibleRows(rows.length);
		const first = Math.max(0, Math.min(cursorLine - n + 1, rows.length - n));
		const lines: string[] = [];
		for (let i = first; i < first + n; i += 1) {
			const b = rows[i]!;
			const above = i === first && first > 0 ? ellipsis() : "";
			const below = i === first + n - 1 && first + n < rows.length ? ellipsis() : "";
			lines.push(`${above}${shown(this.#chars.slice(b.start, b.end))}${below}`);
		}
		const cursorRow = cursorLine - first;
		// the window trails the cursor, so the hidden-above marker can only
		// share the cursor's row in the degenerate one-row window (a tiny
		// terminal) — where it shifts the column by its one cell
		const marks = cursorRow === 0 && first > 0 ? 1 : 0;
		const cursorCol = marks + widthOf(this.#chars.slice(rows[cursorLine]!.start, this.#cursor));
		return { line: lines[cursorRow]!, cursor: cursorCol, lines, cursorRow, cursorCol };
	}

	/** v3 §04: the menu's visible state for the dock — null when closed. */
	menuState(): { items: readonly MenuItem[]; selected: number } | null {
		if (!this.#menuOpen) return null;
		return { items: this.#menuFiltered(), selected: this.#menuSel };
	}

	/** v3 §04: the filtered command list for the current buffer.
	 *
	 *  A BARE `/` OPENS IT (owner-ruled 2026-09-01). It used to wait for
	 *  a second character, which made the key the banner advertises —
	 *  `/ commands` — a thing you had to already know the answer to: the
	 *  list that tells you the commands appeared only once you had typed
	 *  one. The reason for the wait was real and is fixed on the other
	 *  side: the band drew EVERY match with no window, so a bare `/`
	 *  would have piled eleven rows plus wraps above the composer. The
	 *  band windows now (see the compositor's #menuRows), so the trigger
	 *  no longer has to do the rationing. */
	#menuFiltered(): MenuItem[] {
		const line = this.line();
		if (!line.startsWith("/")) return [];
		return MENU_ITEMS.filter((m) => m.name.startsWith(line));
	}

	#refreshMenu(): void {
		if (this.#panelInput.up()) return; // W21: the menu never opens while the panel owns the keys
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
		if (this.#panelInput.up() || this.#menuOpen) return null;
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
		if (this.#pickInput.up()) return;
		if (this.#panelInput.up() || this.#menuOpen || this.#questionCb !== null) return;
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

	/** Open the picker on a bound card source (PickInput, S5). */
	beginPick(cards: () => readonly SessionCardView[], onPick: (id: string | null) => void): void {
		this.#pickInput.begin(cards, onPick);
	}

	pickState(): SessionPickState | null {
		return this.#pickInput.state();
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

	/** W21: open the approval panel (PanelInput, S5): the buffer is
	 *  stashed and restored at close, the panel takes the keys and the
	 *  input row's lead, the composer's own bands close. */
	beginPanel(view: PanelView, onCommit: (v: PanelVerdict) => void, opts?: { safer?: () => Promise<SaferAnswer> }): void {
		this.#panelInput.begin(view, onCommit, opts);
	}

	/** W21: cancel the panel — the SIGINT path's pair to beginPanel. */
	cancelPanel(): void {
		this.#panelInput.cancel();
	}

	/** W21: the compositor's bound view — the phase/selection while the
	 *  panel is up, null otherwise. */
	panelState(): PanelState | null {
		return this.#panelInput.state();
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
		this.#setMouse(this.#panelInput.up() || this.#pickInput.up() || this.#atUp());
	}

	/** OR-11 (a) — the lead the composer's row is DRAWN with, which is not
	 *  always the brick. The CLI binds the compositor's input lead as `""`
	 *  (a prompt character is a third thing saying "input lives here", and
	 *  it cost the row a column), while the editor measured against PROMPT
	 *  — so the editor believed the row two columns narrower than the
	 *  compositor drew it, and W23's "the two width authorities can never
	 *  disagree" was off by two.
	 *
	 *  A PROVIDER, not a string, because both renderers are live in the
	 *  same process: the dock draws the row when it is active and
	 *  `selfRender` draws it when it is not, and they lead it differently.
	 *  Whoever binds the row answers for whichever is drawing. The default
	 *  is the brick, which is what `selfRender` has always drawn. */
	setInputLead(lead: () => string): void {
		this.#inputLead = lead;
		this.#reflow();
	}

	#inputLead: () => string = () => PROMPT;

	/** The row's own render when the dock is inactive (a TTY without a
	 *  real size): \r + clear + blue brick prompt + visible + cursor
	 *  column. */
	selfRender(): void {
		const p = palette();
		const st = this.dockState();
		const W = (process.stdout.columns ?? 0) || 80; // a degenerate 0 size (no TIOCSWINSZ) falls back
		// W21: the panel's lead owns the row while up (the brick returns
		// when the panel closes).
		const panel = this.#panelInput.state();
		const lead = panel !== null ? panelLead(panel.view, panel.phase, panel.cursor, panel.ask) : `${p.bold}${this.#inputLead()}${p.reset}`;
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
		// R5 — while the viewer is up it OWNS the keyboard. Unlike the
		// sheet (which any key dismisses) this surface is INTERACTIVE, so
		// the chunk is matched against its own bindings and anything
		// unrecognised is swallowed rather than typed into the composer
		// behind it. esc closes; ctrl+r closes too, so the key that opens
		// it also puts it away.
		if (this.#viewerUp?.() === true) {
			const cmd = viewerCommand(text);
			if (cmd !== null) this.#viewerSend(cmd);
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
				if (!this.#panelInput.up() && (c === "\x0d" || c === "\x0a")) {
					i += 1;
					continue;
				}
			}
			// DC-62 — ONE RULE, at the top of the chain: inside a paste a
			// control byte is CONTENT OR NOTHING, never a gesture.
			//
			// DC-58 guarded three branches (0x07, 0x14, 0x0f) and stated the
			// rule generally; the rule was right and the placement was not.
			// Every other claimed control byte still ran: a pasted backspace
			// ate the text typed BEFORE the paste, a pasted 0x15 emptied the
			// buffer, a pasted 0x1a rewound it — and a pasted 0x03 or 0x04
			// fired the exit callbacks, so a paste could end the session.
			// `#insert` only COLLECTS what reaches it, so none of these ever
			// reached the collection; they acted instead.
			//
			// Nothing rather than content, because that is what the chain
			// already does with an UNCLAIMED control byte (`c < " "` discards
			// it), and a paste should not be the one place where 0x15 becomes
			// visible text. Three bytes are let through to branches that
			// already know about `#pasting` and treat them as content: CR and
			// LF become a newline, TAB stays a tab (DC-55). ESC is let
			// through because the parser must still see `ESC[201~` to END the
			// paste — swallow that and the editor never leaves paste mode.
			//
			// The three DC-58 guards are retired into this: one rule, not
			// twelve, and the next control byte someone claims is covered
			// without anyone remembering to guard it.
			if (this.#pasting && c !== undefined && c !== "\x1b" && c !== "\x0d" && c !== "\x0a" && c !== "\t") {
				const code = c.codePointAt(0)!;
				if (code < 0x20 || code === 0x7f) {
					i += 1;
					continue;
				}
			}
			if (this.#panelInput.up()) {
				// S5: the panel answers PARSED keys — a bare Esc, an Enter, a
				// Tab, a character — and says how many bytes it took, or null
				// when the key falls through to the composer (the amend
				// reason, a custom answer and a custom pick are typed through
				// the ordinary path below; an unclaimed control byte keeps its
				// meaning). An ESC that opens a sequence is not a key yet: it
				// goes to the sequence parser like any other.
				const ahead = text.slice(i + 1);
				const key: BandKey | null =
					c === undefined
						? null
						: c === "\x1b"
							? ahead.startsWith("[") || ahead.startsWith("O")
								? null
								: { kind: "esc" }
							: c === "\x0d" || c === "\x0a"
								? { kind: "enter", crlf: c === "\x0d" && text[i + 1] === "\x0a" }
								: c === "\t"
									? { kind: "tab" }
									: { kind: "char", ch: c };
				const took = key === null ? null : this.#panelInput.feed(key, this.#pasting);
				if (took !== null) {
					i += took;
					continue;
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
					//
					// TMUX-F1 ①: the whole CSI grammar — parameters (the private
					// markers `?` `<` `>` `=` included), intermediates (0x20–0x2F),
					// a final (0x40–0x7E). The class above could not END a sequence
					// carrying an intermediate — tmux answers DECRQM with
					// `ESC[?69;0$y` — so it was parked as "incomplete" and every
					// later keystroke joined a sequence that never completed: the
					// editor went deaf for the session. A sequence with
					// intermediates is a reply kiso did not ask for; it is skipped
					// whole. A parameter string past CSI_MAX with no final is
					// dropped, not held.
					const m = rest.match(/^\[([0-9;?<>=]*)([ -/]*)([@-~])/);
					if (m === null) {
						const junk = /^\[[0-9;?<>=]*[ -/]*/.exec(rest)![0];
						if (junk.length > CSI_MAX) {
							i += 1 + junk.length; // the introducer and its runaway parameters go; parsing continues
							continue;
						}
						this.#pending = text.slice(i); // incomplete CSI — wait for more
						break;
					}
					const seqLen = m[0]!.length + 1;
					if (m[2] !== "") {
						i += seqLen; // intermediates: a report kiso did not ask for — skipped whole
						continue;
					}
					// DC-62b: inside a paste the ONLY ESC-led gesture is the paste
					// end. DC-62's rule passes ESC through so the parser can still
					// see `ESC[201~`, and everything else ESC-led rode through with
					// it: a pasted `ESC[3~` forward-deleted the text after the
					// cursor. A complete CSI that is not the paste end is skipped
					// WHOLE — neither content nor gesture, the same answer the C0
					// rule gives. The incomplete case above is untouched: a CSI
					// split across two feeds still parks, or a paste arriving in
					// pieces would lose its end.
					if (this.#pasting && !(m[1] === "201" && m[3] === "~")) {
						i += seqLen;
						continue;
					}
					// TMUX-F1 ②: a BURST of identical arrows in ONE read is a wheel,
					// not a hand. Apple Terminal turns wheel and trackpad scrolling
					// into arrow keys for an alternate-screen app (tmux's client is
					// one) — three or more per notch in a single write, which a
					// person never produces in one read — and each one walked the
					// history. The burst is one press (owner ruling 2026-09-10, c);
					// separate reads stay separate presses.
					const seq = `\x1b${m[0]!}`;
					let run = 1;
					if (m[1] === "" && "ABCD".includes(m[3]!)) {
						while (text.startsWith(seq, i + run * seq.length)) run += 1;
					}
					this.#csi(m[1]!, m[3]!, run);
					i += run * seqLen;
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
					// DC-62b: a pasted OSC is not a terminal report. A shell's
					// PROMPT_COMMAND writes `ESC]0;title BEL` on every prompt, so
					// it is in any captured log a human might paste — and it was
					// reaching the ground-probe reply handler, which is DC-7's
					// rule inverted: kiso must not read the human's data as the
					// terminal's answer either. Skipped to its terminator.
					if (!this.#pasting) this.#oscCb?.(rest.slice(1, end.index));
					i += 1 + end.index + end[0]!.length;
				} else if (this.#pasting) {
					// DC-62b: inside a paste, the CSI arm above has already let
					// `ESC[201~` through and skipped every other complete CSI, and
					// the OSC arm has skipped its report. Everything ESC-led that
					// reaches here is a gesture the human did not make: a bare ESC
					// fires the escape callbacks (interrupting a running turn), a
					// double ESC is the redirect, and `ESC(B` — a charset reset,
					// in any captured terminal log — took the same road.
					//
					// ONE BYTE: the ESC is nothing and what follows is content.
					//
					// Not because the rest cannot be parsed — an ECMA-48 nF
					// escape is deterministic (ESC, intermediates 0x20–0x2F, one
					// final 0x30–0x7E), so `ESC(B` and `ESC=` COULD be consumed
					// whole. The reason is smaller and still enough: beside CSI
					// and OSC these forms are rare in pasted logs, the C0 rule
					// already gives the shape "nothing, not content", and the two
					// failure modes are not equal — `(B` left visible is
					// recoverable by the human, text eaten by a misread is not.
					//
					// KNOWN RESIDUAL: a pasted nF escape leaves its intermediates
					// and its final as text. Named here rather than implied,
					// because the next reader deserves the cost and not only the
					// choice.
					i += 1;
				} else if (rest.startsWith("O")) {
					i += 3; // SS3 (function keys) — ignored
				} else if (rest !== "" && ALT_WORD.has(rest[0]!) && !this.#pasting && this.#composerIdle()) {
					// E1 §1 — the two-byte alt spellings, SAME-CHUNK ONLY.
					//
					// This follows Alt+Enter below, which ruled the identical
					// question for the identical byte shape: "A terminal sends
					// Alt+X as ESC and X in ONE write, so SAME-CHUNK is the
					// whole test: no timer, no hold, nothing parked. The
					// identical two bytes arriving in SEPARATE chunks are NOT
					// combined — the bare Esc fires at once (its immediacy is
					// exactly what a hold would spend)."
					//
					// The work order asked for the split pair to be JOINED
					// through #pending. Built that way first, and it broke six
					// gates across four files — `dc7-osc-swallow`'s case is
					// titled "a chunk boundary between ESC and ] is known to
					// leak — Esc stays immediate", which is the same ruling
					// stated from the other side. Parking a lone ESC is what
					// joining requires, and esc immediacy is what parking
					// spends: esc interrupts a run. The conflict is reported
					// rather than resolved here.
					//
					// Inside a paste these bytes are CONTENT — `\x1bb` in
					// someone's text is an escape and a letter, not a motion.
					const op = ALT_WORD.get(rest[0]!)!;
					if (op === "left" || op === "right") this.#moveWord(op === "left" ? -1 : 1);
					else if (op === "killBack") this.#killWord();
					else this.#killWordForward();
					this.#onRender();
					i += 2;
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
					this.#verticalGoalCol = null;
					this.#refreshMenu();
					i += 1;
				} else if (this.#pickInput.up()) {
					// TUI2-R2 ②: esc leaves the picker with nothing picked.
					// The caller reads null and exits 0 — declining to resume
					// is a normal thing to do, not a failure, so it must not
					// fall through to the escapeCbs (which mean "abort the
					// run" and there is no run yet).
					this.#pickInput.close(null);
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
					//
					// DC-61: and it is an archive point, for the same reason
					// the bracketed-paste path is — this inserts a token the
					// human did not type, so one ctrl+z has to take it back.
					this.#checkpoint();
					this.#attachSeq += 1;
					this.#attachments.set(this.#attachSeq, file);
					for (const ch of `[Image #${this.#attachSeq}]`) this.#insert(ch.codePointAt(0)!);
					this.#onRender();
				}
				i += 1;
			} else if (c === "\x0f") {
				// DC-58 (0.32.1) guarded THIS branch and the two below with
				// `!#pasting`, the guard tab and CR already had: unguarded, a
				// pasted BEL opened $VISUAL mid-paste and the rest of the body
				// went to that child's stdin — DC-7's rule from the third side (a
				// byte from a paste is data the human handed over, as a reply's
				// byte is the terminal's).
				//
				// DC-62 (0.32.2) RETIRED those three guards into one rule at the
				// top of the byte loop, because the same question asked of every
				// other branch found the same answer: a pasted backspace ate the
				// text typed before the paste, and a pasted 0x03 fired the exit
				// callback. There is no per-branch guard here any more — look at
				// the top of the loop, not at this line, for why a control byte
				// inside a paste reaches nothing.
				//
				// W15: the expand key — rides the chain like a command, the
				// editor just forwards it.
				//
				// DC-41 (owner ruling 2026-09-02): this is ctrl+o now. R5
				// gave ctrl+o to the viewer because it was free and because
				// the reference implementation uses it — betting that the
				// finger cared about the KEY. It does not: the reference's
				// ctrl+o expands the tool output in front of you, which is
				// this action, and the owner reported reaching for it and
				// getting a reader. The gesture and the job are together
				// again; §7.1 is why kiso's form of it appends rather than
				// toggling in place.
				for (const cb of [...this.#expandCbs]) cb();
				i += 1;
			} else if (c === "\x14") {
				// §2.3 — ctrl+t folds the committed thinking blocks, and
				// folds them back. `\x14` was unbound across the tree
				// (checked before the round), and it is the key the
				// reference implementation uses for this same gesture, so a
				// reader arriving from it is not retrained.
				//
				// Forwarded, not interpreted: the switch is the
				// compositor's, exactly as ctrl+o's is.
				for (const cb of [...this.#thinkCbs]) cb();
				i += 1;
			} else if (c === "\x07") {
				// §2.4 — ctrl+g opens $VISUAL / $EDITOR on the composer.
				//
				// 0x07 is BEL, which is also the terminator a terminal puts
				// on an OSC reply (DC-7). This branch is only reached by a
				// BARE 0x07: the OSC arm above consumes its own terminator,
				// so the terminal's answer never arrives here. One byte, two
				// meanings, told apart by what precedes it — and there is a
				// gate for exactly that, because "should not reach here" is
				// not something to take on trust.
				for (const cb of [...this.#editorCbs]) cb();
				i += 1;
			} else if (c === "\x18" && this.#composerIdle()) {
				// E1 §3 — ctrl+x copies the last answer. `\x18` was unbound
				// across the whole tree (checked before the round started),
				// so nothing is displaced.
				//
				// Composer-idle only, like `?` and ctrl+r: a panel, picker,
				// menu or question owns its keys first. The buffer is NOT
				// required to be empty — ctrl+x copies the ANSWER, not the
				// composer, so a half-written follow-up is no reason to
				// refuse. (ctrl+r requires an empty buffer because it opens
				// a surface OVER the composer; this prints one status row.)
				for (const cb of [...this.#copyCbs]) cb();
				i += 1;
			} else if (c === "\x12" && this.#composerIdle() && this.#chars.length === 0) {
				// R5 — the transcript viewer, on ctrl+r since DC-41. The
				// reference binds ctrl+r to renaming a session, which kiso
				// has no equivalent of, so nothing a reference user means by
				// it is displaced; every other free control key in this
				// dispatch collides with something that surface actually
				// does. Idle composer only, exactly like `?`:
				// mid-text it would be a keystroke stolen from the human.
				this.#viewerSend("open");
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
			} else if (c === "\t" && this.#pasting) {
				// DC-55 — a TAB is content, and the branch below would have
				// eaten it.
				//
				// `c < " "` discards every unclaimed control byte, and a
				// paste has no other way into the buffer, so pasting
				// indented code silently lost its indentation: `alpha\tbeta`
				// arrived as `alphabeta`.
				//
				// `#pasting` IS TESTED, and the first build left it out on the
				// reasoning that a typed Tab is claimed further up anyway.
				// It is claimed CONDITIONALLY: `\t && #menuOpen` completes a
				// command and `\t && #atUp()` completes a path, so with
				// neither surface open a typed Tab falls through to exactly
				// here. Without the guard it started inserting a tab — the
				// completion key silently became an insert key on an idle
				// composer, which the typed-Tab gate caught.
				//
				// A paste is the one context where a tab is CONTENT.
				this.#insert(0x09);
				i += 1;
			} else if (c !== undefined && c < " ") {
				i += 1; // other control — ignored
			} else {
				// E1 §1 (found by the word-op gate, PRE-EXISTING): advance by
				// the CODE POINT, not by `text[i]`.
				//
				// `c` is one UTF-16 unit, so `c.length` is always 1, while
				// `codePointAt` returns the whole astral code point. Typing
				// one emoji therefore inserted the code point AND then the
				// lone low surrogate left under the cursor — `"😀"` came back
				// as `"😀\ude00"`, three UTF-16 units for one glyph.
				//
				// Verified pre-existing by stashing this round's changes and
				// re-running: the baseline is identically wrong. It surfaces
				// now because word motion is the first feature that has to
				// STEP over a grapheme rather than only append to it.
				const cp = text.codePointAt(i)!;
				this.#insert(cp);
				i += cp > 0xffff ? 2 : 1;
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
		this.#panelInput.click(this.#panelRows?.(), row);
	}

	/** TUI2-R3v2 ②: the compositor reports where it PUT the option rows.
	 *  The editor does no row arithmetic of its own — the surface that
	 *  placed them is the only thing that can say where they are, and a
	 *  second copy of that sum is how a hit-test comes to disagree with
	 *  the picture. */
	bindPanelRows(fn: (() => { top: number; count: number; first?: number } | null) | null): void {
		this.#panelRows = fn;
	}

	/** TMUX-F1 ②: `run` identical arrow sequences arrived in ONE read. Every
	 *  surface but one gets every press — a wheel over the transcript viewer,
	 *  a panel, a multi-row draft scrolls, as a wheel should. The HISTORY
	 *  walk is the one that replaces the draft's content, and there a burst
	 *  (ARROW_BURST or more in one read — a wheel notch, never a hand) is one
	 *  step. The first press decides which branch it was, so the gate is not
	 *  written twice. */
	#csi(params: string, final: string, run = 1): void {
		const took = this.#csiOnce(params, final);
		if (took === "history" && run >= ARROW_BURST) return;
		for (let k = 1; k < run; k += 1) this.#csiOnce(params, final);
	}

	#csiOnce(params: string, final: string): "history" | undefined {
		let took: "history" | undefined;
		// TUI2-R3v2 ②: an SGR 1006 report — `\x1b[<b;col;rowM` (press) or
		// `...m` (release). It is routed FIRST because a `<` parameter is
		// never anything else, and because a mouse byte must never fall
		// through to a key handler.
		if (params.startsWith("<")) {
			this.#mouseEvent(params, final === "M");
			return;
		}
		// The terminal's colour-scheme REPORT — `CSI ? 997 ; 1 n` (dark) or
		// `; 2 n` (light), answering the `CSI ? 996 n` sent at startup.
		//
		// Routed high and narrow, for the mouse branch's reason: a report
		// is never a key and must never fall through to one. It used to
		// reach the END of this method instead, which dropped it in
		// silence — the terminal answered and nothing could hear it. The
		// pattern is exact (997 only, 1 or 2 only) because `n` is a final
		// that device-status reports share.
		if (final === "n") {
			const scheme = /^\?997;([12])$/.exec(params);
			if (scheme !== null) {
				this.#colorSchemeCb?.(scheme[1] === "1" ? "dark" : "light");
				return;
			}
		}
		// E1 §1 — alt+←/→ and ctrl+←/→, the CSI spellings of word motion.
		//
		// `1;3` is alt (meta), `1;5` is ctrl. Terminal.app sends the CSI
		// form for alt+← unless "Use Option as Meta Key" is on, in which
		// case it sends `\x1bb` — handled in the escape branch. Both are
		// the same gesture and both route here, because a gesture with
		// three spellings is a table, not three features.
		//
		// Composer-idle only, for the back-tab's reason below: a panel,
		// picker, menu or question owns its keys first.
		if ((final === "D" || final === "C") && (params === "1;3" || params === "1;5") && this.#composerIdle()) {
			this.#moveWord(final === "D" ? -1 : 1);
			this.#onRender();
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
			if (this.#panelInput.arrow(final === "A" ? "up" : "down")) {
				// the panel walked its own list (a phase without one swallows the key)
			} else if (this.#pickInput.arrow(final === "A" ? "up" : "down")) {
				// the session picker moved its selection
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
			} else if (this.#visualRows().length > 1) {
				// KC1 §4, restated by OR-11 over VISUAL rows: a buffer that
				// occupies more than one row has its ↑↓ walk them. It used
				// to read `#chars.includes(NEWLINE)`, which was the same
				// question while one logical line was always one row; a
				// folded line is several now, and the walk is about what the
				// eye sees.
				//
				// The history and the queue-pop below stay gated on an EMPTY
				// buffer, and an empty buffer is exactly one row — so the
				// precedence can only ever add, never take, which is what
				// T-E4 pins.
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
				took = "history"; // the repaint below is still owed — an early return here left the recall unpainted (r3a red)
			}
			this.#onRender();
		} else if (final === "D") {
			// KC3.5: ← walks the ask BACK a question (the ‹ n/m › walk); at
			// question one it stays put — esc is the decline, never ←.
			if (!this.#panelInput.left()) this.#move(-1);
		} else if (final === "C") {
			// OR-7: → walks the pick panel's level axis when one is up; the
			// composer keeps the key everywhere else, exactly as ← does.
			if (!this.#panelInput.right()) this.#move(1);
		} else if (final === "H") {
			// OR-11 (b): and REPAINT. Ctrl+A and Ctrl+E render; their arrow
			// spellings reflowed and stopped there, so the caret stayed
			// where it had been until some later key happened to draw. A
			// gesture that moves the cursor is a gesture that shows it.
			this.#cursor = this.#cursorBounds().start; // A3: Home follows Ctrl+A — line-local
			this.#reflow();
			this.#onRender();
		} else if (final === "F") {
			this.#cursor = this.#cursorBounds().end; // A3: End follows Ctrl+E — line-local
			this.#reflow();
			this.#onRender();
		}
		return took;
	}

	/** KC1 §4 — the ↑/↓ walk. The cursor keeps its DESIRED column across
	 *  a short line: the goal is captured at the FIRST vertical move and
	 *  survives consecutive ones (#reflow clears it, so any left/right
	 *  move / insert / delete ends the walk); a step past either end
	 *  stays put. */
	#verticalMove(delta: number): void {
		// OR-11: VISUAL rows — one long logical line is several of them, and
		// ↑/↓ walk what the eye sees. The goal column is unchanged.
		const bounds = this.#visualRows();
		const cur = this.#cursorVisualRow(bounds);
		const next = cur + delta;
		if (next < 0 || next >= bounds.length) return;
		const from = bounds[cur]!;
		const goal = this.#verticalGoalCol ?? widthOf(this.#chars.slice(from.start, this.#cursor));
		const to = bounds[next]!;
		this.#cursor = this.#indexAtWidth(to.start, to.end, goal);
		this.#reflow();
		this.#verticalGoalCol = goal; // the walk re-arms it (the reflow's reset is for every OTHER key)
	}

	/* DECLARED MOVE (S5, 2026-09-06): the panel state machine — the
	   fourteen handlers from #panelMove to #panelClose — lives in
	   panel-input.ts (PanelInput); the session picker's in pick-input.ts
	   (PickInput). The editor parses bytes and lends them the composer
	   through #bandHost; nothing else of either band remains here. */

	/** S5 — the composer as the band controllers see it: the whole
	 *  surface a panel or the session picker may touch, in one place. */
	#bandHost(): BandHost {
		return {
			line: () => this.line(),
			expandPastes: (line) => this.#expandPastes(line),
			clear: () => {
				this.#chars = [];
				this.#cursor = 0;
				this.#verticalGoalCol = null;
			},
			insert: (cp) => this.#insert(cp),
			newline: () => this.#insert(NEWLINE),
			stash: () => ({ chars: this.#chars, cursor: this.#cursor }),
			restore: (st) => {
				this.#chars = [...st.chars];
				this.#cursor = st.cursor;
			},
			reflow: () => this.#reflow(),
			render: () => this.#onRender(),
			syncMouse: () => this.#syncMouse(),
			closeBands: () => {
				this.#menuOpen = false;
				this.#menuSel = 0;
				this.#queuePopMode = false; // W22: the panel owns the keys while up
				this.#atClose(); // KC3 §3: and the picker closes with everything else
			},
			swallowNextEnter: () => {
				this.#swallowEnter = true;
			},
		};
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

	/**
	 * E1 §1 — WHERE A WORD ENDS. One function, five operations.
	 *
	 * `#killWord` used to answer this inline, and only for `0x20`: no
	 * tab, no punctuation, and a whole Chinese sentence was one word from
	 * its first character to its last. Five operations asking the
	 * question separately is five chances for a motion and a deletion to
	 * disagree about the same text, so they ask here.
	 *
	 * Three classes over the CODE POINT:
	 *
	 *   - SEPARATOR — whitespace, and the newline the flat buffer carries
	 *     as an ordinary code point;
	 *   - CJK — one character IS one word. A sentence is not a unit
	 *     anyone wants to move or delete by, and the owner types Chinese;
	 *   - otherwise WORD vs PUNCT, which split from each other: `foo.bar`
	 *     is three words, the readline behaviour and every editor's.
	 *
	 * Combining marks, ZWJ joins and variation selectors are NOT their
	 * own class — they belong to whatever precedes them (`#glyphStart`),
	 * so a family emoji deletes whole instead of shedding a member and
	 * stranding a joiner.
	 */
	#classOf(cp: number): "sep" | "cjk" | "word" | "punct" {
		// U+3000 IS A SPACE, and it sits inside the CJK range below, so it
		// has to be named before the range test rather than after it. It
		// classed as "cjk" in the first build — an ideographic space
		// deleted as though it were a character, which is exactly what the
		// CJK-per-character rule is NOT about.
		if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x3000) return "sep";
		// CJK ideographs, kana, Hangul, the fullwidth forms — one per word.
		if (
			(cp >= 0x1100 && cp <= 0x11ff) ||
			(cp >= 0x2e80 && cp <= 0x9fff) ||
			(cp >= 0xa960 && cp <= 0xa97f) ||
			(cp >= 0xac00 && cp <= 0xd7ff) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xff00 && cp <= 0xffef) ||
			(cp >= 0x20000 && cp <= 0x3ffff)
		) {
			return "cjk";
		}
		const ch = String.fromCodePoint(cp);
		if (/[\p{L}\p{N}_]/u.test(ch)) return "word";
		return "punct";
	}

	/** True when `i` is a continuation of the glyph before it — a
	 *  combining mark, a ZWJ, or a variation selector. Never a boundary. */
	#joins(cp: number): boolean {
		return (
			(cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
			(cp >= 0x1ab0 && cp <= 0x1aff) ||
			(cp >= 0x20d0 && cp <= 0x20ff) ||
			(cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
			cp === 0x200d || // ZWJ
			(cp >= 0xe0100 && cp <= 0xe01ef)
		);
	}

	/** The index one WORD away from `from`, in `dir`. Skips a run of
	 *  separators, then crosses one run of a single class. Joiners never
	 *  end a run, so a grapheme is never split. */
	#wordEdge(from: number, dir: -1 | 1): number {
		const at = (i: number): number => this.#chars[dir < 0 ? i - 1 : i] ?? -1;
		let i = from;
		const end = dir < 0 ? 0 : this.#chars.length;
		const more = (): boolean => (dir < 0 ? i > end : i < end);
		while (more() && this.#classOf(at(i)) === "sep") i += dir;
		if (!more()) return i;
		// A JOINER NEVER DECIDES THE RUN'S CLASS. Walking backwards, the
		// first thing seen at the end of `café` is the combining acute —
		// which is not a letter, so classifying from it made the run
		// "punct" and the kill stopped after one mark, leaving `e`.
		// Joiners belong to the character before them; step over them
		// first and classify from the base.
		while (more() && this.#joins(at(i))) i += dir;
		if (!more()) return i;
		// CJK: exactly one character (plus anything joined to it).
		const cls = this.#classOf(at(i));
		if (cls === "cjk") {
			i += dir;
			while (more() && this.#joins(at(i))) i += dir;
			return i;
		}
		while (more()) {
			const c = at(i);
			if (!this.#joins(c) && this.#classOf(c) !== cls) break;
			i += dir;
		}
		return i;
	}

	/** Ctrl+W and alt+backspace — the word kill. A3 scopes A/E/U/K, not
	 *  W. UD-1: an archive point only when something is actually removed;
	 *  a no-op kill at the buffer's start must not eat the next ctrl+z. */
	#killWord(): void {
		const i = this.#wordEdge(this.#cursor, -1);
		if (i >= this.#cursor) return;
		this.#checkpoint(); // UD-1
		this.#chars.splice(i, this.#cursor - i);
		this.#cursor = i;
		this.#reflow();
	}

	/** alt+d — the word kill FORWARD. Same boundary, same archive rule. */
	#killWordForward(): void {
		const j = this.#wordEdge(this.#cursor, 1);
		if (j <= this.#cursor) return;
		this.#checkpoint(); // UD-1
		this.#chars.splice(this.#cursor, j - this.#cursor);
		this.#reflow();
	}

	/** alt+←/→ — the cursor one word over. No archive point: nothing is
	 *  destroyed. */
	#moveWord(dir: -1 | 1): void {
		this.#cursor = this.#wordEdge(this.#cursor, dir);
		this.#reflow();
	}

	/** KC1/KC2 — the buffer LEAVES: the flat chars, the cursor, the ↑/↓
	 *  goal, the menu and the pop-walk all
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
		// DC-61: a paste is an ARCHIVE POINT. UD-1's invariant was written
		// around destructive gestures — no gesture may discard more than one
		// code point without a checkpoint — and a paste discards nothing, so
		// it never took one. The loss arrived from the other side: ctrl+z
		// after a paste did nothing, or reached an OLDER checkpoint and threw
		// away the paste plus everything typed since it in one press.
		//
		// It sits here, after the image branch has either returned or filled
		// `run`, so both shapes are covered by one call and the
		// nothing-happened case (an empty paste with no clipboard image)
		// still takes no checkpoint — a phantom entry would make ctrl+z a
		// press the human has to repeat.
		this.#checkpoint();
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
			!this.#panelInput.up() &&
			!this.#menuOpen &&
			!this.#atUp() && // KC3 §3: the @ picker owns the keys while up, exactly like the menu
			!this.#pickInput.up() && // TUI2-R2 ②: and so does the session picker — `?` is a query character there
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
		if (this.#pickInput.up()) {
			this.#pickInput.accept();
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
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	// ---- the width walks ----

	#reflow(): void {
		// KC1: any key that reaches the reflow ended a ↑/↓ walk (the walk
		// itself re-arms the goal right after its own reflow call).
		this.#verticalGoalCol = null;
		// OR-11 — DECLARED SUPERSESSION of ADR-0039 Amendment 2's horizontal
		// scrolling. There is nothing to reflow horizontally any more: a
		// long line FOLDS (see #foldLine), so every character is on screen
		// and the row offset that used to be kept here is gone with it.
		// What survives is the goal-column reset above, which every key
		// that is not a ↑/↓ walk still owes.
	}

	/** The first index in [start, end] whose display width from `start`
	 *  reaches `target` — the width-based column walk (a wide char never
	 *  splits: the index lands BEFORE it). */
	/** OR-11 — the end of the WIDEST PREFIX of [start, end) that fits in
	 *  `budget` columns. Distinct from `#indexAtWidth`, which answers the
	 *  scroll's question ("the first index AT or past this width") and is
	 *  one character too generous for a fold: 20 wide characters are 40
	 *  columns and do not fit in 39. The walk stops BEFORE a character
	 *  that would overflow, so a wide character is never split — the same
	 *  `w + cw > limit` the compositor's own row cut uses. */
	#fitsWithin(start: number, end: number, budget: number): number {
		let w = 0;
		for (let i = start; i < end; i += 1) {
			const cw = charWidth(this.#chars[i]!);
			if (w + cw > budget) return i;
			w += cw;
		}
		return end;
	}

	#indexAtWidth(start: number, end: number, target: number): number {
		let w = 0;
		for (let i = start; i < end; i += 1) {
			if (w >= target) return i;
			w += charWidth(this.#chars[i]!);
		}
		return end;
	}
}
