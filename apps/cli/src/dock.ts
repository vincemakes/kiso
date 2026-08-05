/**
 * v2b/v2c — the bottom-anchored UI (TTY + color only). Borrows pi-tui's
 * IDEA — a DECSTBM scroll region with a reserved bottom — without its
 * implementation: zero dependencies, line-level ANSI, no differential
 * renderer.
 *
 * Layout (H = terminal height): rows 1..H-3 = the scroll region (the body
 * streams and scrolls here, never touching the bottom), row H-2 = the dim
 * dotted separator (╌), row H-1 = the live status bar (or a takeover
 * question), row H = the input line (the blue brick ▌you> + the v2c
 * editor's row — readline is gone from the TTY path). Bottom redraws are
 * wrapped in CSI 2026 (synchronized output) to avoid flicker — the pi
 * trick. The visual identity is the kiso brick motif — ▌ half-block,
 * dotted separator — deliberately NOT the CC rounded frame nor the pi
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

	/** Enter docked mode: DECSTBM the scroll region, draw the chrome. A
	 *  TTY without a real window size (rows < 4) stays in the v2a line
	 *  mode — the bottom three rows need room to exist. */
	enter(): void {
		const rows = process.stdout.rows ?? 0;
		if (process.stdout.isTTY !== true || palette().blue === "" || rows < 4) return;
		this.#active = true;
		this.#height = rows;
		this.#width = process.stdout.columns ?? 80;
		this.#bodyRow = 1;
		this.#bodyCol = 1;
		process.stdout.write(`\x1b[1;${this.#height - 3}r`); // scroll region: top .. H-3
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
		for (let row = H - 2; row <= H; row += 1) {
			process.stdout.write(`\x1b[${row};1H\x1b[0K`); // clear the three rows
		}
		process.stdout.write(`\x1b[${H};1H`);
	}

	/** SIGWINCH: recompute the region, redraw the chrome. */
	onResize(): void {
		if (!this.#active) return;
		this.#height = process.stdout.rows ?? this.#height;
		this.#width = process.stdout.columns ?? this.#width;
		process.stdout.write(`\x1b[1;${this.#height - 3}r`);
		this.redraw();
	}

	/** Body output: position the cursor inside the scroll region at the
	 *  body's tracked position, write, and hand the cursor back to the
	 *  input line's EDIT position. The row/col tracking is approximate for
	 *  width-wrapped and wide-char lines (documented) — the region clamp
	 *  keeps the bottom rows safe regardless.
	 *
	 *  The edit-position return is a correctness requirement, not
	 *  cosmetics: readline tracks its cursor internally and NEVER
	 *  re-syncs after an external move — a body write that left the
	 *  cursor at column 1 made the next keystroke overwrite the prompt
	 *  (probe-confirmed; the dock's redraw self-repaired ~200ms later,
	 *  which read the user as cursor drift). */
	writeBody(text: string): void {
		if (!this.#active) {
			process.stdout.write(text);
			return;
		}
		const row = Math.min(this.#bodyRow, this.#height - 3);
		const col = this.#bodyCol > this.#width ? this.#width : this.#bodyCol;
		process.stdout.write(`\x1b[${row};${col}H`);
		process.stdout.write(text);
		for (const ch of text) {
			if (ch === "\n") {
				this.#bodyRow += 1;
				this.#bodyCol = 1;
			} else {
				this.#bodyCol += 1;
			}
		}
		process.stdout.write(`\x1b[${this.#height};${this.#inputCol()}H`); // back to the edit position
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

	/** The bottom three rows, wrapped in CSI 2026 (synchronized output —
	 *  the pi trick against flicker). The cursor ends at the input line's
	 *  edit position. v2c: the separator is the dim dotted ╌ (a weaker
	 *  presence than the solid ─), the status line is dim (blue accents
	 *  inside come from the CLI's composition), the input row is the blue
	 *  brick ▌you> + the editor's visible slice. */
	redraw(): void {
		if (!this.#active) return;
		const p = palette();
		const H = this.#height;
		const W = this.#width;
		const sep = `${p.dim}${"╌".repeat(W)}${p.reset}`;
		const status = `${this.#status}${this.#tail === "" ? "" : ` · ${this.#tail}`}`;
		const statusLine = this.#question ?? `${p.dim}${status}${p.reset}`;
		const inp = this.#inputState();
		const out: string[] = [];
		// P3 (审查): the DEC private-mode SET/RESET needs the "?" prefix —
		// \x1b[?2026h/l, the pi source's exact form. Without it terminals
		// silently ignore the mode and the anti-flicker never engages.
		out.push("\x1b[?2026h"); // synchronized output ON (DEC 2026)
		out.push(`\x1b[${H - 2};1H\x1b[0K${sep}`);
		out.push(`\x1b[${H - 1};1H\x1b[0K${statusLine}`);
		out.push(`\x1b[${H};1H\x1b[0K${this.#inputPrompt}${inp.line}`);
		out.push(`\x1b[${H};${this.#inputCol()}H`); // back to the edit position
		out.push("\x1b[?2026l"); // synchronized output OFF
		process.stdout.write(out.join(""));
	}
}
