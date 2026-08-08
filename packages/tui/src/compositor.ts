/**
 * TUI v6 (ADR-0046) — THE one-compositor: every byte of the screen's
 * stdout comes from this file's doRender. `body.ts` + `dock.ts` are
 * RETIRED — this class implements BOTH façades (the `Body` mutations
 * the CLI's consumeRun calls, and the `Dock` chrome API), so the CLI
 * itself is untouched (zero diff outside the tui package + tests).
 *
 * The model:
 *  - cells (the CLI's mutation surface) → components → lines;
 *  - `lines[] + commitIndex` (the scrollback fork — the departure from
 *    pi): a line COMMITS (leaves the live region) via the real-LF
 *    scroll at the last row (`\x1b[1B\n` — CUP-free) when its cell is
 *    DONE and the region needs the room. Committed bytes are never
 *    re-emitted — the native scrollback gets them, reflow-safe, and
 *    the user's shell history is never touched (zero \x1b[3J, zero
 *    replay);
 *  - the live region (content + chrome + menu) is hard-capped: the
 *    content at H−4 (V6-3 — the four-row chrome); overflow FORCE-
 *    commits the oldest live line regardless of done-ness — the one
 *    sharp edge (asserted by the VT-emulator gate);
 *  - two crash invariants: ① every emitted line's visible width ≤ W
 *    (components fold; a violation THROWS with diagnostics — pi
 *    tui-main-screen.ts:447-473, no silent truncate); ② every steady-
 *    frame CUP lands in the CONTENT area (rows ≤ H−4−menu — the
 *    committed band, the stale/gap ELs, and the LIVE lines at their
 *    model rows; fix C's sanctioned reinterpretation, ADR-0046) — the
 *    CHROME rows (H−3..H) are RELATIVE-only (vertical A/B, horizontal
 *    G/D); CUP over the whole screen exists only in the full-redraw
 *    path (the first frame, the resize repaint);
 *  - the cursor DERIVES from the frame: the focus component embeds the
 *    APC marker in its rendered line; the compositor locates, strips,
 *    and relatively positions from the frame — no side-channel cursor
 *    bookkeeping that could desync from the picture;
 *  - zero timers: the spinner animation is a dirty flag through the
 *    scheduler — a one-shot setTimeout re-armed only while a running
 *    tool exists (the #14/#15 zero-output contract is structural).
 *
 * Layout at H rows (V6-3 — the design §03 chrome): content rows
 * 1..H−4, upper ╌ H−3, editor (the slot) H−2, lower ╌ H−1, status H.
 * Pipes / NO_COLOR: the passthrough branches below keep the v2a/v2b
 * line-mode bytes byte-for-byte (the e2e guards them).
 */

import { truncateDiff } from "./diff.js";
import { displayWidth, type MenuItem } from "./editor.js";
import {
	Container,
	SPINNER,
	cellComponent,
	foldLine,
	footerLine,
	statusLine,
	visibleWidth,
	type BodyCell,
	type FrameCtx,
} from "./components.js";
import { bannerLines, escapeTerminal, foldResult, foldThinking, palette, renderTerminalGap, renderToolSummary } from "./render.js";

/** The cursor marker — an APC private sequence the focus component
 *  embeds at the edit position; the compositor strips it and moves
 *  relatively (it never reaches the terminal). */
export const CURSOR_MARKER = "\x1b_[kiso-cur]\x1b\\";

const FRAME_MS = 16; // state changes coalesce to ≥16ms frames
const SPINNER_MS = 200; // the spinner cadence — a ONE-SHOT re-armed on demand
const CHROME_ROWS = 4; // upper ╌ + input + lower ╌ + status — the design §03 chrome (V6-3)

export interface BodyOptions {
	/** Is the cell renderer live? A color TTY with a real size — checked
	 *  per mutation (the TIOCSWINSZ can land after main constructs us). */
	active: () => boolean;
	/** The terminal height (rows) — live, for the region geometry. */
	height: () => number;
	/** The terminal width (cols) — live, for wrap estimates. */
	width: () => number;
	/** v6: RETIRED — the cursor derives from the frame's marker. Kept in
	 *  the interface so the CLI's construction is untouched. */
	editCol: () => number;
	/** v6: RETIRED — the compositor draws the chrome itself. Same. */
	onDock?: () => void;
	/** The stdout writer — injectable for unit tests (default: stdout). */
	write?: (s: string) => void;
}

/** The one compositor — implements the Body façade AND the Dock chrome
 *  API (see the class comments on each method group). */
