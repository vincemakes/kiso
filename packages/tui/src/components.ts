/**
 * TUI v6 (ADR-0046) — the components: EVERY screen line's renderer.
 *
 * Each component turns one piece of state into display lines (SGR
 * included, raw — the compositor writes them verbatim). The folding
 * lives HERE: every line a component returns must fit the terminal
 * width — the compositor's crash-on-violation invariant backs it up
 * (a component that forgets to fold CRASHES with a diagnostic, never
 * silently truncates — pi tui-main-screen.ts:447-473).
 *
 * The fold is SGR-AWARE: a line whose bold/dim span would straddle a
 * fold boundary closes the span at the break and reopens it on the
 * next row — the #16b contract (no literal "[2m" fragments) survives
 * folding. displayWidth/charWidth (editor.ts) are the width primitives
 * (untouched); render.ts supplies the original text (palette, escape,
 * tint, fold wording).
 */

import { displayWidth } from "./editor.js";
import {
	escapeTerminal,
	foldThinking,
	foldResult,
	colorInlineCode,
	renderTerminalGap,
	renderToolSummary,
	palette,
} from "./render.js";

/** The spinner glyphs, cycled by the compositor's on-demand tick. */
export const SPINNER = ["▖", "▘", "▝", "▗"];

/** The frame context the compositor passes down — the pieces of time
 *  that make a live render non-deterministic (the running tool's glyph
 *  and elapsed). Everything else is a pure function of the cell. */
export interface FrameCtx {
	readonly spinnerI: number;
	readonly now: number;
}

/** ONE screen line a component emits (raw, SGR included). */
export type RenderLine = string;

/**
 * The fold — split a display-width line into ≤W rows, preserving SGR
 * spans across the break: a span open at the break closes (reset) at
 * the row's end and reopens on the next row. The rows are what the
 * terminal's own soft-wrap would have produced — except the compositor
 * folds FIRST, so the terminal never reflows a component's line (the
 * #17 merge class cannot reach committed content).
 */
export function foldLine(line: string, W: number): string[] {
	if (W < 1) return [line];
	// collect the plain text + the SGR segments so the walk can track
	// the open span state
	const out: string[] = [];
	let current = "";
	let width = 0;
	let open: string[] = []; // the SGR sequences seen since the last reset
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\n") {
			// a real line break — the row ends here (the same close/reopen
			// as a fold boundary, so a span never leaks across the break)
			const close = open.length > 0 ? "\x1b[0m" : "";
			out.push(current + close);
			current = open.join("");
			width = 0;
			i += 1;
			continue;
		}
		if (line[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
			if (m !== null) {
				if (m[0] === "\x1b[0m") open = [];
				else open.push(m[0]);
				current += m[0];
				i += m[0].length;
				continue;
			}
			// a non-SGR CSI (the raw cell's own content, escaped at
			// composition) — copy verbatim, zero width
			const csi = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
			if (csi !== null) {
				current += csi[0];
				i += csi[0].length;
				continue;
			}
			current += line[i]!;
			i += 1;
			continue;
		}
		const cw = displayWidth(line[i]!);
		if (width + cw > W && width > 0) {
			// the fold — close the open spans, push, reopen on the next row
			const close = open.length > 0 ? "\x1b[0m" : "";
			out.push(current + close);
			current = open.join("");
			width = 0;
			continue;
		}
		current += line[i]!;
		width += cw;
		i += 1;
	}
	if (current !== "" || out.length === 0) out.push(current);
	return out;
}

/** The visible width of a rendered line (SGR stripped — the invariant
 *  the compositor enforces on every emitted line). */
export function visibleWidth(line: string): number {
	let w = 0;
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
			if (m !== null) {
				i += m[0].length;
				continue;
			}
			i += 1;
			continue;
		}
		w += displayWidth(line[i]!);
		i += 1;
	}
	return w;
}

/** A component: render the display lines for one piece of state. */
export interface Component {
	render(width: number, ctx: FrameCtx): string[];
}

/** The container — vertical concatenation of its children. */
export class Container implements Component {
	constructor(private readonly children: Component[]) {}
	render(width: number, ctx: FrameCtx): string[] {
		return this.children.flatMap((c) => c.render(width, ctx));
	}
}

