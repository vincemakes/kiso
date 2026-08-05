/**
 * v2d — the body renderer: ONE writer for the stdout scroll region.
 *
 * The v2b/v2c body writes streamed directly (each event wrote its bytes),
 * so the tool lines, thinking folds, and text deltas could interleave in
 * the same frame — and a tool's life was scattered across several writes
 * (the "leak"). v2d: every event handler ONLY mutates cell state; the
 * Body's render loop is the only thing that writes the region.
 *
 * Frozen semantics: a completed cell prints its final form into the
 * scroll region ONCE and is never touched again. The ACTIVE TAIL — the
 * unfinished cells — renders at the region's bottom (between the frozen
 * area and the dock) and redraws in place, CSI 2026 wrapped. State
 * changes coalesce to ≥16ms frames; a 200ms heartbeat drives the running
 * spinners and elapsed timers. An over-height tail (rare) overflows to
 * freeze by completion order.
 *
 * Pipes / NO_COLOR: the Body runs in PASSTHROUGH — every mutation writes
 * the v2b/v2c line-mode bytes immediately, byte-for-byte (the existing
 * e2e guards it). The cell renderer never activates.
 *
 * The cell model is ours (UserCell / ThinkingCell / ToolCell / TextCell /
 * NoticeCell / raw block) — deliberately NOT pi's Component interface
 * shape (ADR-0040).
 */

import { displayWidth } from "./editor.js";
import {
	escapeTerminal,
	foldResult,
	foldThinking,
	palette,
	renderTerminalGap,
	renderToolSummary,
} from "./render.js";

/** The spinner glyphs, cycled by the heartbeat. */
const SPINNER = ["◐", "◓", "◑", "◒"];

const TOOL_SUMMARY_MAX = 60; // the tool line's parameter summary, chars
const FRAME_MS = 16; // state changes coalesce to ≥16ms frames
const HEARTBEAT_MS = 200; // spinner / elapsed cadence

/** One completed-or-active body line. The renderer's only state. */
export type BodyCell =
	| { kind: "user"; text: string; done: true }
	| { kind: "thinking"; text: string; done: boolean }
	| {
			kind: "tool";
			name: string;
			input: string;
			state: "pending" | "approval" | "running" | "done";
			isError: boolean;
			resultText: string;
			startedAt: number | null;
			doneAt: number | null;
			done: boolean;
	  }
	| { kind: "text"; text: string; done: boolean }
	| { kind: "notice"; text: string; done: true }
	| { kind: "raw"; lines: string[]; done: true }
	| { kind: "terminal"; label: string; line: string; done: true };

export interface BodyOptions {
	/** Is the cell renderer live? A color TTY with a real size — checked
	 *  per mutation (the TIOCSWINSZ can land after main constructs us). */
	active: () => boolean;
	/** The terminal height (rows) — live, for the region geometry. */
	height: () => number;
	/** The terminal width (cols) — live, for wrap estimates. */
	width: () => number;
	/** The input line's edit column — the render's cursor home. */
	editCol: () => number;
	/** The dock's redraw (the bottom three rows) — the body never writes
	 *  below the region, but the frame may call it to re-pin the chrome. */
	onDock?: () => void;
	/** The stdout writer — injectable for unit tests (default: stdout). */
	write?: (s: string) => void;
}

export class Body {
	#active: boolean;
	#opts: BodyOptions;
	#cells: BodyCell[] = [];
	#nextFrozen = 0; // index of the first not-yet-printed cell
	#frozenRows = 0; // the frozen area's rows filled WITHOUT scrolling (then the real LFs take over)
	#oldTailTop = 0; // the tail's previous first row — for the clear pass
	#frameTimer: NodeJS.Timeout | null = null;
	#heartbeat: NodeJS.Timeout | null = null;
	#dirty = false;
	#spinnerI = 0;
	#lastThinking: string | null = null;
	#lastTool: { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } } | null = null;
	#pendingCalls = new Map<string, { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } }>();
	#pipeBuf = ""; // the passthrough's thinking buffer — the cell model needs no buffer
	#toolCells = new Map<string, number>(); // callId → cell index (parallel tools)
	#write: (s: string) => void;