export class Body {
	#opts: BodyOptions;
	#cells: BodyCell[] = [];
	#lineCache: (string[] | null)[] = []; // the committed cells' rendered lines (immutable)
	#committed = 0; // the count of leading cells fully committed
	#committedLines = 0; // their total line count (incremental — O(1) per frame)
	#active = false;
	#docked = false;
	#dirty = false;
	#fullRedraw = false; // the first frame / resize — the CUP path
	#lastLiveTop = 0; // the recorded live region top — the resize clear starts here
	#lastLiveRows = 0; // the recorded live row count (incl. the chrome)
	#lastH = 0;
	#frameTimer: NodeJS.Timeout | null = null;
	#spinnerTimer: NodeJS.Timeout | null = null;
	#spinnerI = 0;
	#lastThinking: string | null = null;
	#lastTool: { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } } | null = null;
	#pendingCalls = new Map<string, { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } }>();
	#pipeBuf = ""; // the passthrough's thinking buffer
	#toolCells = new Map<string, number>(); // callId → cell index (parallel tools)
	#write: (s: string) => void;
	#resizeHandler: (() => void) | null = null;
	// the chrome state (the Dock façade)
	#status = "";
	#tail = "";
	#question: string | null = null;
	#inputState: () => { line: string; cursor: number } = () => ({ line: "", cursor: 0 });
	#inputPrompt = "";
	#menuState: (() => { items: readonly MenuItem[]; selected: number } | null) | null = null;

	constructor(opts: BodyOptions) {
		this.#opts = opts;
		this.#write = opts.write ?? ((s) => process.stdout.write(s));
		this.#active = opts.active();
		// v6: the single writer — the compositor IS the dock; the CLI's
		// onDock callback (which used to re-pin the dock after a scroll)
		// is retired with the split.
		compositorRef = this;
		// the Dock façade's bindings may arrive BEFORE this construction
		// (the CLI binds the editor state in makeLineInput, then constructs
		// the Body) — the buffered bindings apply here, or the input row
		// would never render the typed line.
		if (dockBindings !== null) {
			this.#inputState = dockBindings.state;
			this.#inputPrompt = dockBindings.prompt;
			this.#menuState = dockBindings.menu;
			dockBindings = null;
		}
	}