// ---- the cell model (the CLI's mutation surface — unchanged from v5) ----

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
			kind: "checklist";
			header: string;
			items: { text: string; status: "pending" | "active" | "done" }[];
			done: true;
	  };

const TOOL_SUMMARY_MAX = 60; // the tool line's parameter summary, chars

/** The component for one cell — the mapping table lives here so the
 *  compositor stays a pure writer. */
export function cellComponent(cell: BodyCell): Component {
	switch (cell.kind) {
		case "user":
			return new UserMessage(cell);
		case "thinking":
			return new ThinkingFold(cell);
		case "tool":
			return new ToolExecution(cell);
		case "text":
			return new AssistantMessage(cell);
		case "notice":
			return new ErrorLine(cell);
		case "raw":
			return new RawBlock(cell);
		case "terminal":
			return new TerminalBlock(cell);
		case "checklist":
			return new Checklist(cell);
	}
}

/**
 * The user message — the left rail (bright-white BOLD ▍ per row, the
 * v4.1 design). The text folds at W−2 (the rail + space) so every row
 * carries the rail and NO row exceeds the width (the v5 code split on
 * "\n" only — a long line soft-wrapped and its continuation row had no
 * rail).
 */
class UserMessage implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const rail = `${p.bold}▍${p.reset} `;
		const textW = Math.max(1, W - 2);
		const rows: string[] = [];
		for (const para of this.cell.text.split("\n")) {
			const folded = foldLine(escapeTerminal(para), textW);
			for (const row of folded) rows.push(`${rail}${row}`);
		}
		return rows.length > 0 ? rows : [rail.trimEnd()];
	}
}

/** The thinking fold — one dim line, width-capped so the /think suffix
 *  rides the fold's own row (the #17 fix's slice, componentized). The
 *  slice is DISPLAY-WIDTH-based (the char-based slice overflowed with
 *  CJK — 2 cells per char — and tripped invariant ① on a real
 *  Chinese session). */
class ThinkingFold implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const block = this.cell.text;
		const trimmed = escapeTerminal(block.trim());
		// the SHORT branch is width-aware TOO: the ≤100 short-circuit was
		// W-blind — a short block at a narrow width returned the line
		// UNFOLDED and tripped invariant ① (the crash class still live on
		// npm for short /think blocks after a resize).
		if (trimmed.length <= 100) return [`${palette().dim}…${widthCut(trimmed, Math.max(1, W - 1))}${palette().reset}`];
		const suffix = ` (${block.length} chars · /think)`;
		const slice = Math.max(1, W - 1 - suffix.length);
		return [`${palette().dim}…${widthCut(trimmed, slice)}${suffix}${palette().reset}`];
	}
}

/** The tool execution line + the bounded block — every state is its
 *  own render; the lines fold (the summary gives way first). W7 (the
 *  flow contract): the block's BODY (the rows below the header) is
 *  capped in SCREEN rows AFTER the fold, at the current width — the
 *  renderer-cut row (`└ +N … · ctrl+r`) sits INSIDE the cap (a
 *  truncated block is cap−1 output rows + the cut row); the TOOL-cut
 *  row (`└ capped by …` — the tool's OWN truncation note, W10) is a
 *  DIFFERENT fact, never counted in the output cap. */
class ToolExecution implements Component {
	constructor(private readonly cell: Extract<BodyCell, { kind: "tool" }>) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const c = this.cell;
		const name = escapeTerminal(c.name);
		const summary = escapeTerminal(c.input);
		if (c.state === "done") {
			const elapsed = c.startedAt !== null && c.doneAt !== null ? ((c.doneAt - c.startedAt) / 1000).toFixed(1) : "?";
			const line = c.isError
				? `${p.red}✗ ${name} (${escapeTerminal(c.resultText.split("\n")[0]!.slice(0, 60))}, ${elapsed}s)${p.reset}`
				: `${p.bold}✓ ${name}${p.reset} (${summary}${c.added + c.removed > 0 ? `, +${c.added} -${c.removed}` : ""}, ${elapsed}s)`;
			const out = foldLine(line, W);
			out.push(...toolBlockBody(c, W));
			return out;
		}
		if (c.state === "approval") {
			const out = foldLine(`→ ${name} ${summary} ${p.bold}⏸${p.reset}`, W);
			out.push(...toolBlockBody(c, W));
			return out;
		}
		if (c.state === "running") {
			const elapsed = c.startedAt !== null ? Math.max(1, Math.round((ctx.now - c.startedAt) / 1000)) : 1;
			const out = foldLine(`→ ${name} ${summary} ${p.bold}${SPINNER[ctx.spinnerI % SPINNER.length]}${p.reset} ${elapsed}s`, W);
			out.push(...toolBlockBody(c, W));
			return out;
		}
		return foldLine(`→ ${name} ${summary}`, W);
	}
}