	constructor(opts: BodyOptions) {
		this.#opts = opts;
		this.#write = opts.write ?? ((s) => process.stdout.write(s));
		this.#active = opts.active();
		if (this.#isActive()) {
			this.#heartbeat = setInterval(() => {
				this.#spinnerI = (this.#spinnerI + 1) % SPINNER.length;
				this.#dirty = true; // the running cells' glyph/elapsed advance
				this.#scheduleFrame();
			}, HEARTBEAT_MS);
			this.#heartbeat.unref();
		}
	}

	/** Live re-check — a TTY whose size lands after construction flips in. */
	#isActive(): boolean {
		this.#active = this.#opts.active();
		return this.#active;
	}

	/** Teardown — flush a pending frame, stop the timers. */
	close(): void {
		if (this.#frameTimer !== null) {
			clearTimeout(this.#frameTimer);
			this.#frameTimer = null;
		}
		if (this.#heartbeat !== null) {
			clearInterval(this.#heartbeat);
			this.#heartbeat = null;
		}
		if (this.#dirty) this.render();
	}

	/** The last COMPLETE thinking block, for /think. */
	lastThinking(): string | null {
		return this.#lastThinking;
	}

	/** The last completed tool call, for /last. */
	lastTool(): { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } } | null {
		return this.#lastTool;
	}

	// ---- mutations (the ONLY way the CLI touches the body) ----

	userLine(text: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
		this.#closeOpenText();
			const p = palette();
			this.#write(`${p.blue}you> ${escapeTerminal(text)}${p.reset}\n`);
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
			if (!this.#isActive()) process.stdout.write(foldThinking(last.text));
			this.#mark();
		}
	}

	toolStart(name: string, callId: string, input: Record<string, unknown>): void {
		const summary = JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX);
		// Registered BEFORE the passthrough branch — /last and the pipe
		// summary need the call on BOTH paths.
		this.#pendingCalls.set(callId, { name, input, result: { content: "", isError: false } });
		if (!this.#isActive()) {
			this.#closeOpenThinking();
		this.#closeOpenText();
			process.stdout.write(`→ ${escapeTerminal(name)}(${escapeTerminal(JSON.stringify(input).slice(0, 200))})\n`);
			return;
		}
		this.#toolCells.set(callId, this.#cells.length);
		this.#cells.push({ kind: "tool", name, input: summary, state: "pending", isError: false, resultText: "", startedAt: null, doneAt: null, done: false });
		this.#mark();
	}

	toolApproval(callId: string): void {
		if (!this.#isActive()) return;
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) cell.state = "approval";
		this.#mark();
	}

	toolRunning(callId: string): void {
		if (!this.#isActive()) {
			const p = palette();
			process.stdout.write(`${p.dim}  running…${p.reset}\n`);
			return;
		}
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) {
			cell.state = "running";
			cell.startedAt = Date.now();
		}
		this.#mark();
	}

	toolSucceeded(callId: string): void {
		if (!this.#isActive()) {
			process.stdout.write(`  ok\n`);
		}
	}

	toolFailed(callId: string, error: string): void {
		if (!this.#isActive()) {
			const p = palette();
			process.stdout.write(`${p.red}  failed: ${escapeTerminal(error.slice(0, 160))}${p.reset}\n`);
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
			// The v2b/v2c pipe bytes: the summary line + the [result] line.
			const p = palette();
			process.stdout.write(
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
			process.stdout.write(escapeTerminal(text));
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
			process.stdout.write("\n");
			return;
		}
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "text" && !last.done) last.done = true;
		this.#mark();
	}

	/** The terminal's status line + the rhythm gap (one blank). */
	terminal(label: string, statusLine: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
		this.#closeOpenText();
			// the v2c bytes: the terminal label (\ndone\n) + the status gap.
			process.stdout.write(label + renderTerminalGap(statusLine));
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "terminal", label: label.trim(), line: statusLine, done: true });
		this.#mark();
	}

	notice(text: string): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
		this.#closeOpenText();
			process.stdout.write(`${text}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "notice", text, done: true });
		this.#mark();
	}

	/** A pre-rendered block (the banner, the session line, slash-command
	 *  outputs) — frozen immediately. */
	raw(lines: string[]): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
		this.#closeOpenText();
			for (const line of lines) process.stdout.write(`${line}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "raw", lines, done: true });
		this.#mark();
	}

	// ---- rendering ----

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

	/** The one writer. Frozen cells print once; the tail redraws in place,
	 *  CSI 2026 wrapped; the cursor lands at the input edit column. */
	render(): void {
		if (!this.#isActive()) return;
		const H = this.#opts.height();
		const W = this.#opts.width();
		if (H < 4) return;
		const out: string[] = [];
		// #13 (P1), v2d-B: NO DECSTBM — overflow scrolls with a REAL LF at
		// the screen's last row, so the frozen lines enter the terminal's
		// NATIVE scrollback deterministically (region-scrolled lines are
		// terminal-dependent; some terminals drop them — the measured v2d-A
		// defect). The body fills from the top without scrolling; once full,
		// every new frozen line scrolls the whole screen (\x1b[H;1H\n — the
		// top line leaves into the scrollback) and lands at the body's
		// bottom row, just above the active tail. The dock is redrawn after.
		// The tail (the remaining ACTIVE cells) and its geometry — computed
		// FIRST from the final nextFrozen, so the frozen cells are NOT in it
		// (a stale tail would re-draw them — the double-render).
		let nextFrozen = this.#nextFrozen;
		while (nextFrozen < this.#cells.length && this.#cells[nextFrozen]!.done) nextFrozen += 1;
		const tail = this.#cells.slice(nextFrozen);
		const tailHeight = tail.reduce((n, c) => n + this.#cellHeight(c, W), 0);
		const tailTop = Math.max(1, H - 2 - tailHeight);
		const writeRow = Math.max(1, tailTop - 1); // the frozen area's bottom row
		let scrolled = 0;
		for (let i = this.#nextFrozen; i < nextFrozen; i += 1) {
			for (const line of this.#cellLines(this.#cells[i]!, W)) {
				if (this.#frozenRows < writeRow) {
					this.#frozenRows += 1;
					out.push(`\x1b[${this.#frozenRows};1H\x1b[0K${line}`);
				} else {
					out.push(`\x1b[${H};1H\n`); // the REAL LF — the whole screen scrolls
					out.push(`\x1b[${writeRow};1H\x1b[0K${line}`);
					scrolled += 1;
				}
			}
			this.#nextFrozen += 1;
		}
		// 2. the active tail — clear its old area (shifted up by the freeze
		// scrolls) and the current area, draw the cells at the body's bottom.
		out.push("\x1b[?2026h");
		const clearFrom = Math.min(this.#oldTailTop === 0 ? tailTop : this.#oldTailTop - scrolled, tailTop);
		for (let row = clearFrom; row <= H - 3; row += 1) {
			out.push(`\x1b[${row};1H\x1b[0K`);
		}
		let row = tailTop;
		for (const cell of tail) {
			for (const line of this.#cellLines(cell, W)) {
				out.push(`\x1b[${row};1H${line}`);
				row += 1;
			}
		}
		// 3. the cursor home — the input line's edit column.
		out.push(`\x1b[${H};${this.#opts.editCol()}H`);
		out.push("\x1b[?2026l");
		this.#write(out.join(""));
		// 4. the dock rows — the freeze scrolls shifted them; redraw (the
		// dock's own redraw re-pins the cursor at the edit position).
		this.#opts.onDock?.();
	}

	// ---- cell → lines ----

	#cellLines(cell: BodyCell, W: number): string[] {
		const p = palette();
		switch (cell.kind) {
			case "user":
				return [`${p.blue}you> ${escapeTerminal(cell.text)}${p.reset}`];
			case "thinking": {
				const block = cell.text;
				const trimmed = escapeTerminal(block.trim());
				if (trimmed.length <= 100) return [`${p.dim}…${trimmed}${p.reset}`];
				return [`${p.dim}…${trimmed.slice(0, 100)} (… ${block.length} chars · /think shows full)${p.reset}`];
			}
			case "tool": {
				const name = escapeTerminal(cell.name);
				const summary = escapeTerminal(cell.input);
				if (cell.state === "done") {
					const elapsed = cell.startedAt !== null && cell.doneAt !== null ? ((cell.doneAt - cell.startedAt) / 1000).toFixed(1) : "?";
					if (cell.isError) {
						const err = escapeTerminal(cell.resultText.split("\n")[0]!.slice(0, 60));
						return [`${p.red}✗ ${name} (${err}, ${elapsed}s)${p.reset}`];
					}
					return [`${p.blue}✓ ${name}${p.reset} (${summary}, ${elapsed}s)`];
				}
				if (cell.state === "approval") return [`→ ${name} ${summary} ${p.blue}⏸${p.reset}`];
				if (cell.state === "running") {
					const elapsed = cell.startedAt !== null ? Math.max(1, Math.round((Date.now() - cell.startedAt) / 1000)) : 1;
					return [`→ ${name} ${summary} ${p.blue}${SPINNER[this.#spinnerI % SPINNER.length]}${p.reset} ${elapsed}s`];
				}
				return [`→ ${name} ${summary}`];
			}
			case "text": {
				const text = escapeTerminal(cell.text);
				const wrapped = this.#wrap(text, W);
				return wrapped.length > 0 ? wrapped : [""];
			}
			case "notice":
				return [escapeTerminal(cell.text)];
			case "raw":
				return cell.lines.map((l) => escapeTerminal(l));
			case "terminal":
				// the honest label (done / aborted / error) + the status + the
				// rhythm gap blank
				return [cell.label, cell.line, ""];
		}
	}

	#cellHeight(cell: BodyCell, W: number): number {
		const lines = this.#cellLines(cell, W);
		return Math.max(1, lines.length);
	}

	/** Wrap a body text by display width (the terminal's own wrapping,
	 *  approximated — documented; the region clamp keeps the dock safe). */
	#wrap(text: string, W: number): string[] {
		if (W < 4) return [text];
		const out: string[] = [];
		let current = "";
		let width = 0;
		for (const ch of text) {
			const cw = displayWidth(ch);
			if (ch === "\n" || width + cw > W) {
				out.push(current);
				current = "";
				width = 0;
				if (ch === "\n") continue;
			}
			current += ch;
			width += cw;
		}
		out.push(current);
		return out;
	}

	#toolCell(callId: string): BodyCell | null {
		const i = this.#toolCells.get(callId);
		return i === undefined ? null : (this.#cells[i] ?? null);
	}

	/** Close an open TEXT cell when a new cell starts — the runtime emits
	 *  no text_end (it is an adapter-level event), so the stream's next
	 *  cell is the close signal; without it the freeze blocks behind the
	 *  open text and everything after it re-renders in the tail forever
	 *  (the #13 flood reproduced the overwrite). */
	#closeOpenText(): void {
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "text" && !last.done) last.done = true;
	}

	/** Close an open thinking cell when a new cell starts (the block's
	 *  fold freezes at the transition). */
	#closeOpenThinking(): void {
		if (!this.#isActive() && this.#pipeBuf !== "") {
			this.#lastThinking = this.#pipeBuf;
			process.stdout.write(foldThinking(this.#pipeBuf));
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
