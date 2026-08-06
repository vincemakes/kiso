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

import { truncateDiff } from "./diff.js";
import { displayWidth } from "./editor.js";
import {
	colorInlineCode,
	escapeTerminal,
	foldResult,
	foldThinking,
	palette,
	renderTerminalGap,
	renderToolSummary,
} from "./render.js";

/** The spinner glyphs, cycled by the heartbeat (v3 §05 — the working family). */
const SPINNER = ["▖", "▘", "▝", "▗"];

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
			// v2e: the approval-moment mini-diff + the FULL ± stats (the
			// frozen summary shows +N -M).
			diff: import("./diff.js").DiffLine[] | null;
			added: number;
			removed: number;
			startedAt: number | null;
			doneAt: number | null;
			done: boolean;
	  }
	| { kind: "text"; text: string; done: boolean }
	| { kind: "notice"; text: string; done: true }
	| { kind: "raw"; lines: string[]; done: true }
	| { kind: "terminal"; label: string; line: string; done: true }
	| {
			// ⑥ todo round: the durable checklist cell — the CLI's
			// translation of a do-not-compact-tagged todo_set result.
			// Frozen immediately (done: true) — the freeze semantics as usual.
			kind: "checklist";
			header: string;
			items: { text: string; status: "pending" | "active" | "done" }[];
			done: true;
	  };

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
	#resizeHandler: (() => void) | null = null;

	constructor(opts: BodyOptions) {
		this.#opts = opts;
		this.#write = opts.write ?? ((s) => process.stdout.write(s));
		this.#active = opts.active();
		if (this.#isActive()) {
			// TUI v4 #16a: the resize event — the terminal reflows its
			// scrollback, so OUR row bookkeeping is stale. The frozen
			// content is never re-emitted (the terminal reflowed it); the
			// counters reset so the next render lands new frozen lines via
			// the REAL-LF scroll path (just above the tail), never at stale
			// CUP rows — the overwrite garbage after a drag (the #16
			// defect). The dock redraws its own chrome on the same event.
			this.#resizeHandler = () => this.onResize();
			process.stdout.on("resize", this.#resizeHandler);
			this.#heartbeat = setInterval(() => {
				// #14/#15: the idle heartbeat PAINTS NOTHING unless an
				// ANIMATION advances — only a RUNNING tool's glyph/elapsed
				// changes between beats. The #14 fix skipped an all-frozen
				// body; #15 widened the skip to ANY no-change body: a cell
				// that stays unfinished without animating (an unclosed text
				// or thinking block) would otherwise re-paint the tail AND
				// the dock every 200ms with zero change — the short-session
				// leak (measured: 51KB / 46 beats after the recap, LF=0).
				if (!this.#cells.some((c) => c.kind === "tool" && c.state === "running")) return;
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
		if (this.#resizeHandler !== null) {
			process.stdout.off("resize", this.#resizeHandler);
			this.#resizeHandler = null;
		}
		if (this.#dirty) this.render();
	}

	/**
	 * TUI v4 #16a: a resize reflows the terminal's scrollback — the frozen
	 * rows' positions are no longer what we tracked (and the frozen CONTENT
	 * is never re-emitted: the terminal reflowed it, we only redraw the
	 * dock + active tail). The counters reset so the next render writes new
	 * frozen lines through the REAL-LF scroll path above the tail, never at
	 * a stale CUP row (the drag-garbage the #16 user saw).
	 */
	onResize(): void {
		if (!this.#isActive()) return;
		this.#frozenRows = Number.MAX_SAFE_INTEGER; // the frozen area is "full" — the next line scrolls
		this.#oldTailTop = 0; // the reflowed tail's old rows are gone — clear only the new area
		// NO #dirty: an immediate frame would re-render the ACTIVE TAIL —
		// re-emitting its bytes (the terminal already reflowed the tail's
		// content; a re-print duplicates the text in the byte stream — the
		// #16 storm gate's "response text exactly once"). The geometry
		// reset takes effect at the next NATURAL render (the next event).
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
		this.#cells.push({ kind: "tool", name, input: summary, state: "pending", isError: false, resultText: "", diff: null, added: 0, removed: 0, startedAt: null, doneAt: null, done: false });
		this.#mark();
	}

	toolApproval(callId: string, diff: import("./diff.js").DiffResult | null): void {
		if (!this.#isActive()) return;
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool" && !cell.done) {
			cell.state = "approval";
			// v2e: the mini-diff renders BELOW the tool line at the approval
			// moment — the human sees the change before deciding. Auto-allowed
			// tools pass null (nobody is looking — no diff, no cost).
			cell.diff = diff === null ? null : truncateDiff(diff.lines);
			cell.added = diff?.added ?? 0;
			cell.removed = diff?.removed ?? 0;
		}
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

	/** ⑥ todo round: the durable checklist — header + one brick-glyph line
	 *  per item, frozen immediately (it is static content). The CLI
	 *  translates a tagged tool result into the structured items; the
	 *  passthrough writes the same lines (byte-identical in pipes). */
	checklist(header: string, items: { text: string; status: "pending" | "active" | "done" }[]): void {
		const glyphOf = (status: string): string => (status === "pending" ? "□" : status === "active" ? "▖" : "▣");
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const p = palette();
			process.stdout.write(`${p.bold}▞${p.reset} ${escapeTerminal(header)}\n`);
			for (const item of items) process.stdout.write(`  ${glyphOf(item.status)} ${escapeTerminal(item.text)}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "checklist", header, items, done: true });
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
		const tailTop = Math.max(1, H - 3 - tailHeight); // v3 §03: 4 dock rows below
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
		for (let row = clearFrom; row <= H - 4; row += 1) {
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
				// v3 §02, TUI v5 #16f (v4.1 design): the user message is a left
				// rail — a bright-white BOLD ▍ per line, then the text (the
				// reverse-video block is RETIRED: it washed out on light
				// themes). Multi-line whole: every line carries the rail
				// (coherent across lines); resize-safe; NO_COLOR → the rail renders plain.
				return cell.text.split("\n").map((l) => `${p.bold}▍${p.reset} ${escapeTerminal(l)}`);
			case "thinking": {
				const block = cell.text;
				const trimmed = escapeTerminal(block.trim());
				if (trimmed.length <= 100) return [`${p.dim}…${trimmed}${p.reset}`];
				return [`${p.dim}…${trimmed.slice(0, 100)} (${block.length} chars · /think)${p.reset}`];
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
					const delta = cell.added + cell.removed > 0 ? `, +${cell.added} -${cell.removed}` : "";
					return [`${p.bold}✓ ${name}${p.reset} (${summary}${delta}, ${elapsed}s)`];
				}
				if (cell.state === "approval") {
					const lines = [`→ ${name} ${summary} ${p.bold}⏸${p.reset}`];
					// v2e: the mini-diff — ▎ bold edge (the brick motif), - red /
					// + green / context dim; NO_COLOR keeps the ± prefixes plain.
					if (cell.diff !== null) {
						for (const d of cell.diff) {
							const body =
								d.kind === "-"
									? `${p.red}- ${escapeTerminal(d.text)}${p.reset}`
									: d.kind === "+"
										? `${p.green}+ ${escapeTerminal(d.text)}${p.reset}`
										: `${p.dim}  ${escapeTerminal(d.text)}${p.reset}`;
							lines.push(`${p.bold}▎${p.reset}${body}`);
						}
					}
					return lines;
				}
				if (cell.state === "running") {
					const elapsed = cell.startedAt !== null ? Math.max(1, Math.round((Date.now() - cell.startedAt) / 1000)) : 1;
					return [`→ ${name} ${summary} ${p.bold}${SPINNER[this.#spinnerI % SPINNER.length]}${p.reset} ${elapsed}s`];
				}
				return [`→ ${name} ${summary}`];
			}
			case "text": {
				const text = escapeTerminal(cell.text);
				const wrapped = this.#wrap(text, W);
				// TUI v5 #16e: the inline-code tint — backtick spans in
				// assistant body text, matched PER LINE after the wrap (a
				// span opened on one line and closed on another does NOT
				// match — no cross-line matching). NO_COLOR → the codes are empty →
				// byte-identical.
				return wrapped.length > 0 ? wrapped.map((l) => colorInlineCode(l)) : [""];
			}
			case "notice":
				return [escapeTerminal(cell.text)];
			case "raw":
				// TUI v4 #16b: the raw cell carries the CLI's OWN pre-rendered
				// lines (the banner, the recap, slash-command output) — the
				// SGR is applied at COMPOSITION time (renderRecap/startupBanner),
				// and model/tool content was already escapeTerminal'd there.
				// Re-escaping at render STRIPPED the ESC from the SGR — the
				// literal "[38;5;75m▞[0m" garbage the user saw (the #16 mojibake,
				// also the banner's dim). Verbatim: the injection guard lives
				// at composition, not here.
				return cell.lines;
			case "terminal":
				// the honest label (done / aborted / error) + the status + the
				// rhythm gap blank
				return [cell.label, cell.line, ""];
			case "checklist": {
				// ⑥: the durable checklist — the ▞ header accent + one brick
				// glyph per item (□ pending / ▖ active / ▣ done). Text is
				// escaped at composition; the glyphs are renderer-owned.
				const lines = [`${p.bold}▞${p.reset} ${escapeTerminal(cell.header)}`];
				for (const item of cell.items) {
					const glyph = item.status === "pending" ? "□" : item.status === "active" ? "▖" : "▣";
					lines.push(`  ${glyph} ${escapeTerminal(item.text)}`);
				}
				return lines;
			}
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