// ---- the bounded-block flow contract (W7, W8, W10) ----

/** The caps — screen rows counted AFTER the fold, at the current width
 *  (the W7 table). The renderer-cut row is inside the cap. */
const CAP_SHELL_SETTLED = 5; // the shell output tail, settled
const CAP_LIVE_WINDOW = 3; // the running tool's FIXED window (W8)
const CAP_DIFF = 12; // the approval diff: head + the named middle + tail
const CAP_ERROR = 3; // the error text head

/** The block body rows' prefixes (W2's gutter table): │ a bounded
 *  block's body, └ the block's last row — what was cut, where the rest
 *  is. Structural (constraint 1) — they survive a pipe. */
const BODY_ROW = "  │ ";
const CUT_ROW = "  └ ";

/** W9 — the per-cell memo: the bounded block's folded body is cached
 *  per (width, state, content reference) — a steady stream re-measures
 *  ZERO times (constraint 5: width-dependent work rides the fullRedraw
 *  path, never the per-frame path); a resize re-measures once (the
 *  width key flips). Keyed on the CELL object; the content key is the
 *  reference identity (resultText / the diff array are assigned once
 *  and never mutated). */
interface BlockMemo {
	width: number;
	state: string;
	content: unknown;
	rows: string[];
}
const blockMemo = new WeakMap<object, BlockMemo>();

/** The block's body rows below the header (memoized, W9). */
function toolBlockBody(c: Extract<BodyCell, { kind: "tool" }>, W: number): string[] {
	const memo = blockMemo.get(c);
	const state = `${c.state}:${c.isError}:${c.name}`;
	const content: unknown = c.state === "approval" ? (c.diff ?? null) : c.resultText;
	if (memo !== undefined && memo.width === W && memo.state === state && memo.content === content) return memo.rows;
	const p = palette();
	const rows =
		c.state === "done"
			? c.isError
				? errorBody(c.resultText, W)
				: c.name.startsWith("shell")
					? shellTail(c.resultText, W)
					: []
			: c.state === "running"
				? liveWindow(c.resultText, W)
				: c.state === "approval"
					? diffBody(c.diff, W)
					: [];
	const note = toolCutNote(c.name, c.resultText);
	if (note !== null) rows.push(...foldLine(`${p.dim}${CUT_ROW}${note}${p.reset}`, W));
	blockMemo.set(c, { width: W, state, content, rows });
	return rows;
}

/** Fold result text into dim body rows (the BODY_ROW prefix): escape,
 *  split, fold each line at W−prefix; trailing empty rows (the result's
 *  final newline) drop. */
function blockRows(text: string, W: number): string[] {
	const p = palette();
	const textW = Math.max(1, W - visibleWidth(BODY_ROW));
	const rows: string[] = [];
	for (const raw of escapeTerminal(text).split("\n")) {
		for (const row of foldLine(raw, textW)) rows.push(`${p.dim}${BODY_ROW}${row}${p.reset}`);
	}
	while (rows.length > 0 && visibleWidth(rows[rows.length - 1]!) === visibleWidth(BODY_ROW)) rows.pop();
	return rows;
}

/** The shell output tail, settled: the LAST rows, capped at 5 — the
 *  renderer cut at the block's bottom ("earlier rows" — the conclusion
 *  is at the end, pi's truncateToVisualLines direction). */
function shellTail(text: string, W: number): string[] {
	const p = palette();
	const rows = blockRows(text, W);
	if (rows.length <= CAP_SHELL_SETTLED) return rows;
	const kept = CAP_SHELL_SETTLED - 1;
	const cut = foldLine(`${p.dim}${CUT_ROW}+${rows.length - kept} earlier rows · ctrl+r${p.reset}`, W);
	return [...rows.slice(rows.length - kept), ...cut];
}

