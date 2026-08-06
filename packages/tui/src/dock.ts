/**
 * v2b/v2c — the bottom-anchored UI (TTY + color only). Borrows pi-tui's
 * IDEA — a DECSTBM scroll region with a reserved bottom — without its
 * implementation: zero dependencies, line-level ANSI, no differential
 * renderer.
 *
 * Layout (H = terminal height): rows 1..H-4 = the scroll region (the body
 * streams and scrolls here, never touching the bottom), row H-3 = the
 * upper dim dotted separator (╌), row H-2 = the input line (the blue
 * brick ▌you> + the v2c editor's row — readline is gone from the TTY
 * path), row H-1 = the lower dotted separator, row H = the live status
 * bar (v3 §03: idle "▸ <mode> · /mode to switch · …", running
 * "▖ working Ns · …"; a takeover question replaces it). Bottom redraws
 * are wrapped in CSI 2026 (synchronized output) to avoid flicker — the
 * pi trick. The visual identity is the kiso brick motif — ▌ half-block,
 * dotted separators — deliberately NOT the CC rounded frame nor the pi
 * editor (ADR-0039 Amendment 2).
 *
 * Pipes / NO_COLOR: the dock never activates; the v2a line mode stays
 * byte-for-byte (the existing e2e assertions guard it).
 */

import { displayWidth } from "./editor.js";
import { palette } from "./render.js";

export class Dock {
	#active = false;
	#height = 0;
	#width = 0;
	#status = "";
	#tail = ""; // the live tail: the spinner glyph or "running <tool> Ns"
	#question: string | null = null; // a takeover question shown at H-1
	#inputState: () => { line: string; cursor: number } = () => ({ line: "", cursor: 0 });
	#inputPrompt = "";
	#bodyRow = 1; // the body's logical row inside the scroll region
	#bodyCol = 1; // …and column (mid-line continuations survive cursor jumps)
	#resizeHandler: (() => void) | null = null;

	/** v2b: docked only on a color TTY — pipes and NO_COLOR stay v2a. */
	get active(): boolean {
		return this.#active;
	}

	/** Bind the CURRENT input line's state — called when a readline takes
	 *  over (the chat REPL, the trust question's short-lived rl, resume). */
	bindInput(state: () => { line: string; cursor: number }, prompt: string): void {
		this.#inputState = state;
		this.#inputPrompt = prompt;
	}

