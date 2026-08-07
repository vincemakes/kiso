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
 *  rides the fold's own row (the #17 fix's slice, componentized). */
class ThinkingFold implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const block = this.cell.text;
		const trimmed = escapeTerminal(block.trim());
		if (trimmed.length <= 100) return [`${palette().dim}…${trimmed}${palette().reset}`];
		const suffix = ` (${block.length} chars · /think)`;
		const slice = Math.max(1, W - 1 - suffix.length);
		return [`${palette().dim}…${trimmed.slice(0, slice)}${suffix}${palette().reset}`];
	}
}

/** The tool execution line + the approval mini-diff — every state is
 *  its own render; the lines fold (the summary gives way first). */
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
			return foldLine(line, W);
		}
		if (c.state === "approval") {
			const lines = foldLine(`→ ${name} ${summary} ${p.bold}⏸${p.reset}`, W);
			if (c.diff !== null) {
				for (const d of c.diff) {
					const body =
						d.kind === "-"
							? `${p.red}- ${escapeTerminal(d.text)}${p.reset}`
							: d.kind === "+"
								? `${p.green}+ ${escapeTerminal(d.text)}${p.reset}`
								: `${p.dim}  ${escapeTerminal(d.text)}${p.reset}`;
					lines.push(...foldLine(`${p.bold}▎${p.reset}${body}`, W));
				}
			}
			return lines;
		}
		if (c.state === "running") {
			const elapsed = c.startedAt !== null ? Math.max(1, Math.round((ctx.now - c.startedAt) / 1000)) : 1;
			return foldLine(`→ ${name} ${summary} ${p.bold}${SPINNER[ctx.spinnerI % SPINNER.length]}${p.reset} ${elapsed}s`, W);
		}
		return foldLine(`→ ${name} ${summary}`, W);
	}
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