/** The error text head: the FIRST rows, capped at 3 — the answer is at
 *  the start (opencode's collapseToolOutput direction). The header row
 *  already summarizes the first line, so the body starts at line 2. */
function errorBody(text: string, W: number): string[] {
	const p = palette();
	const rows = blockRows(text.split("\n").slice(1).join("\n"), W);
	if (rows.length <= CAP_ERROR) return rows;
	const cut = foldLine(`${p.dim}${CUT_ROW}+${rows.length - (CAP_ERROR - 1)} more · ctrl+r${p.reset}`, W);
	return [...rows.slice(0, CAP_ERROR - 1), ...cut];
}

/** The running tool's FIXED-height window (W8): exactly 3 rows from
 *  the FIRST frame — blank-padded before output arrives, the renderer
 *  cut inside the window. The height changes exactly once, at settle —
 *  a cell that grows mid-list would shift every row after it on every
 *  delta (the parallel-tools jitter). */
function liveWindow(text: string, W: number): string[] {
	const p = palette();
	if (text === "") {
		return [`${p.dim}${BODY_ROW}${p.reset}`, `${p.dim}${BODY_ROW}${p.reset}`, `${p.dim}${CUT_ROW}waiting for output${p.reset}`];
	}
	const rows = blockRows(text, W);
	if (rows.length <= CAP_LIVE_WINDOW) {
		while (rows.length < CAP_LIVE_WINDOW) rows.push(`${p.dim}${BODY_ROW}${p.reset}`);
		return rows;
	}
	const cut = foldLine(`${p.dim}${CUT_ROW}+${rows.length - (CAP_LIVE_WINDOW - 1)} earlier rows · ctrl+r${p.reset}`, W);
	return [...rows.slice(rows.length - (CAP_LIVE_WINDOW - 1)), ...cut];
}

/** The approval mini-diff (W7): capped at 12 folded rows — the head +
 *  the named middle (the renderer cut — what was cut, how to expand) +
 *  the tail. The rows are folded at the current width BEFORE the cap —
 *  the R1 measured bug: truncateDiff capped at 40 ENTRIES while the
 *  fold turned them into 73 SCREEN rows at W≤80 (a 44-row terminal's
 *  content cap is H−4 = 40 — the approval force-committed a third of
 *  the screen into scrollback inside one frame). */
function diffBody(diff: import("./diff.js").DiffLine[] | null, W: number): string[] {
	const p = palette();
	if (diff === null) return [];
	const rows: string[] = [];
	for (const d of diff) {
		const body =
			d.kind === "-"
				? `${p.red}- ${escapeTerminal(d.text)}${p.reset}`
				: d.kind === "+"
					? `${p.green}+ ${escapeTerminal(d.text)}${p.reset}`
					: `${p.dim}  ${escapeTerminal(d.text)}${p.reset}`;
		rows.push(...foldLine(`${p.bold}▎${p.reset}${body}`, W));
	}
	if (rows.length <= CAP_DIFF) return rows;
	const head = Math.floor((CAP_DIFF - 1) / 2);
	const tail = CAP_DIFF - 1 - head;
	const cut = foldLine(`${p.dim}${CUT_ROW}+${rows.length - head - tail} rows · ctrl+r to expand · /last for the full diff${p.reset}`, W);
	return [...rows.slice(0, head), ...cut, ...rows.slice(rows.length - tail)];
}

/** The TOOL's OWN truncation note (W10) — a different fact from the
 *  renderer's cut: the tools truncate and append a continuation note
 *  (packages/tools-node/src/index.ts — read_file's "call again with
 *  offset=N", the output cap, list_dir's entry cap). The note reaches
 *  the MODEL and never the human — this row surfaces it. Detected in
 *  the result's TAIL (the note is appended at the end); returns null
 *  when the tool did not truncate. */