	/** Enter docked mode: draw the chrome. #13 (P1): the DECSTBM scroll
	 *  region is GONE — v2d-B (ADR-0040): the body uses plain LF scrolling
	 *  so frozen lines enter the native scrollback deterministically
	 *  (region-scrolled lines are terminal-dependent — some terminals drop
	 *  them). The dock rows are redrawn by the body after every scroll. A
	 *  TTY without a real window size (rows < 4) stays in the v2a line
	 *  mode — the bottom three rows need room to exist. */
	enter(): void {
		const rows = process.stdout.rows ?? 0;
		if (process.stdout.isTTY !== true || palette().bold === "" || rows < 4) return;
		this.#active = true;
		this.#height = rows;
		this.#width = process.stdout.columns ?? 80;
		this.#bodyRow = 1;
		this.#bodyCol = 1;
		this.redraw();
		this.#resizeHandler = () => this.onResize();
		process.stdout.on("resize", this.#resizeHandler);
	}

	/** Teardown — CSI r resets the scroll region, the cursor lands at the
	 *  input line, the bottom rows are cleared: no broken terminal. Called
	 *  from main's finally on EVERY exit path (kill -9 excepted — README:
	 *  `reset` saves it). */
	exit(): void {
		if (!this.#active) return;
		this.#active = false;
		if (this.#resizeHandler !== null) {
			process.stdout.off("resize", this.#resizeHandler);
			this.#resizeHandler = null;
		}
		const H = this.#height;
		process.stdout.write("\x1b[r"); // reset the scroll region
		for (let row = H - 3; row <= H; row += 1) {
			process.stdout.write(`\x1b[${row};1H\x1b[0K`); // clear the four rows
		}
		process.stdout.write(`\x1b[${H};1H`);
	}

	/** SIGWINCH: recompute the size, redraw the chrome. */
	onResize(): void {
		if (!this.#active) return;
		this.#height = process.stdout.rows ?? this.#height;
		this.#width = process.stdout.columns ?? this.#width;
		this.redraw();
	}

	#menuState: (() => { items: readonly import("./editor.js").MenuItem[]; selected: number } | null) | null = null;

	/** v3 §04: bind the editor's slash-command menu state — the menu rows
	 *  render ABOVE the chrome (over the body's bottom rows; the menu
	 *  opens while the buffer is a "/" prefix, when no tail is live). */
	bindMenu(state: () => { items: readonly import("./editor.js").MenuItem[]; selected: number } | null): void {
		this.#menuState = state;
	}

	/** The input line's edit column — prompt width + cursor + 1. The
	 *  dock's redraw and the body's cursor return both end here, so the
	 *  ACTUAL cursor always equals what the editor tracks. The width is
	 *  DISPLAY width (the editor's cursor column is already width-based —
	 *  the CJK drift root cause, editor.ts). v2d: public — the Body's
	 *  render loop ends at this column. */
	editCol(): number {
		return this.#inputCol();
	}

	#inputCol(): number {
		const inp = this.#inputState();
		const promptWidth = displayWidth(this.#inputPrompt.replace(/\x1b\[[0-9;]*m/g, ""));
		return promptWidth + inp.cursor + 1;
	}

	/** The status bar's base text (usage, ctx, session, …). */
	setStatus(text: string): void {
		this.#status = text;
		this.redraw();
	}

	/** The live tail — the spinner glyph or "running <tool> Ns". */
	setTail(tail: string): void {
		this.#tail = tail;
		this.redraw();
	}

	/** Show a takeover question at the status position (answered at the
	 *  input line by the caller's readline); clearQuestion() restores. */
	showQuestion(question: string): void {
		this.#question = question;
		this.redraw();
	}

	clearQuestion(): void {
		this.#question = null;
		this.redraw();
	}

	/** The bottom four rows, wrapped in CSI 2026 (synchronized output —
	 *  the pi trick against flicker). The cursor ends at the input line's
	 *  edit position. v3 §03: the upper ╌ row, the input row, the lower
	 *  ╌ row, the status row — the status is dim (bold accents inside
	 *  come from the CLI's composition). TUI v5 #16g: the idle status
	 *  row carries the right-aligned "/ commands · ↑ history" hint. */
	redraw(): void {
		if (!this.#active) return;
		const p = palette();
		const H = this.#height;
		const W = this.#width;
		const sep = `${p.dim}${"╌".repeat(W)}${p.reset}`;
		const status = `${this.#status}${this.#tail === "" ? "" : ` · ${this.#tail}`}`;
		const statusLine = this.#question ?? this.#statusRow(status, p, W);
		const inp = this.#inputState();
		const out: string[] = [];
		// P3 (审查): the DEC private-mode SET/RESET needs the "?" prefix —
		// \x1b[?2026h/l, the pi source's exact form. Without it terminals
		// silently ignore the mode and the anti-flicker never engages.
		out.push("\x1b[?2026h"); // synchronized output ON (DEC 2026)
		// v3 §04: the slash-command menu — above the chrome, one row per
		// filtered command, the selection highlighted. Drawn first so the
		// chrome rows repaint on top of any overlap.
		const menu = this.#menuState?.();
		if (menu !== null && menu !== undefined) {
			for (let i = 0; i < menu.items.length; i += 1) {
				const item = menu.items[i]!;
				const row = H - 4 - (menu.items.length - 1 - i);
				const text =
					i === menu.selected
						? `${p.bold}▸ ${item.name}${p.reset} ${item.desc}`
						: `${p.dim}  ${item.name} ${item.desc}${p.reset}`;
				out.push(`\x1b[${row};1H\x1b[0K${text}`);
			}
		}
		out.push(`\x1b[${H - 3};1H\x1b[0K${sep}`);
		out.push(`\x1b[${H - 2};1H\x1b[0K${this.#inputPrompt}${inp.line}`);
		out.push(`\x1b[${H - 1};1H\x1b[0K${sep}`);
		out.push(`\x1b[${H};1H\x1b[0K${statusLine}`);
		out.push(`\x1b[${H - 2};${this.#inputCol()}H`); // back to the edit position
		out.push("\x1b[?2026l"); // synchronized output OFF
		process.stdout.write(out.join(""));
	}

	/** TUI v5 #16g: the status row — the base status left-aligned, the
	 *  "/ commands · ↑ history" hint right-aligned in the idle state
	 *  (tail empty, no takeover question). The hint is CUT FIRST when
	 *  the width is short — the status itself is never truncated for it;
	 *  the running state carries its own esc hint in the status text, so
	 *  the non-empty tail suppresses this one. */
	#statusRow(status: string, p: ReturnType<typeof palette>, W: number): string {
		const hint = this.#tail === "" && this.#question === null ? " / commands · ↑ history" : "";
		if (hint === "") return `${p.dim}${status}${p.reset}`;
		const statusW = displayWidth(status.replace(/\x1b\[[0-9;]*m/g, ""));
		const hintW = displayWidth(hint);
		if (statusW + hintW > W) return `${p.dim}${status}${p.reset}`;
		return `${p.dim}${status}${" ".repeat(W - statusW - hintW)}${hint}${p.reset}`;
	}
}
