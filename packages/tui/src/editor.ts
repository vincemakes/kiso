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
import { panelLead, type PanelPhase, type PanelSel, type PanelState, type PanelVerdict, type PanelView } from "./approval-panel.js";

// TUI v4 #16d: the input row is the blue brick + the edit area — the
// "you>" text is gone (the brick IS the prompt; the pipe path's readline
// prompt keeps its own "you> " — v2a line mode, byte-for-byte).
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
	{ name: "/think", desc: "show the last full thinking block" },
	{ name: "/last", desc: "show the most recent tool call's input and output" },
	{ name: "/status", desc: "show session id, event count, and context estimate" },
	{ name: "/help", desc: "print this list of commands" },
];

/** KC1 §3 — the newline code point. Every source (paste, Ctrl+J, the
 *  Shift+Enter encodings, a CRLF pair) normalizes to exactly ONE. */
const NEWLINE = 0x0a;

/** KC1 §5 — the composer's CEILING (adjudication A1): at most 6 visible
 *  rows. A ceiling only — N_visible clamps by the terminal's height so
 *  the geometry stays legal down to the compositor's enter gate (H = 4
 *  ⇒ one row, exactly today's minimum). */
const N_MAX = 6;

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
		sel: PanelSel;
		amend: "yes" | "no";
		onCommit: (v: PanelVerdict) => void;
		stash: { chars: number[]; cursor: number; scroll: number };
	} | null = null;
	#pasting = false;
	#lineCb: ((line: string) => void) | null = null;
	#pendingLines: string[] = []; // submits before onLine is wired (startup) — never dropped
	#sigintCb: (() => void) | null = null;
	#eotCb: (() => void) | null = null;
	// W18: the escape LIST — the run-abort (chat) and the /compact cancel
	// (dispatch) coexist; a listener removes itself via an unarmed guard
	// (the compact's handler no-ops after its abort has fired).
	#escapeCbs: (() => void)[] = [];
	// W15: the expand-key list (ctrl+r) — the CLI's dispatch decides the
	// target (a live cell toggles in place; a committed cell appends the
	// expanded block). Mirrors the escape list: multiple listeners can
	// coexist; the editor never interprets the key itself.
	#expandCbs: (() => void)[] = [];
	#onRender: () => void;
	#menuOpen = false; // v3 §04: the slash-command menu
	#menuSel = 0;
	// A2 (the feel): the session-scoped input history — every submitted TURN
	// line (never a question answer), capped at 100, never persisted. ↑↓
	// navigate it ONLY from an empty input or while already browsing.
	#history: string[] = [];
	#historyIdx: number | null = null;
	#preBrowse: number[] = [];
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
	#pending = ""; // an incomplete ESC/CSI prefix across chunks
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

	onExpand(cb: () => void): void {
		this.#expandCbs.push(cb);
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

	clearLine(): void {
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
		const bands = (this.#menuOpen ? this.#menuFiltered().length : 0) + this.#queueState().length;
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
	beginPanel(view: PanelView, onCommit: (v: PanelVerdict) => void): void {
		this.#panel = {
			view,
			phase: "options",
			sel: 0,
			amend: "yes",
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
		return { view: panel.view, phase: panel.phase, sel: panel.sel };
	}

	enter(): void {
		if (this.#entered) return;
		this.#entered = true;
		process.stdin.setRawMode(true);
		process.stdout.write("\x1b[?2004h"); // bracketed paste ON
		process.stdin.on("data", this.#onData);
		this.#onRender();
	}

	exit(): void {
		if (!this.#entered) return;
		this.#entered = false;
		process.stdin.off("data", this.#onData);
		process.stdout.write("\x1b[?2004l"); // bracketed paste OFF
		process.stdin.setRawMode(false);
		this.#closedResolve();
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
		const lead = panel !== null ? panelLead(panel.view, panel.phase, panel.sel) : `${p.bold}${PROMPT}${p.reset}`;
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
		let i = 0;
		while (i < text.length) {
			const c = text[i];
			if (this.#panel !== null) {
				// W21: the panel owns the keys — the digits/y/n select in
				// the options phase (digit 2 jumps to the rule input), tab
				// opens the amend (approval only), esc backs out (rule/
				// amend → options, selection → rest, rest → cancel), enter
				// commits by phase. CSI/SS3 and the editing keys still ride
				// the normal chain below (the rule/amend lines are free
				// text); ctrl-c still rides the SIGINT handler (which
				// cancels the panel).
				const panel = this.#panel;
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
					this.#panelEnter();
					i += 1;
					continue;
				}
				if (c === "1" || c === "y" || c === "Y") {
					if (panel.phase === "options") this.#panelSelect(1);
					i += 1;
					continue;
				}
				if (c === "2" && panel.phase === "options" && panel.view.flavor === "approval") {
					this.#panelRule();
					i += 1;
					continue;
				}
				if (c === "3" || c === "n" || c === "N") {
					if (panel.phase === "options") this.#panelSelect(3);
					i += 1;
					continue;
				}
			}
			if (c === "\x1b") {
				const rest = text.slice(i + 1);
				if (rest.startsWith("[")) {
					const m = rest.match(/^\[([0-9;?]*)([A-Za-z~])/);
					if (m === null) {
						this.#pending = text.slice(i); // incomplete CSI — wait for more
						break;
					}
					this.#csi(m[1]!, m[2]!);
					i += m[0]!.length + 1;
				} else if (rest.startsWith("O")) {
					i += 3; // SS3 (function keys) — ignored
				} else if (this.#menuOpen) {
					// v3 §04: Esc closes the menu and clears the buffer.
					// CA-4: the closing esc consumes its burst (the `i += 1`
					// convention) — a double-esc can never abort the turn.
					this.#chars = [];
					this.#cursor = 0;
					this.#scroll = 0;
					this.#verticalGoalCol = null;
					this.#refreshMenu();
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
			} else if (c === "\x12") {
				// W15: the expand key (ctrl+r) — rides the chain like a
				// command, the editor just forwards it.
				for (const cb of [...this.#expandCbs]) cb();
				i += 1;
			} else if (c !== undefined && c < " ") {
				i += 1; // other control — ignored
			} else {
				this.#insert(text.codePointAt(i)!);
				i += c!.length;
			}
		}
	}

	#csi(params: string, final: string): void {
		// KC1 §4 — Shift+Enter WHERE THE TERMINAL ENCODES IT: kitty's
		// CSI-u (ESC [ 13;2 u) and xterm's modifyOtherKeys (ESC [ 27;2;13 ~).
		// Never claimed universal — Ctrl+J is the everywhere baseline; a
		// terminal that sends neither simply never reaches this row. The
		// chunk-split safety is the existing #pending CSI resume.
		if ((final === "u" && params === "13;2") || (final === "~" && params === "27;2;13")) {
			this.#insert(NEWLINE);
			return;
		}
		if (final === "~") {
			const n = Number(params);
			if (n === 3) this.#delete();
			else if (n === 200) this.#pasting = true;
			else if (n === 201) {
				this.#pasting = false;
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
				/* the panel owns the keys */
			} else if (this.#menuOpen) {
				if (final === "A") this.#menuSel = Math.max(0, this.#menuSel - 1);
				else this.#menuSel = Math.min(this.#menuFiltered().length - 1, this.#menuSel + 1);
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
			this.#move(-1);
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

	// ---- W21: the panel state machine ----

	#panelSelect(sel: 1 | 3): void {
		const panel = this.#panel;
		if (panel === null) return;
		panel.sel = sel;
		this.#onRender();
	}

	/** digit 2 — the rule input: the buffer prefilled with the tool name
	 *  (the option-2 prefill; enter commits the rule). */
	#panelRule(): void {
		const panel = this.#panel;
		if (panel === null) return;
		panel.phase = "rule";
		panel.sel = 2;
		this.#chars = [...panel.view.name].map((ch) => ch.codePointAt(0)!);
		this.#cursor = this.#chars.length;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	/** tab — the amend phase on the selected option (yes/deny); the
	 *  simple flavor never has it (options 1/3 only, no option 2). */
	#panelTab(): void {
		const panel = this.#panel;
		if (panel === null || panel.view.flavor !== "approval") return;
		panel.amend = panel.sel === 3 ? "no" : "yes";
		panel.phase = "amend";
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#onRender();
	}

	/** esc — back out of the rule/amend to the options (the buffer
	 *  clears), deselect, or cancel the panel at rest. */
	#panelEsc(): void {
		const panel = this.#panel;
		if (panel === null) return;
		if (panel.phase !== "options") {
			panel.phase = "options";
			panel.sel = 0;
			this.#chars = [];
			this.#cursor = 0;
			this.#scroll = 0;
			this.#verticalGoalCol = null;
			this.#onRender();
			return;
		}
		if (panel.sel !== 0) {
			panel.sel = 0;
			this.#onRender();
			return;
		}
		this.#panelClose({ action: "cancel" });
	}

	/** enter — commit by phase: the rule input (the tool name when
	 *  empty), the amend feedback (the bare verdict when empty), or the
	 *  selected option (nothing at rest — an accidental enter never
	 *  approves). Enter on the selected option 2 is the digit-2 key. */
	#panelEnter(): void {
		const panel = this.#panel;
		if (panel === null) return;
		const line = this.line();
		if (panel.phase === "rule") {
			this.#panelClose({ action: "allow-rule", rule: line === "" ? panel.view.name : line });
			return;
		}
		if (panel.phase === "amend") {
			this.#panelClose(panel.amend === "yes" ? { action: "allow", reason: line } : { action: "deny", reason: line });
			return;
		}
		if (panel.sel === 1) this.#panelClose({ action: "allow", reason: "" });
		else if (panel.sel === 2) this.#panelRule();
		else if (panel.sel === 3) this.#panelClose({ action: "deny", reason: "" });
	}

	#panelClose(verdict: PanelVerdict): void {
		const panel = this.#panel;
		if (panel === null) return;
		this.#panel = null;
		// the pre-panel buffer returns — the panel's rule/feedback text
		// never leaks into the user's next turn (commit AND cancel).
		this.#chars = [...panel.stash.chars];
		this.#cursor = panel.stash.cursor;
		this.#scroll = panel.stash.scroll;
		this.#onRender();
		panel.onCommit(verdict);
	}

	// ---- editing ----

	#insert(cp: number): void {
		if (this.#historyIdx !== null) this.#historyIdx = null; // editing leaves the browse
		this.#queuePopMode = false; // W22: editing leaves the pop-walk too
		this.#chars.splice(this.#cursor, 0, cp);
		this.#cursor += 1;
		this.#reflow();
		if (!this.#pasting) this.#refreshMenu();
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

	#killToStart(): void {
		const { start } = this.#cursorBounds(); // A3: line-local (0 on a single line — unchanged)
		this.#chars.splice(start, this.#cursor - start);
		this.#cursor = start;
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

	#killToEnd(): void {
		const { end } = this.#cursorBounds(); // A3: line-local (the buffer's end on a single line — unchanged)
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
		this.#chars.splice(i, this.#cursor - i);
		this.#cursor = i;
		this.#reflow();
	}

	#submit(): void {
		let line = String.fromCodePoint(...this.#chars);
		if (this.#menuOpen) {
			// A1 (the feel): Enter submits the EXACT selection directly; a
			// PARTIAL selection COMPLETES the buffer (the Tab semantics)
			// without submitting — the user reviews and presses Enter
			// again. The old behavior executed the completed command on
			// the first Enter, before the user had seen the completion.
			const m = this.#menuFiltered()[this.#menuSel];
			if (m !== undefined && m.name !== line) {
				this.#chars = [...m.name].map((ch) => ch.codePointAt(0)!);
				this.#cursor = this.#chars.length;
				this.#reflow();
				this.#refreshMenu();
				this.#onRender();
				return; // completed, not executed
			}
		}
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#verticalGoalCol = null;
		this.#menuOpen = false;
		this.#menuSel = 0;
		this.#queuePopMode = false; // W22: a submit ends the pop-walk — the next esc at rest interrupts again
		const cb = this.#questionCb;
		this.#questionCb = null;
		if (cb !== null) {
			cb(line);
		} else if (this.#lineCb !== null) {
			this.#lineCb(line);
		} else {
			this.#pendingLines.push(line); // nobody wired yet — hold it
		}
		// A2: the history remembers submitted TURN lines — never question
		// answers, never empties; adjacent duplicates collapse.
		if (cb === null && line !== "") {
			if (this.#history[this.#history.length - 1] !== line) this.#history.push(line);
			if (this.#history.length > 100) this.#history.shift();
		}
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
		const lead = this.#panel !== null ? panelLead(this.#panel.view, this.#panel.phase, this.#panel.sel) : PROMPT;
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