function toolCutNote(name: string, resultText: string): string | null {
	const tail = resultText.slice(-300);
	const m = /offset=(\d+)/.exec(tail);
	if (m !== null) return `capped by ${escapeTerminal(name)} · offset=${m[1]} for the rest`;
	if (/…\[truncated\]/.test(tail) || /… \+?\d+ more (?:lines|entries)/.test(tail)) return `capped by ${escapeTerminal(name)} · /last for the rest`;
	return null;
}

/** The assistant body text — wrapped at W, the inline-code tint per
 *  row (the #16e rule: a span never matches across rows). */
class AssistantMessage implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const text = escapeTerminal(this.cell.text);
		const wrapped = foldLine(text, W);
		return wrapped.length > 0 ? wrapped.map((l) => colorInlineCode(l)) : [""];
	}
}

/** The ⚠ / notice lines — the error surface. */
class ErrorLine implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		return foldLine(escapeTerminal(this.cell.text), W);
	}
}

/** The CLI's pre-rendered blocks (the banner, the recap, slash-command
 *  output) — the SGR applied at composition (render.ts), folded here
 *  verbatim: the #16b contract (no re-escaping) holds, and the fold is
 *  SGR-aware so the accent spans survive a break. */
class RawBlock implements Component {
	constructor(private readonly cell: { lines: string[] }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		return this.cell.lines.flatMap((l) => foldLine(l, W));
	}
}

/** The terminal label + the status line + the rhythm gap blank. */
class TerminalBlock implements Component {
	constructor(private readonly cell: { label: string; line: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const lines = [...foldLine(this.cell.label, W), ...foldLine(this.cell.line, W)];
		if (this.cell.label !== "") lines.push("");
		return lines;
	}
}

/** The durable checklist — the ▞ header + one brick-glyph row per item. */
class Checklist implements Component {
	constructor(private readonly cell: { header: string; items: { text: string; status: "pending" | "active" | "done" }[] }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const glyphOf = (status: string): string => (status === "pending" ? "□" : status === "active" ? "▖" : "▣");
		const rows = foldLine(`${p.bold}▞${p.reset} ${escapeTerminal(this.cell.header)}`, W);
		for (const item of this.cell.items) {
			rows.push(...foldLine(`  ${glyphOf(item.status)} ${escapeTerminal(item.text)}`, W));
		}
		return rows;
	}
}

// ---- the chrome components (the status container, the slot, the footer) ----

/** The status container's row: the status text (+ the tail) with the
 *  right-aligned "/ commands · ↑ history" hint in the idle state —
 *  the hint CUT FIRST when the width is short (the #16g rule); when
 *  the STATUS ITSELF cannot fit, it cuts with a "…" — the last resort,
 *  enforced by invariant ① (the old code let the status soft-wrap). */
export function statusLine(status: string, tail: string, question: boolean, W: number): string {
	const p = palette();
	const text = `${status}${tail === "" ? "" : ` · ${tail}`}`;
	if (question) return `${p.dim}${widthCut(text, W)}${p.reset}`;
	const hint = " / commands · ↑ history";
	const statusW = visibleWidth(text);
	if (statusW > W) {
		return `${p.dim}${widthCut(text, W - 1)}…${p.reset}`;
	}
	const hintW = visibleWidth(hint);
	if (statusW + hintW > W) return `${p.dim}${text}${p.reset}`;
	return `${p.dim}${text}${" ".repeat(Math.max(0, W - statusW - hintW))}${hint}${p.reset}`;
}

/** The display-width prefix of a plain (SGR-free) text. */
function widthCut(text: string, max: number): string {
	let w = 0;
	let i = 0;
	for (; i < text.length; i += 1) {
		const cw = displayWidth(text[i]!);
		if (w + cw > max) break;
		w += cw;
	}
	return text.slice(0, i);
}

/** The footer — the ONE dotted row (the old two-row chrome is gone;
 *  the wall cannot return by construction). */
export function footerLine(W: number): string {
	return `\x1b[2m${"╌".repeat(W)}\x1b[0m`;
}

/** The terminal label + rhythm gap (the pipe path's v2c bytes — the
 *  exact render the passthrough needs). */
export function terminalPipe(label: string, statusLineText: string): string {
	return label + renderTerminalGap(statusLineText);
}

/** The pipe-path pieces the passthrough reuses (byte-identical). */
export { foldThinking, foldResult, renderToolSummary, TOOL_SUMMARY_MAX };
