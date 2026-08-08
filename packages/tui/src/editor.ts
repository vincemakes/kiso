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
 * The editor is a SINGLE line: bracketed paste (?2004h) unwraps and
 * inserts, internal newlines become spaces.
 */

import { charWidth, displayWidth, widthOf } from "./width.js";
// the width primitives moved to width.ts (W1, the single width
// authority) — re-exported so the editor's public surface is unchanged.
export { charWidth, displayWidth, widthOf };
import { palette } from "./render.js";

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
	#scroll = 0; // chars scrolled off the left (width-based reflow)
	#questionCb: ((answer: string) => void) | null = null;
	#pasting = false;
	#lineCb: ((line: string) => void) | null = null;
	#pendingLines: string[] = []; // submits before onLine is wired (startup) — never dropped
	#sigintCb: (() => void) | null = null;
	#eotCb: (() => void) | null = null;
	// W18: the escape LIST — the run-abort (chat) and the /compact cancel
	// (dispatch) coexist; a listener removes itself via an unarmed guard
	// (the compact's handler no-ops after its abort has fired).
	#escapeCbs: (() => void)[] = [];
	#onRender: () => void;
	#menuOpen = false; // v3 §04: the slash-command menu
	#menuSel = 0;
	// A2 (the feel): the session-scoped input history — every submitted TURN
	// line (never a question answer), capped at 100, never persisted. ↑↓
	// navigate it ONLY from an empty input or while already browsing.
	#history: string[] = [];
	#historyIdx: number | null = null;
	#preBrowse: number[] = [];
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

	/** The whole buffer as text (the CLI's line()/clearLine()). */
	line(): string {
		return String.fromCodePoint(...this.#chars);
	}

	clearLine(): void {
		this.#chars = [];
		this.#cursor = 0;
		this.#scroll = 0;
		this.#onRender();
	}

	/** The visible slice (dim "…" prefix when scrolled) + the cursor's
	 *  display column within it — the dock's input-row state. */
	dockState(): { line: string; cursor: number } {
		const visible = String.fromCodePoint(...this.#chars.slice(this.#scroll));
		const prefix = this.#scroll > 0 ? "\x1b[2m…\x1b[0m" : "";
		const col = (this.#scroll > 0 ? 1 : 0) + widthOf(this.#chars.slice(this.#scroll, this.#cursor));
		return { line: `${prefix}${visible}`, cursor: col };
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
		const cursorCol = Math.min(1 + PROMPT_WIDTH + st.cursor, W);
		process.stdout.write(`\r\x1b[0K${p.bold}${PROMPT}${p.reset}${st.line}\x1b[${cursorCol}G`);
	}

	// ---- input ----

	/** Feed raw stdin bytes — the parser. Public for unit tests. */
	feed(raw: Uint8Array): void {
		const text = this.#pending + this.#decoder.decode(raw, { stream: true });
		this.#pending = "";
		let i = 0;
		while (i < text.length) {
			const c = text[i];
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
					this.#chars = [];
					this.#cursor = 0;
					this.#scroll = 0;
					this.#refreshMenu();
				} else if (this.#historyIdx !== null) {
					// A2: Esc exits the history browse — the pre-browse
					// (empty) input returns.
					this.#historyIdx = null;
					this.#chars = [...this.#preBrowse];
					this.#cursor = this.#chars.length;
					this.#reflow();
					this.#onRender();
				} else {
					for (const cb of [...this.#escapeCbs]) cb();
					i += 1;
				}
			} else if (c === "\x0d" || c === "\x0a") {
				if (this.#pasting) {
					this.#insert(0x20); // single-line editor: newlines become spaces
				} else {
					this.#submit();
				}
				i += 1;
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
				this.#cursor = 0;
				this.#reflow();
				this.#onRender();
				i += 1;
			} else if (c === "\x05") {
				this.#cursor = this.#chars.length;
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
			} else if (c !== undefined && c < " ") {
				i += 1; // other control — ignored
			} else {
				this.#insert(text.codePointAt(i)!);
				i += c!.length;
			}
		}
	}

	#csi(params: string, final: string): void {
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
			// the cursor semantics are unchanged (↑↓ do nothing).
			if (this.#menuOpen) {
				if (final === "A") this.#menuSel = Math.max(0, this.#menuSel - 1);
				else this.#menuSel = Math.min(this.#menuFiltered().length - 1, this.#menuSel + 1);
			} else if (this.#historyIdx !== null || this.line() === "") {
				this.#historyMove(final === "A" ? -1 : 1);
			}
			this.#onRender();
		} else if (final === "D") {
			this.#move(-1);
		} else if (final === "C") {
			this.#move(1);
		} else if (final === "H") {
			this.#cursor = 0;
			this.#reflow();
		} else if (final === "F") {
			this.#cursor = this.#chars.length;
			this.#reflow();
		}
	}

	// ---- editing ----

	#insert(cp: number): void {
		if (this.#historyIdx !== null) this.#historyIdx = null; // editing leaves the browse
		this.#chars.splice(this.#cursor, 0, cp);
		this.#cursor += 1;
		this.#reflow();
		if (!this.#pasting) this.#refreshMenu();
	}

	#backspace(): void {
		if (this.#cursor === 0) return;
		if (this.#historyIdx !== null) this.#historyIdx = null; // editing leaves the browse
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
		this.#chars.splice(0, this.#cursor);
		this.#cursor = 0;
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

	#killToEnd(): void {
		this.#chars.length = this.#cursor;
		this.#reflow();
		if (!this.#pasting) this.#onRender();
	}

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
		this.#menuOpen = false;
		this.#menuSel = 0;
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

	// ---- width-based horizontal scroll ----

	#reflow(): void {
		const W = (process.stdout.columns ?? 0) || 80; // degenerate 0 falls back to 80
		const maxW = Math.max(1, W - PROMPT_WIDTH - 1); // 1 col for the "…"
		const curCol = widthOf(this.#chars.slice(0, this.#cursor));
		const scrolledW = widthOf(this.#chars.slice(0, this.#scroll));
		if (curCol < scrolledW) {
			this.#scroll = this.#indexAtWidth(curCol);
		} else if (curCol >= scrolledW + maxW) {
			this.#scroll = this.#indexAtWidth(Math.max(0, curCol - maxW + 1));
		}
	}

	#indexAtWidth(target: number): number {
		let w = 0;
		for (let i = 0; i < this.#chars.length; i += 1) {
			if (w >= target) return i;
			w += charWidth(this.#chars[i]!);
		}
		return this.#chars.length;
	}
}