	/** Live re-check — a TTY whose size lands after construction flips in. */
	#isActive(): boolean {
		this.#active = this.#opts.active();
		return this.#active;
	}

	// ---- the Body façade: mutations (the ONLY way the CLI touches state) ----

	userLine(text: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const p = palette();
			this.#write(`${p.bold}you> ${escapeTerminal(text)}${p.reset}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "user", text, done: true });
		this.#mark();
	}

	thinkingAppend(text: string): void {
		if (!this.#isActive()) {
			this.#pipeBuf += text; // buffered; the fold prints at the block's end
			return;
		}
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "thinking" && !last.done) {
			last.text += text;
		} else {
			this.#cells.push({ kind: "thinking", text, done: false });
		}
		this.#mark();
	}

	thinkingEnd(): void {
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "thinking" && !last.done) {
			last.done = true;
			this.#lastThinking = last.text;
			if (!this.#isActive()) this.#write(foldThinking(last.text));
			this.#mark();
		}
	}

	toolStart(name: string, callId: string, input: Record<string, unknown>): void {
		const summary = JSON.stringify(input).slice(0, 60);
		this.#pendingCalls.set(callId, { name, input, result: { content: "", isError: false } });
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#write(`→ ${escapeTerminal(name)}(${escapeTerminal(JSON.stringify(input).slice(0, 200))})\n`);
			return;
		}
		this.#toolCells.set(callId, this.#cells.length);
		this.#cells.push({ kind: "tool", name, input: summary, state: "pending", isError: false, resultText: "", diff: null, added: 0, removed: 0, startedAt: null, doneAt: null, done: false });
		this.#mark();
	}

	toolApproval(callId: string, diff: import("./diff.js").DiffResult | null): void {
		if (!this.#isActive()) return;
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) {
			cell.state = "approval";
			cell.diff = diff === null ? null : truncateDiff(diff.lines);
			cell.added = diff?.added ?? 0;
			cell.removed = diff?.removed ?? 0;
		}
		this.#mark();
	}

	toolRunning(callId: string): void {
		if (!this.#isActive()) {
			const p = palette();
			this.#write(`${p.dim}  running…${p.reset}\n`);
			return;
		}
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) {
			cell.state = "running";
			cell.startedAt = Date.now();
			this.#armSpinner();
		}
		this.#mark();
	}

	toolSucceeded(callId: string): void {
		if (!this.#isActive()) this.#write("  ok\n");
	}

	toolFailed(callId: string, error: string): void {
		if (!this.#isActive()) {
			const p = palette();
			this.#write(`${p.red}  failed: ${escapeTerminal(error.slice(0, 160))}${p.reset}\n`);
		}
	}

	toolResult(callId: string, result: { content: string; isError: boolean }): void {
		const call = this.#pendingCalls.get(callId);
		if (call !== undefined) {
			call.result = result;
			this.#lastTool = { name: call.name, input: call.input, result };
			this.#pendingCalls.delete(callId);
		}
		if (!this.#isActive()) {
			const p = palette();
			this.#write(
				`${renderToolSummary(call?.name ?? "?", call?.input ?? {}, result)}\n` +
					`${p.dim}${result.isError ? p.red : p.dim}  [result${result.isError ? " ✗" : ""}] ${foldResult(result.content)}${p.reset}\n`,
			);
			return;
		}
		const cell = this.#toolCell(callId);
		this.#toolCells.delete(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) {
			cell.state = "done";
			cell.isError = result.isError;
			cell.resultText = result.content;
			cell.doneAt = Date.now();
			cell.done = true;
		}
		this.#mark();
	}

	textAppend(text: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#write(escapeTerminal(text));
			return;
		}
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "text" && !last.done) {
			last.text += text;
		} else {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#cells.push({ kind: "text", text, done: false });
		}
		this.#mark();
	}

	textEnd(): void {
		if (!this.#isActive()) {
			this.#write("\n");
			return;
		}
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "text" && !last.done) last.done = true;
		this.#mark();
	}

	terminal(label: string, statusLineText: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#write(label + renderTerminalGap(statusLineText));
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "terminal", label: label.trim(), line: statusLineText, done: true });
		this.#mark();
	}

	notice(text: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#write(`${text}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "notice", text, done: true });
		this.#mark();
	}

	checklist(header: string, items: { text: string; status: "pending" | "active" | "done" }[]): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const p = palette();
			this.#write(`${p.bold}▞${p.reset} ${escapeTerminal(header)}\n`);
			const glyphOf = (status: string): string => (status === "pending" ? "□" : status === "active" ? "▖" : "▣");
			for (const item of items) this.#write(`  ${glyphOf(item.status)} ${escapeTerminal(item.text)}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "checklist", header, items, done: true });
		this.#mark();
	}

	/** The startup banner (W1): a LIVE cell — the tier re-derives per
	 *  frame (bannerLines with the CURRENT W and H), so a resize re-tiers
	 *  the art instead of re-folding frozen rows (a window below 40 cols
	 *  never paints the logo). Byte-identical to the old frozen banner at
	 *  the startup size (dim rows + the trailing blank). */
	banner(version: string, extensionsText: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const W = this.#opts.width() || 80; // a 0-size pty falls back
			const H = this.#opts.height();
			const p = palette();
			for (const r of bannerLines(W, H, version, extensionsText)) this.#write(`${p.dim}${r}${p.reset}\n`);
			this.#write("\n");
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "banner", version, extensionsText, done: true });
		this.#mark();
	}

	raw(lines: string[]): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			for (const line of lines) this.#write(`${line}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "raw", lines, done: true });
		this.#mark();
	}

	/** The last COMPLETE thinking block, for /think. */
	lastThinking(): string | null {
		return this.#lastThinking;
	}

	/** The last completed tool call, for /last. */
	lastTool(): { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } } | null {
		return this.#lastTool;
	}

	// ---- the Dock façade (the CLI's chrome API — same shape as the old dock) ----

	/** Docked = the chrome is live (a color TTY with a real size). */
	get active(): boolean {
		return this.#docked && this.#isActive();
	}

	enter(): void {
		const rows = process.stdout.rows ?? 0;
		if (process.stdout.isTTY !== true || palette().bold === "" || rows < 4) return;
		this.#docked = true;
		this.#resizeHandler = () => this.onResize();
		process.stdout.on("resize", this.#resizeHandler);
		this.#fullRedraw = true;
		this.#dirty = true;
		this.render(); // the FIRST frame — the full-redraw path, no pre-clear
	}

	/** Teardown — CSI r (the "no broken terminal" contract byte), the
	 *  chrome rows cleared, the cursor home at the input line. */
	exit(): void {
		if (!this.#docked) return;
		this.#docked = false;
		if (this.#resizeHandler !== null) {
			process.stdout.off("resize", this.#resizeHandler);
			this.#resizeHandler = null;
		}
		const H = this.#lastH > 0 ? this.#lastH : process.stdout.rows ?? 24;
		const out: string[] = [];
		out.push("\x1b[r");
		for (let row = H - 3; row <= H; row += 1) { // V6-3: the four chrome rows
			out.push(`\x1b[${row};1H\x1b[0K`); // clear the three chrome rows
		}
		out.push(`\x1b[${Math.max(1, H - 1)};1H`);
		this.#write(out.join(""));
	}

	/** SIGWINCH: clear the OLD live area (recorded geometry, ED only —
	 *  zero LF, zero \x1b[3J — the shell history untouched), then the
	 *  full-redraw path at the NEW geometry (O(height), zero replay).
	 *  The clear starts at the ON-SCREEN live top (the bottom-anchored
	 *  live region's first row) — NEVER at the formula's committed-count
	 *  top: external writes (the CLI's console.error CRLF) can shift the
	 *  committed content down, and a formula-top ED0 would clear it. */
	onResize(): void {
		if (!this.#isActive()) return;
		const H = this.#opts.height();
		const liveRows = this.#lastLiveRows > 0 ? this.#lastLiveRows : 3;
		const from = Math.max(1, (this.#lastH > 0 ? this.#lastH : H) - liveRows + 1);
		this.#write(`\x1b[${Math.min(from, Math.max(1, H))};1H\x1b[0J`);
		this.#fullRedraw = true;
		this.#dirty = true;
		this.render(); // the immediate redraw at the NEW geometry
	}

	setStatus(text: string): void {
		this.#status = text;
		this.redraw();
	}

	setTail(tail: string): void {
		this.#tail = tail;
		this.redraw();
	}

	showQuestion(question: string): void {
		this.#question = question;
		this.redraw();
	}

	clearQuestion(): void {
		this.#question = null;
		this.redraw();
	}

	/** Bind the CURRENT input line's state — the focus component reads it. */
	bindInput(state: () => { line: string; cursor: number }, prompt: string): void {
		this.#inputState = state;
		this.#inputPrompt = prompt;
	}

	/** Bind the editor's slash-command menu state — the MenuSelect slot
	 *  occupant (the menu replaces the editor's view while open). */
	bindMenu(state: () => { items: readonly MenuItem[]; selected: number } | null): void {
		this.#menuState = state;
	}

	/** The input line's edit column — the old dock's API. v6: the CURSOR
	 *  derives from the frame's marker; this is the same value computed
	 *  from the bound input state (the CLI's BodyOptions.editCol callback
	 *  reads it — the marker math never desyncs by construction). */
	editCol(): number {
		const inp = this.#inputState();
		return displayWidth(this.#inputPrompt.replace(/\x1b\[[0-9;]*m/g, "")) + inp.cursor + 1;
	}

	/** The old dock's redraw — the editor's onRender target: mark + the
	 *  scheduler (16ms coalescing — the old sync draw coalesces the same). */
	redraw(): void {
		if (!this.#isActive()) return;
		this.#dirty = true;
		this.#scheduleFrame();
	}

	// ---- the scheduler (event-driven; zero heartbeat timers) ----

	#mark(): void {
		if (!this.#isActive()) return;
		this.#dirty = true;
		this.#scheduleFrame();
	}

	#scheduleFrame(): void {
		if (this.#frameTimer !== null) return;
		this.#frameTimer = setTimeout(() => {
			this.#frameTimer = null;
			if (this.#dirty) {
				this.#dirty = false;
				this.render();
			}
		}, FRAME_MS);
		this.#frameTimer.unref();
	}

	/** The spinner: a ONE-SHOT re-armed ONLY while a running tool exists —
	 *  no tool → no timer → zero bytes (the #14/#15 contract, structural). */
	#armSpinner(): void {
		if (this.#spinnerTimer !== null) return;
		this.#spinnerTimer = setTimeout(() => {
			this.#spinnerTimer = null;
			if (this.#cells.some((c) => c.kind === "tool" && c.state === "running" && !c.done)) {
				this.#spinnerI = (this.#spinnerI + 1) % SPINNER.length;
				this.#dirty = true;
				this.#scheduleFrame();
				this.#armSpinner();
			}
		}, SPINNER_MS);
		this.#spinnerTimer.unref();
	}

	/** Teardown — flush a pending frame, stop the timers. */
	close(): void {
		if (this.#frameTimer !== null) {
			clearTimeout(this.#frameTimer);
			this.#frameTimer = null;
		}
		if (this.#spinnerTimer !== null) {
			clearTimeout(this.#spinnerTimer);
			this.#spinnerTimer = null;
		}
		if (this.#dirty) this.render();
	}

	// ---- the one writer ----

	/** The live region's scalar — the unit tests assert the cap directly
	 *  (the e2e gate pins the screen consequence). */
	liveCount(): number {
		const live = this.#cells.slice(this.#committed);
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const W = this.#opts.width();
		let lines = 0;
		for (const cell of live) lines += cellComponent(cell).render(W, ctx).length;
		return lines + CHROME_ROWS + this.#menuRows(W).length;
	}

	/** The lines committed THIS frame — the writes land in the frame's
	 *  committed section (the rows just above the live region). */
	#committedLinesThisFrame: string[] = [];

	render(): void {
		if (!this.#isActive()) return;
		const H = this.#opts.height();
		const W = this.#opts.width();
		if (H < 4) return;
		this.#lastH = H;
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: H };
		// V6-1 (the screen-state == frame-state rule): the resize's first
		// frame — the terminal's reflow re-wrapped the committed content at
		// the NEW width, so the cached folds are stale. Re-fold the
		// committed cells so the every-row draw below re-paints them at the
		// current geometry — the frame's model and the screen agree.
		if (this.#fullRedraw) {
			this.#lineCache = this.#lineCache.map(() => null);
			this.#committedLines = 0;
			for (let i = 0; i < this.#committed; i += 1) {
				const cell = this.#cells[i]!;
				const lines = cellComponent(cell).render(W, ctx);
				this.#lineCache[i] = lines;
				this.#committedLines += lines.length;
			}
		}
		// 1. the natural commits — the leading DONE cells freeze: their
		//    lines leave the live region, the scrolls + the committed
		//    writes below place them (the #17 "freeze as a real line",
		//    short sessions included — the frame coalescing keeps a
		//    cell's first frame its freeze frame, so the frozen bytes
		//    emit exactly once).
		this.#committedLinesThisFrame = [];
		while (this.#committed < this.#cells.length && this.#cells[this.#committed]!.done) {
			this.#commitCell(this.#committed, W, ctx);
		}
		// 2. the live lines — the unfinished cells (the tail) + the chrome.
		const menuRows = this.#menuRows(W);
		const chromeRows = CHROME_ROWS + menuRows.length;
		let liveLines: string[] = [];
		for (const cell of this.#cells.slice(this.#committed)) {
			liveLines.push(...cellComponent(cell).render(W, ctx));
		}
		// 3. the FORCE commits — the live region's hard cap H−1: overflow
		//    commits the oldest live cell UNCONDITIONALLY (the one sharp
		//    edge — the cap scalar is asserted by the gates).
		while (liveLines.length > H - 4 && this.#committed < this.#cells.length) { // V6-3: the content cap H−4
			this.#commitCell(this.#committed, W, ctx);
			liveLines = [];
			for (const cell of this.#cells.slice(this.#committed)) {
				liveLines.push(...cellComponent(cell).render(W, ctx));
			}
		}
		// 4. the geometry — the live region's first row:
		//    liveTop = min(totalCommitted, H - liveRows) + 1 — the screen
		//    shows the bottom H rows; the live region anchors to the bottom.
		const liveRowsTotal = liveLines.length + chromeRows;
		const liveTop = Math.min(this.#committedLines, H - liveRowsTotal) + 1;
		// 5. the frame bytes.
		const out: string[] = [];
		out.push("\x1b[?2026h"); // synchronized output ON (DEC 2026)
		if (this.#fullRedraw) {
			this.#drawFull(out, W, H, liveTop, liveLines, menuRows, ctx);
			this.#fullRedraw = false;
		} else {
			this.#drawSteady(out, W, H, liveTop, liveLines, menuRows, ctx);
		}
		out.push("\x1b[?2026l");
		this.#write(out.join(""));
		this.#lastLiveTop = liveTop;
		this.#lastLiveRows = liveRowsTotal;
	}

	/** Commit the cell at index i: render + cache its lines (immutable —
	 *  the force-committed form freezes at the current render), advance
	 *  the bookkeeping — and collect the lines for this frame's writes.
	 *  Pure accounting + the write list; the BYTES emit in the frame. */
	#commitCell(i: number, W: number, ctx: FrameCtx): void {
		const cell = this.#cells[i]!;
		const lines = cellComponent(cell).render(W, ctx);
		this.#lineCache[i] = lines;
		this.#committed += 1;
		this.#committedLines += lines.length;
		this.#committedLinesThisFrame.push(...lines);
	}

	/** The slot occupant's extra rows — the slash-command menu (above the
	 *  status, in the rhythm gap + the content's spare rows — the old
	 *  menu's position, slot-shaped). */
	#menuRows(W: number): string[] {
		const menu = this.#menuState?.();
		if (menu === null || menu === undefined || menu.items.length === 0) return [];
		const p = palette();
		const rows: string[] = [];
		for (let i = 0; i < menu.items.length; i += 1) {
			const item = menu.items[i]!;
			const text =
				i === menu.selected
					? `${p.bold}▸ ${item.name}${p.reset} ${item.desc}`
					: `${p.dim}  ${item.name} ${item.desc}${p.reset}`;
			rows.push(...foldLine(text, W));
		}
		return rows;
	}

	/** The focus component's input row — the marker embedded at the
	 *  cursor's display column WITHIN THE ROW (the brick/question lead
	 *  included), the question/editor/menu variants. The compositor
	 *  strips the marker and moves LEFT by the trailing width — the
	 *  cursor derives from the frame, never from side-channel math. */
	#inputRow(W: number, _ctx: FrameCtx): { stripped: string; afterW: number } {
		const st = this.#inputState();
		let row: string;
		if (this.#question !== null) {
			// the ApprovalPrompt occupant — the question IS the prompt (the
			// slot swap; the brick returns when the question clears)
			row = `${this.#question}${st.line}`;
		} else {
			row = `${this.#inputPrompt}${st.line}`;
		}
		// the lead (the prompt / the question) width — the marker's row
		// column = leadW + the line cursor (the dockState cursor counts
		// within the line only)
		const leadW = visibleWidth(row.slice(0, row.length - st.line.length));
		// embed the marker at the cursor's display column
		let markerLine = "";
		{
			let w = 0;
			let inserted = false;
			let i = 0;
			while (i < row.length) {
				if (row[i] === "\x1b") {
					const m = /^\x1b\[[0-9;]*m/.exec(row.slice(i));
					if (m !== null) {
						markerLine += m[0];
						i += m[0].length;
						continue;
					}
				}
				if (!inserted && w >= leadW + st.cursor) {
					markerLine += CURSOR_MARKER;
					inserted = true;
				}
				const cw = displayWidth(row[i]!);
				markerLine += row[i]!;
				w += cw;
				i += 1;
			}
			if (!inserted) {
				markerLine += CURSOR_MARKER;
			}
		}
		const stripped = markerLine.replace(CURSOR_MARKER, "");
		const afterW = visibleWidth(markerLine.slice(markerLine.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length));
		return { stripped, afterW };
	}

	/** The full-redraw path (the first frame, the resize repaint) — CUP
	 *  allowed here; zero LF; zero \x1b[3J; zero replay. The committed
	 *  lines (this frame's) write at [liveTop−N .. liveTop−1].
	 *
	 *  V6-1 (the screen-state == frame-state rule): every row 1..H is
	 *  covered — the committed/live/chrome writes AND the EL-only rows
	 *  (above the committed section, the gap). The terminal's reflow
	 *  re-wraps the old content at the new size — its shifted copies
	 *  survive anywhere the draw does not touch; a draw that covers
	 *  EVERY row is idempotent: N consecutive resizes end with the same
	 *  screen as a single jump to the same size. */
	#drawFull(out: string[], W: number, H: number, liveTop: number, liveLines: string[], menuRows: string[], ctx: FrameCtx): void {
		const committed = this.#committedLinesThisFrame;
		// 0. the FROZEN rows — the re-folded committed content (re-flowed
		//    at the new width by the terminal): re-painted at [1..frozen],
		//    so the reflow's shifted copies can never ghost.
		const frozen = this.#lineCache.slice(0, this.#committed - committed.length).flat().filter((l): l is string => l !== null);
		let r = 1;
		for (const line of frozen) {
			out.push(`\x1b[${r};1H\x1b[0K${this.#checked(line, W)}`);
			r += 1;
		}
		// 1. the committed lines (this frame's).
		for (const line of committed) {
			out.push(`\x1b[${r};1H\x1b[0K${this.#checked(line, W)}`);
			r += 1;
		}
		// 2. the live lines.
		for (const line of liveLines) {
			out.push(`\x1b[${r};1H\x1b[0K${this.#checked(line, W)}`);
			r += 1;
		}
		// 3. the GAP rows (between the live content and the chrome) — EL.
		for (let rr = r; rr <= H - 4; rr += 1) {
			out.push(`\x1b[${rr};1H\x1b[0K`);
		}
		const menuTop = H - 3 - menuRows.length;
		for (let i = 0; i < menuRows.length; i += 1) {
			out.push(`\x1b[${menuTop + i};1H\x1b[0K${this.#checked(menuRows[i]!, W)}`);
		}
		// V6-3: the design §03 chrome — upper ╌ (H−3), input (H−2),
		// lower ╌ (H−1), status (H).
		out.push(`\x1b[${H - 3};1H\x1b[0K${footerLine(W)}`);
		const editor = this.#inputRow(W, ctx);
		out.push(`\x1b[${H - 2};1H\x1b[0K${this.#checked(editor.stripped, W)}`);
		out.push(`\x1b[${H - 1};1H\x1b[0K${footerLine(W)}`);
		out.push(`\x1b[${H};1H\x1b[0K${this.#checked(statusLine(this.#status, this.#tail, this.#question !== null, W), W)}`);
		// the cursor: up two (the input row at H−2) + left to the marker
		out.push("\x1b[2A");
		if (editor.afterW > 0) out.push(`\x1b[${editor.afterW}D`);
	}

	/** The steady-state frame — RELATIVE moves only (invariant ②); the
	 *  commits scroll via the CUP-free real LF at the last row, and the
	 *  committed lines write in the march's top section (rows
	 *  [liveTop−N .. liveTop−1] — the frozen area's bottom). */
	#drawSteady(out: string[], W: number, H: number, liveTop: number, liveLines: string[], menuRows: string[], ctx: FrameCtx): void {
		const editor = this.#inputRow(W, ctx); // derived from the frame — the marker
		const committed = this.#committedLinesThisFrame;
		// the jump from the anchor (H−2) straight to the bottom row H,
		// then N real LFs scroll the screen exactly N rows — ONE per
		// committed line (the bookkeeping; the stale 1B anchor jumped to
		// H−1 and the N LFs scrolled only N−1 — the committed section sat
		// one row short in the scrollback). The bottom-up repaint below
		// overwrites the scrolled-in rows (the scroll count is screen-
		// neutral — proven by the emulator probe).
		out.push("\x1b[2B");
		for (let i = 0; i < committed.length; i += 1) out.push("\n");
		// the bottom-up repaint, from the last row up — V6-3: the design
		// §03 chrome: status (H), lower ╌ (H−1), input (H−2), upper ╌ (H−3)
		out.push(`\x1b[1G\x1b[0K${this.#checked(statusLine(this.#status, this.#tail, this.#question !== null, W), W)}`); // H — the status
		out.push(`\x1b[1A\x1b[1G\x1b[0K${footerLine(W)}`); // H−1 — the lower ╌
		out.push(`\x1b[1A\x1b[1G\x1b[0K${this.#checked(editor.stripped, W)}`); // H−2 — the input
		out.push(`\x1b[1A\x1b[1G\x1b[0K${footerLine(W)}`); // H−3 — the upper ╌
		for (let i = menuRows.length - 1; i >= 0; i -= 1) {
			out.push(`\x1b[1A\x1b[1G\x1b[0K${this.#checked(menuRows[i]!, W)}`);
		}
		// the LIVE lines at their MODEL rows — CUP, never the relative
		// march: the march drew them adjacent to the chrome (rows
		// H−3−n..H−3) while the model placed them at [liveTop..liveTop+n−1]
		// — in the unclamped geometry the gap ELs below erased the march's
		// copy and the streamed text was INVISIBLE until the commit frame.
		// The CUP rows land in the content area (≤ H−4−menu ≤ 21), inside
		// the frozen CUP budget of invariant ②.
		for (let i = 0; i < liveLines.length; i += 1) {
			out.push(`\x1b[${liveTop + i};1H\x1b[0K${this.#checked(liveLines[i]!, W)}`);
		}
		// the FROZEN area — CUP (absolute rows; this is the FREEZE path —
		// the old code's frozen writes were CUP too. The frozen rows are
		// computed from the current geometry, so external writes (the CLI's
		// console.error CRLF) cannot misplace them the way a relative march
		// could).
		// 1. the GAP rows (between the live content and the chrome) — EL'd
		//    so the old content there cannot ghost; the range stops ABOVE
		//    the menu (the menu's rows at [H−3−menu..H−4] are marched and
		//    must survive — the unclamped geometry erased them).
		for (let r = liveTop + liveLines.length; r <= H - 4 - menuRows.length; r += 1) {
			out.push(`\x1b[${r};1H\x1b[0K`);
		}
		// 2. the STALE rows above the committed section — the scrolled old
		//    live copies (a live-drawn cell's pre-commit position): EL.
		const staleFrom = Math.max(1, this.#lastLiveTop - committed.length);
		for (let r = staleFrom; r < liveTop - committed.length; r += 1) {
			out.push(`\x1b[${r};1H\x1b[0K`);
		}
		// 3. the committed lines at [liveTop−N .. liveTop−1] — the rows
		//    CLAMP at 1: a super-tall force-commit's early lines have no
		//    on-screen row (they would need a negative CUP — terminal
		//    undefined behavior); their content stays in the scrollback.
		for (let i = 0; i < committed.length; i += 1) {
			out.push(`\x1b[${Math.max(1, liveTop - committed.length + i)};1H\x1b[0K${this.#checked(committed[i]!, W)}`);
		}
		// the cursor: down to the anchor (H−2, the input row) + left to the marker —
		// the down-distance from the LAST written row, in byte order: the
		// committed band's bottom, then the stale ELs' bottom, then the gap
		// ELs' bottom, then the live lines' bottom, then the menu's top
		// (its last marched row), else the chrome's upper ╌.
		const lastRow =
			committed.length > 0
				? Math.max(1, liveTop - 1)
				: staleFrom < liveTop
					? liveTop - 1
					: liveTop + liveLines.length <= H - 4 - menuRows.length
						? H - 4 - menuRows.length
						: liveLines.length > 0
							? liveTop + liveLines.length - 1
							: menuRows.length > 0
								? H - 3 - menuRows.length
								: H - 3;
		const down = H - 2 - lastRow; // the anchor: the input row (H−2)
		if (down > 0) out.push(`\x1b[${down}B`);
		if (editor.afterW > 0) out.push(`\x1b[${editor.afterW}D`);
	}

	/** Invariant ①: every emitted line fits the width — a violation is a
	 *  CRASH with the diagnostic, never a silent truncate. */
	#checked(line: string, W: number): string {
		const w = visibleWidth(line);
		if (w > W) {
			throw new Error(
				`kiso-tui invariant ① violated: a line of visible width ${w} > ${W} was about to be emitted — ${JSON.stringify(line.slice(0, 80))}`,
			);
		}
		return line;
	}

	#toolCell(callId: string): BodyCell | null {
		const i = this.#toolCells.get(callId);
		return i === undefined ? null : (this.#cells[i] ?? null);
	}

	/** Close an open TEXT cell when a new cell starts (see v2d — the
	 *  runtime emits no text_end; the next cell is the close signal). */
	#closeOpenText(): void {
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "text" && !last.done) last.done = true;
	}

	/** Close an open thinking cell when a new cell starts. */
	#closeOpenThinking(): void {
		if (!this.#isActive() && this.#pipeBuf !== "") {
			this.#lastThinking = this.#pipeBuf;
			this.#write(foldThinking(this.#pipeBuf));
			this.#pipeBuf = "";
			return;
		}
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "thinking" && !last.done) {
			last.done = true;
			this.#lastThinking = last.text;
		}
	}
}

/** The Dock — the CLI's module-scope singleton façade. Every method
 *  delegates to the one compositor (registered at construction); the
 *  input/menu bindings, which the CLI performs BEFORE the Body exists,
 *  are buffered and applied by the Body's constructor. */
export class Dock {
	#menuState: (() => { items: readonly MenuItem[]; selected: number } | null) | null = null;
	get active(): boolean {
		return compositorRef !== null && compositorRef.active;
	}
	enter(): void {
		compositorRef?.enter();
	}
	exit(): void {
		compositorRef?.exit();
	}
	onResize(): void {
		compositorRef?.onResize();
	}
	setStatus(text: string): void {
		compositorRef?.setStatus(text);
	}
	setTail(tail: string): void {
		compositorRef?.setTail(tail);
	}
	showQuestion(question: string): void {
		compositorRef?.showQuestion(question);
	}
	clearQuestion(): void {
		compositorRef?.clearQuestion();
	}
	bindInput(state: () => { line: string; cursor: number }, prompt: string): void {
		if (compositorRef === null) {
			// the Body is constructed AFTER the CLI's makeLineInput — buffer
			// the binding; the Body's constructor applies it
			dockBindings = { state, prompt, menu: this.#menuState };
			return;
		}
		compositorRef.bindInput(state, prompt);
	}
	bindMenu(state: () => { items: readonly MenuItem[]; selected: number } | null): void {
		this.#menuState = state;
		if (compositorRef === null) return;
		compositorRef.bindMenu(state);
	}
	editCol(): number {
		return compositorRef?.editCol() ?? 1;
	}
	redraw(): void {
		compositorRef?.redraw();
	}
}

/** The one-compositor registry — the Dock façade routes to it. */
let compositorRef: Body | null = null;

/** The Dock's pre-compositor bindings — the CLI binds the editor state
 *  before the Body exists; the Body's constructor consumes them. */
let dockBindings: {
	state: () => { line: string; cursor: number };
	prompt: string;
	menu: (() => { items: readonly MenuItem[]; selected: number } | null) | null;
} | null = null;
