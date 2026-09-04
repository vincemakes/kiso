/**
 * TUI v6 (ADR-0046) — the components: EVERY screen line's renderer.
 * Extracted to tui-cells (ADR-0043 Amendment 4): the cell renderer
 * leaves the tui for the 9th package; the tui's shims re-export it.
 *
 * Each component turns one piece of state into display lines (SGR
 * included, raw — the compositor writes them verbatim). The folding
 * lives HERE: every line a component returns must fit the terminal
 * width — the compositor's crash-on-violation invariant backs it up
 * (a component that forgets to fold CRASHES with a diagnostic, never
 * silently truncates — the crash is the contract UNDER TEST; in the
 * field the row is cut and the fact is said, once, through the notice
 * channel. DECLARED REVERSAL of "the crash is the contract, not a
 * symptom" (owner-lane, 2026-09-04): two instances of this class in two
 * days, one caught by a gate (DC-45) and one by the owner on the first
 * frame of an ordinary command (DC-48). In a gate the crash is right; in
 * a human's hands it costs them the composer and the session to save
 * them a row one column too wide. `KISO_INVARIANTS=throw` is what every
 * suite here runs under).
 *
 * The fold is SGR-AWARE: a line whose bold/dim span would straddle a
 * fold boundary closes the span at the break and reopens it on the
 * next row — the #16b contract (no literal "[2m" fragments) survives
 * folding. displayWidth/charWidth (width.ts) are the width primitives
 * (untouched); render.ts supplies the original text (palette, escape,
 * tint, fold wording).
 */

import { displayWidth, visibleWidth } from "./width.js";
// TUI2-R2pre ④: the ONE display-verb table (strings.ts, beside
// KEY_BINDINGS). strings.js imports only render/width here, so this edge
// adds no cycle.
import { displayVerb } from "./strings.js";
import {
	bannerLines,
	breathFrame,
	escapeTerminal,
	foldThinking,
	foldResult,
	renderTerminalGap,
	renderToolSummary,
	toolTarget,
	kUnit,
	palette,
	currentGround,
	type Palette,
	type ResumeMeta,
	type BannerMeta,
} from "./render.js";
// TUI2-MD: the markdown renderer's surface reaches the tui through this
// module (the tui's components shim re-exports it) — one import edge,
// and it points one way: md.ts measures with the width authority, never
// back through here.
import { renderBlock, type MdBlock } from "./md.js";
export { MdStream, renderBlock, renderMarkdown, type MdBlock, type MdKind } from "./md.js";

/** The spinner glyphs, cycled by the compositor's on-demand tick. */
export const SPINNER = ["▖", "▘", "▝", "▗"];

/** The frame context the compositor passes down — the pieces of time
 *  that make a live render non-deterministic (the running tool's glyph
 *  and elapsed). Everything else is a pure function of the cell. */
export interface FrameCtx {
	readonly spinnerI: number;
	readonly now: number;
	/** The terminal height (rows) — the banner cell's tier input (W1:
	 *  the tier table reads H, so a resize RE-TIERS instead of
	 *  re-folding frozen rows). */
	readonly height: number;
	/** R7a — this cell is drawn UNDER an activity header that carries the
	 *  breathing mark, so its own head row wears a plain gutter.
	 *
	 *  The mark belongs to the ACTIVITY, not to each call in it. A
	 *  four-file burst drew four breathing marks, which is four marks
	 *  distinguishing nothing (law 1.3, the same ground R2 retired the
	 *  tick and cross on) — and worse, on a read that finishes in
	 *  200ms the mark is gone before the eye lands, so per-row it is
	 *  motion that never resolves into meaning. On the header it is lit
	 *  for the whole stretch, which is the fact it is there to carry:
	 *  work is in flight. Owner-ruled 2026-08-31. */
	readonly grouped?: boolean;
	/** R13 E2 / DC-43 — how many PREVIEW rows a running card may take this
	 *  frame. Undefined is the full window (`CAP_PREVIEW`); the compositor
	 *  lowers it when the live region is tight, and 0 degrades the card to
	 *  its head row alone. It is a frame input, not a property of the
	 *  cell: the same call renders taller or shorter as the room changes,
	 *  and never as its own content changes. */
	readonly liveWindow?: number;
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
 *  the compositor enforces on every emitted line). TUI2-MD ⑤: the body
 *  moved to width.ts (the width authority's own home) so the markdown
 *  renderer can measure without importing this module back — the
 *  re-export is verbatim, so every existing importer and the barrel see
 *  exactly what they saw. */
export { visibleWidth } from "./width.js";

/** A component: render the display lines for one piece of state. */
export interface Component {
	render(width: number, ctx: FrameCtx): string[];
}

/** The W11 spacing formula — "a row gets one blank line above it when
 *  the row is itself a block, or when the previous sibling was taller
 *  than one row". One-row siblings pack tight; anything multi-row
 *  breathes on both sides. The FIRST cell never gets the blank (it sits
 *  at the body's top — the banner would otherwise start one row down).
 *  `prev` is the previous sibling's OWN rows (raw — a cell's own blank
 *  must never count toward its height). The blank is a JOIN artifact:
 *  the cell's own render stays blank-free, so per-cell accounting
 *  (heights, the fold cache) never sees a fake row. */
export function bodySpacing(prev: readonly string[] | null, rows: readonly string[]): string[] {
	if (rows.length === 0 || prev === null || prev.length === 0) return rows as string[];
	// R13 D1 — ONE blank between any two elements, whatever their height.
	//
	// W11 spaced by height: one-row siblings packed tight, anything
	// multi-row breathed on both sides. A reader could not tell where the
	// next blank would fall — and worse, the spacing was a function of a
	// cell's CURRENT height, so a cell growing from one row to five moved
	// everything around it. That is the mechanism behind R7a and behind
	// R12 Round 2's settle shift, both of them "the screen moved under
	// the reader".
	//
	// A constant cannot do that: a live block, its settled form and the
	// card it becomes are spaced identically BY CONSTRUCTION, which is
	// exactly what R7a's one-row stand-in was simulating.
	return ["", ...rows];
}

/** The container — vertical concatenation with the W11 formula. No
 *  component decides its own spacing: every blank in the body is the
 *  container's. */
export class Container implements Component {
	constructor(private readonly children: Component[]) {}
	render(width: number, ctx: FrameCtx): string[] {
		const out: string[] = [];
		let prev: string[] | null = null;
		for (const c of this.children) {
			const rows = c.render(width, ctx);
			out.push(...bodySpacing(prev, rows));
			prev = rows;
		}
		return out;
	}
}

// ---- the cell model (the CLI's mutation surface — unchanged from v5) ----

export type BodyCell =
	| { kind: "user"; text: string; done: true; turn: number }
	| { kind: "thinking"; text: string; done: boolean; turn: number }
	| {
			kind: "tool";
			name: string;
			input: string;
			/** W15: the FULL input JSON (pretty-printed) — the display
			 *  summary above is sliced at 60 chars; the expanded block's
			 *  "--- input ---" section mirrors /last and needs it all. */
			inputFull: string;
			childRoles: string[];
			state: "pending" | "approval" | "running" | "done";
			isError: boolean;
			resultText: string;
			diff: import("./diff.js").DiffLine[] | null;
			added: number;
			removed: number;
			startedAt: number | null;
			doneAt: number | null;
			done: boolean;
			/** W15: the live-region expand toggle — while the cell is live
			 *  the FULL body renders in place (the compositor owns those
			 *  rows and redraws them); a committed cell can never toggle
			 *  (history is never rewritten — ADR-0046). */
			expanded: boolean;
			/** W14: the turn boundary — the index of the turn record that
			 *  created this cell (the fold-hold's owner; −1 when no turn
			 *  exists yet — the pre-turn cells never hold). */
			turn: number;
			/** W19: a DENIED call's reason (the CLI extracted it from the
			 *  result's "[Permission denied] " prefix, keyed on the "denied"
			 *  tag). Non-null renders the pinned row — the full call name,
			 *  the target, the reason in the W4 parentheses idiom, NO timing
			 *  metadata (the call never ran). */
			reason: string | null;
			/** A5: the approval verdict — the permission_decided event bound
			 *  into the cell (no free-standing `  approved` orphan row). The
			 *  settled head row aggregates name + status + decidedBy in ONE
			 *  row: a denied call's pinned row gains `· by <decidedBy>`; an
			 *  extension-approved call's settled row gains `· approved by
			 *  <decidedBy>` (the human approval needs no marker — the ❯ →
			 *  spinner → ✓ sequence told the story). Null until a decision
			 *  lands (the auto-allowed calls never have one). */
			verdict: { decision: "approved" | "denied"; decidedBy?: string; reason?: string } | null;
	  }
	/** TUI2-MD ⑤ — ONE markdown block of assistant body text. The cell is
	 *  the commit unit the compositor already had, so block-freeze needs
	 *  no new commit machinery: a CLOSED block is a DONE cell and the
	 *  natural loop freezes it; the OPEN tail block is the one cell left
	 *  live. `block` carries the block's SOURCE (never rendered rows), so
	 *  a resize re-renders it at the new width exactly as every other
	 *  cell does. */
	| { kind: "md"; block: MdBlock; done: boolean }
	| { kind: "notice"; text: string; done: true }
	| { kind: "banner"; version: string; extensionsText: string; resume: ResumeMeta[]; meta?: BannerMeta | undefined; done: true }
	| { kind: "raw"; lines: string[]; done: true; wrap?: "words" }
	| { kind: "terminal"; label: string; line: string; done: true }
	| {
			kind: "checklist";
			/** the model-authored header tail (parseChecklist's count line —
			 *  chat.ts). The compositor's fixed "task" prefix rides BEFORE it
			 *  (W20 naming ruling: never model-controlled). */
			header: string;
			items: { text: string; status: "pending" | "active" | "done" }[];
			/** W20: false while LIVE — the current turn's ONE in-place block
			 *  (the commit loop only takes done cells, so it stays in the
			 *  live region); true once SETTLED — endTurn committed it as the
			 *  turn's one recap block. */
			done: boolean;
			/** W20: the LIVE block's ctrl+o toggle (W15) — the capped form
			 *  flips to the full list in place. The settled render ignores
			 *  it (already full). */
			expanded: boolean;
			/** W20: the wall clock of the block's FIRST call — the settled
			 *  header's duration is clocked from here, compositor-side (the
			 *  CLI stays unchanged). */
			startedAt: number;
			/** W20: the run's duration at the settle — the `2h 14m` form. */
			durationSeconds: number;
			turn: number;
	  };

const TOOL_SUMMARY_MAX = 60; // the tool line's parameter summary, chars

/** The component for one cell — the mapping table lives here so the
 *  compositor stays a pure writer. */
export function cellComponent(cell: BodyCell): Component {
	switch (cell.kind) {
		case "user":
			return new UserMessage(cell);
		case "thinking":
			// R7: the committed/live surface is the BLOCK. ThinkingFold
			// survives for the pipe path (render.ts's foldThinking), whose
			// bytes are asserted by the --plain identity gate.
			return new ThinkingBlock(cell);
		case "tool":
			return new ToolExecution(cell);
		case "md":
			return new MarkdownBlock(cell);
		case "notice":
			return new ErrorLine(cell);
		case "banner":
			return new Banner(cell);
		case "raw":
			return new RawBlock(cell);
		case "terminal":
			return new TerminalBlock(cell);
		case "checklist":
			return new Checklist(cell);
	}
}

/**
 * The user message — the W16 inset chip ALONE (the 2026-08-09 ruling:
 * the ▍ rail and the indent are retired — the rail's stated pipe
 * fallback was theoretical redundancy: the CLI's pipe path is the
 * line-mode "you>" form and never renders UserMessage). The chip folds
 * the text at W−2 (the side pads) and pads every row to the FULL width.
 *
 * R2 — law 1.6's recorded reversal. This used to size the block to its
 * longest row, on the argument that "a short message like /think would
 * paint a bar across the terminal". That optimises the degenerate case
 * at the cost of every real message, which is a paragraph and reads as
 * a block only when the block has an edge. The `/think` case is the
 * accepted price, and it is recorded as such in design.md §1.6.
 *
 * The padding is by cells (charWidth is the width authority), so a CJK
 * row pads by width, never by chars, and the chip never overruns.
 *
 * THE SURFACE IS REVERSE VIDEO, on every ground (owner ruling
 * 2026-09-02, reversing R9 P1 one release after it shipped).
 *
 * R9 P1 moved the chip onto the wash, reading §1.6's "verbatim" as one
 * surface shared by the human's words and the machine's. §1.6 now
 * splits the two, and the split is the reason: reverse video is THE
 * HUMAN'S surface and it is full contrast by construction — it inverts
 * whatever the terminal is, so it is the same weight on every ground
 * and cannot be under-read. The wash is the MACHINE'S verbatim surface
 * (inline code, tool output), where a lighter ground is right because
 * those rows are read as content rather than as an utterance.
 *
 * SGR 7 closed with SGR 27 — never SGR 0, the chip composes with a
 * surrounding span. NEVER dim inside it: reverse video inverts the
 * CURRENT colours, so dimmed text inverts into a dimmed block with no
 * contrast.
 */
/**
 * REL-0152-D13 — how much of a turn the chip shows.
 *
 * Twelve rows is enough to recognise what you sent and short enough
 * that sending it does not scroll away what you were looking at. The
 * bound is on ROWS, after folding, so one enormous line is caught by
 * the same rule as three thousand short ones.
 */
const USER_CHIP_ROWS = 12;
/** R13 D4 — the chip's inner pad: two columns, so its text begins in
 *  the same column as everything else on the page. */
const CHIP_PAD = "  ";

class UserMessage implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		// R13 D4 — TWO columns of inner pad, where R2 had one. The chip
		// keeps its surface (reverse video, one row per folded line, no
		// pad rows — R12 Round 2's ruling stands); what changes is where
		// its text STARTS, so the human's words begin in the same column
		// as the model's (E3) and as a card's rows (E4).
		const chipW = Math.max(1, W - 2 * CHIP_PAD.length);
		const rows: string[] = [];
		// REL-0152-D13: fold only as far as the bound needs. A pasted file
		// has thousands of lines and folding all of them to show twelve is
		// work with no reader — the measurement that opened this finding
		// was a 3000-line turn writing 260,298 bytes in one frame.
		const paras = this.cell.text.split("\n");
		let truncated = false;
		// DC-6: the folded CONTENT first, then ONE width over all of it.
		// The pad used to be computed per source paragraph, so a message
		// with two lines drew as two bars of two different lengths — a
		// ragged right edge on a block that is one block. A single
		// paragraph was always correct, which is why it survived: the
		// shape only appears once a message has a second line.
		const content: string[] = [];
		for (const para of paras) {
			if (content.length >= USER_CHIP_ROWS) {
				truncated = true;
				break;
			}
			// R9 Q3: by WORD. The char fold was defended as lossless, and
			// that argument does not survive CJK — a run with no spaces has
			// nothing to lose — while every other prose surface in the
			// product already folds by word (ErrorLine, VD-10). foldWords
			// falls through to foldLine's hard break for a word wider than
			// the row, so invariant ① still outranks the word.
			for (const row of foldWords(escapeTerminal(para), chipW)) {
				if (content.length >= USER_CHIP_ROWS) {
					truncated = true;
					break;
				}
				content.push(row);
			}
		}
		// R2 (law 1.6's recorded reversal): the band is FULL WIDTH. It was
		// sized to its longest row, on the argument that a one-word turn
		// like `/think` would otherwise paint a bar across the terminal —
		// which optimises the degenerate case at the cost of every real
		// message. The human's words are the one surface that gets the
		// whole row.
		//
		// displayWidth stays the padding authority (never `length`): a CJK
		// row is two cells per character and pads by cells.
		const inner = chipW;
		for (const row of content) {
			rows.push(`${p.rv}${CHIP_PAD}${row}${" ".repeat(Math.max(0, inner - displayWidth(row)))}${CHIP_PAD}${p.rvEnd}`);
		}
		if (!truncated) return rows;
		// The notice is OUTSIDE the chip's reverse video, in the cut-row
		// vocabulary the rest of the product uses, and it says the thing
		// that matters: the model got all of it. A bounded display of a
		// complete message is not a truncated message, and the row has to
		// make that difference visible or it reads as data loss.
		const shown = rows.length;
		const total = paras.length;
		const more = Math.max(0, total - shown);
		// DC-45: THE NOTICE FOLDS TOO. It was written at a fixed 30 columns
		// and emitted verbatim at every width, so a paste of thirteen lines
		// in a terminal narrower than the sentence tripped the compositor's
		// invariant ① and killed the session. The tiers are TUI2-R1.5 ⑤'s
		// discipline: `sent in full` is the SEMANTICS — the whole reason
		// the row exists — so the count gives way before it, and `cutLine`
		// is the backstop that holds at any width there is.
		const count = more > 0 ? `+${more} more line${more === 1 ? "" : "s"}` : "cut here";
		const short = more > 0 ? `+${more}` : "cut";
		rows.push(
			cutLine(
				`${p.dim}\u2514 ${pickTier([`${count} \u00b7 sent in full`, `${short} \u00b7 sent in full`, "sent in full", count], Math.max(1, W - 2))}${p.reset}`,
				W,
			),
		);
		return rows;
	}
}

/** W22: the pending-queue chips — queued user lines pre-render above
 *  the input row as the SAME UserMessage chip (undimmed: reverse video
 *  inverts the CURRENT colours, so a dim span would invert into a
 *  dimmed block), the dim `□` gutter marking the queued
 *  state (the gutter rides EVERY row — the gutterFold precedent: the
 *  left edge alone distinguishes the states). Each chip folds at W−3
 *  (the gutter's 2 cells), so a long line hard-folds INSIDE the chip
 *  and invariant ① holds on the band. */
export function pendingQueueRows(lines: readonly string[], W: number): string[] {
	const p = palette();
	const out: string[] = [];
	for (const line of lines) {
		for (const row of new UserMessage({ text: line }).render(Math.max(1, W - 3), { spinnerI: 0, now: 0, height: 0 })) {
			out.push(`${p.dim}□${p.reset} ${row}`);
		}
	}
	return out;
}

/** The thinking fold — one dim line, width-capped so the /think suffix
 *  rides the fold's own row (the #17 fix's slice, componentized). The
 *  slice is DISPLAY-WIDTH-based (the char-based slice overflowed with
 *  CJK — 2 cells per char — and tripped invariant ① on a real
 *  Chinese session). W2: the leading ⋯ is the thinking gutter — the
 *  midline mark (the state), never the text ellipsis (the truncation). */
/**
 * R7 — THINKING IS A BLOCK OF WORDS.
 *
 * The owner's ruling, arrived at from a side-by-side with pi's screen:
 * the model's reasoning reads as its own paragraphs — italic, dim,
 * indented two — and is never folded away. `ThinkingFold` (below, kept
 * for the pipe path) summarised it to one row with a key; four rounds
 * of machinery were then built to hand the rest back, and the owner's
 * complaint through all of them was the same sentence: I cannot see
 * what it was thinking.
 *
 * THE INDENT IS NOT DECORATION. Law 1.2 is SETTLED — "strip every
 * escape sequence and no fact is lost" — and italic is SGR 3, which a
 * pipe strips and `COLOR_OFF` empties outright. Stripped, an italic
 * paragraph and the model's ANSWER are the same bytes, and the reader
 * cannot tell the reasoning from the reply. The two-space indent is the
 * byte that survives: reasoning sits in, the answer stands at the
 * margin. The owner chose this over the un-indented form for exactly
 * that reason, with the cost stated.
 *
 * Paragraphs are preserved (a blank line between them); the newlines
 * INSIDE a paragraph collapse, because a hard-wrapped source line is
 * the model's line width, not the reader's.
 */
class ThinkingBlock implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const text = escapeTerminal(this.cell.text).trim();
		if (text === "") return [];
		// DC-47 — THINKING GOES ONE LEVEL DEEPER THAN PROSE, and the
		// reason is a law rather than a taste.
		//
		// §7.2: the indent is the price of §1.2 — italic and dim are
		// escape sequences, so a rendered frame with its colour stripped
		// (a terminal capture, a paste out of the scrollback, a log of
		// what was drawn) would lose the line between the model's
		// reasoning and its answer. R13's E3 moved PROSE to column 2,
		// which is where the thinking already was, so after
		// `sed 's/\x1b\[[0-9;]*m//g'` the two became the same row.
		// Measured, not reasoned: both rendered
		// `"  Weighing the two shapes."` exactly.
		//
		// NOT a pipe, though §7.2 used to say so: `thinkingEnd`'s inactive
		// path writes `foldThinking` — one dim line — so a pipe never sees
		// a thinking paragraph to confuse with prose.
		//
		// So the thinking takes the next column in. It is still the only
		// carrier that survives a pipe, and it is still one indent step —
		// what moved is which step, because prose took the one it had.
		const room = Math.max(1, W - THINK_COL.length);
		const rows: string[] = [];
		for (const para of text.split(/\n\s*\n/)) {
			const flat = para.replace(/\s+/g, " ").trim();
			if (flat === "") continue;
			if (rows.length > 0) rows.push("");
			// foldLine is the ONE width authority and returns real rows —
			// invariant ①b (a row is one physical row) holds by
			// construction rather than by remembering to split.
			for (const line of foldLine(flat, room)) rows.push(`${THINK_COL}${p.dim}${p.italic}${line}${p.italicEnd}${p.reset}`);
		}
		return rows;
	}
}

class ThinkingFold implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const block = this.cell.text;
		// R3f — the fold is ONE ROW, so its text is one line.
		//
		// `escapeTerminal` strips C0 but KEEPS \n and \t, and
		// `charWidth(0x0A)` is 1 — so a multi-line thinking block sailed
		// through every width check as a legal single row, and the
		// terminal then wrapped it across the chrome. That shipped in
		// 0.16.6 and is what smashed the composer: a model whose thinking
		// opens with a numbered plan ("1. …\n2. …") produces exactly it.
		// Invariant ①b now catches the class at the emit; this stops
		// producing it. Whitespace collapses because the row is a
		// SUMMARY — the full text is one ctrl+o away, unchanged.
		const trimmed = escapeTerminal(block.trim()).replace(/\s+/g, " ");
		// R2 (owner, 2026-08-27) — three changes, each independent.
		//
		// ITALIC marks the row as not-the-answer without spending a colour,
		// on the same argument that admitted italic to the alphabet.
		//
		// The cut lands on a WORD. It used to cut on a byte, so the fold
		// read as `…the user's h` and the reader's eye had to reassemble a
		// word it already knew.
		//
		// The affordance moves to the RIGHT EDGE, so the left edge of every
		// row on screen is content. The char count goes with the move: it
		// told the reader nothing they could act on, and the row it was
		// crowding is the one thing this cell says.
		//
		// The ≤100 short-circuit stays width-aware: a short block at a
		// narrow width returned the line UNFOLDED and tripped invariant ①.
		// DC-15: the affordance is DROPPED, not squeezed. `room` floored at
		// 1 while `pad` floored at 1 independently, so a narrow terminal
		// produced 2 + cut + pad + 6 = 11 cells no matter what W was — and
		// invariant ① does not truncate, it THROWS. Measured 11 cells at
		// every W ≤ 10. Below the width where the tail and one word of
		// content can both stand, the row is the CONTENT: a cell that
		// cannot hold the key's name has nothing to say about the key.
		const tail = "/think";
		const room = W - 2 - tail.length - 1;
		// the belt: cutLine is SGR-aware and single-row, so the invariant
		// holds by CONSTRUCTION at every width rather than by arithmetic
		// that has to be re-proved every time a span moves.
		if (room < 2) return [cutLine(`${p.dim}⋯ ${p.italic}${wordCut(trimmed, Math.max(1, W - 2))}${p.italicEnd}${p.reset}`, W)];
		const cut = wordCut(trimmed, room);
		const body = `⋯ ${p.italic}${cut}${p.italicEnd}`;
		const pad = Math.max(1, W - 2 - visibleWidth(cut) - tail.length);
		return [cutLine(`${p.dim}${body}${" ".repeat(pad)}${tail}${p.reset}`, W)];
	}
}

/** R2 — cut at a word boundary, with the honest ellipsis. widthCut cuts
 *  at a cell, which is right for verbatim output and wrong for prose:
 *  the reader has to reassemble "h" into "home". Falls back to the cell
 *  cut when the first word alone overruns, because a row that cannot
 *  hold one word has no boundary to find. */
function wordCut(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	const hard = widthCut(text, Math.max(1, room - 1));
	const at = hard.lastIndexOf(" ");
	return `${at > room / 3 ? hard.slice(0, at) : hard}\u2026`;
}

/** Fold a line's CONTENT at W−2 and prefix EVERY row with the gutter
 *  (W2: a wrapped tool row keeps its state mark — the left edge alone
 *  distinguishes the states at --plain; the UserMessage rail precedent,
 *  v5 #16f). The gutter carries its own SGR (e.g. the bold ✓). W21:
 *  exported for the approval panel's text args (the same │ gutter). */
/**
 * TUI2-R1.5 ⑨ (VD-10) — the WORD-aware fold, for text a human reads.
 *
 * foldLine is a hard character fold at the width. That is exactly right
 * for verbatim tool output, where a byte is a byte and a break is a
 * display artefact the reader knows to ignore; it is exactly wrong for
 * prose, where the reader's eye has to reassemble "ex" + "pected" into a
 * word it already knew. The walkthrough read three of those off one
 * screen.
 *
 * The implementation is a wrapper, not a second engine: the text is cut
 * at the last space that fits and each resulting segment is handed to
 * foldLine, which keeps the SGR close/reopen discipline, the display-
 * width arithmetic and the newline handling in ONE place. A word longer
 * than the width falls through to foldLine's hard break — an
 * overflowing row would violate invariant ①, and a word that cannot fit
 * has to be broken somewhere.
 */
/** The SGR spans still open at the end of `text`, given those open at
 *  its start. A reset closes everything; anything else stacks. */
function spansOpenAfter(text: string, before: readonly string[]): string[] {
	let open = [...before];
	for (const m of text.matchAll(/\x1b\[[0-9;]*m/g)) {
		if (m[0] === "\x1b[0m") open = [];
		else open.push(m[0]);
	}
	return open;
}

export function foldWords(line: string, W: number): string[] {
	if (W < 1) return [line];
	const out: string[] = [];
	for (const para of line.split("\n")) {
		if (visibleWidth(para) <= W) {
			out.push(para);
			continue;
		}
		let rest = para;
		// the spans open at the cut point, so each emitted row closes them
		// and the next row reopens them — foldLine's own discipline, applied
		// across the segments this function creates.
		let open: string[] = [];
		while (visibleWidth(rest) > W) {
			// the widest prefix that fits, then back up to the last space in
			// it — the SGR-aware cut keeps the spans intact
			const head = widthCut(rest, W);
			const at = head.lastIndexOf(" ");
			if (at <= 0) break; // one long word (or no space at all) — hard-break it
			const cut = head.slice(0, at);
			out.push(`${cut}${open.length > 0 || /\x1b\[[0-9;]*m/.test(cut) ? "\x1b[0m" : ""}`);
			open = spansOpenAfter(cut, open);
			rest = `${open.join("")}${rest.slice(cut.length + 1)}`;
		}
		out.push(...foldLine(rest, W));
	}
	return out.length > 0 ? out : [""];
}

export function gutterFold(gutter: string, line: string, W: number): string[] {
	const textW = Math.max(1, W - 2);
	return foldLine(line, textW).map((r) => `${gutter}${r}`);
}

/** A6: the tool-header variant — ONE cut row, never a fold. A wide
 *  header (a long target path, a wordy denial reason) used to wrap
 *  through foldLine — every wrapped row repeated the gutter, the
 *  settled row grew past its previewed height. The header names the
 *  call — the ellipsis marks the cut, the body below still carries the
 *  full content. The budget: the gutter's own visible width + the
 *  ellipsis ride the row (the invariant ① cap holds). */
export function gutterCut(gutter: string, line: string, W: number): string[] {
	const gutterW = visibleWidth(gutter);
	const textW = Math.max(1, W - gutterW - 1);
	const cut = widthCut(line, textW);
	return [`${gutter}${cut}${visibleWidth(line) > textW ? "…" : ""}`];
}

/** Lines without the phantom empty line after a trailing newline. */
function countLines(text: string): number {
	if (text === "") return 0;
	const parts = text.split("\n");
	return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** W4: the settled-row metadata — the human summary in parentheses. The
 *  separation NEVER relies on dim: a pipe drops the SGR, and the shapes
 *  below read at full strength with the palette off. read → the line
 *  count ("912 lines"; "200 of 3412 lines" when the tool cut it — the
 *  note names the remainder; ≥1000 k-formats, "2.4k lines"); write/edit
 *  → the ± diff stats (the approval diff's counts — an auto-allowed
 *  write never computed one, so the input's own counts fall back, then
 *  the result's line count); shell → the exit code (parsed from the
 *  failure text — the tool names it — 0 on success); a non-shell error
 *  → the error text's first line; anything else → the result's line
 *  count. */
function settledMeta(c: { name: string; input: string; resultText: string; added: number; removed: number; isError: boolean }): string {
	if (c.isError) {
		// a shell EXECUTION failure names its code first ("exit 1: …") —
		// that IS the metadata, and the body shows the full text. A
		// shell without the code (a denial, a precondition) is not an
		// exit failure: the first line stays the metadata, exactly like
		// any other error.
		if (c.name === "shell" && /^exit \d+/.test(c.resultText)) return `exit ${/^exit (\d+)/.exec(c.resultText)![1]}`;
		return c.resultText.split("\n")[0]!.slice(0, 60);
	}
	if (c.name === "read_file") {
		const noteAt = c.resultText.lastIndexOf("\n… ");
		const shown = countLines(noteAt >= 0 ? c.resultText.slice(0, noteAt) : c.resultText);
		const more = noteAt >= 0 ? /(\d+) more lines?/.exec(c.resultText.slice(noteAt)) : null;
		const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
		if (more !== null) {
			const total = shown + Number(more[1]);
			return `${shown} of ${total} line${total === 1 ? "" : "s"}`;
		}
		return `${k(shown)} line${shown === 1 ? "" : "s"}`;
	}
	if (c.name === "write_file" || c.name === "edit_file") {
		if (c.added + c.removed > 0) return `+${c.added} -${c.removed}`;
		// no approval diff (an auto-allowed write): the input summary may
		// be sliced at TOOL_SUMMARY_MAX — best-effort, then the last resort
		let parsed: { content?: unknown; search?: unknown; replace?: unknown } | null = null;
		try {
			parsed = JSON.parse(c.input);
		} catch {
			parsed = null;
		}
		if (c.name === "write_file" && parsed !== null && typeof parsed.content === "string") {
			return `+${countLines(parsed.content)}`;
		}
		if (c.name === "edit_file" && parsed !== null && typeof parsed.search === "string" && typeof parsed.replace === "string") {
			const added = countLines(parsed.replace);
			const removed = countLines(parsed.search);
			if (added + removed > 0) return `+${added} -${removed}`;
		}
	}
	if (c.name === "shell") return "exit 0";
	const n = countLines(c.resultText);
	return `${n} line${n === 1 ? "" : "s"}`;
}

/** The parsed tool target — the head-row form shared by the W19 pinned
 *  row (full call name + target) and the A4 settled row (verb + target):
 *  read/write/edit → the path, shell → the command, list_dir → path ??
 *  "(root)". Parsed from the FULL input — the folded summary is a
 *  truncated slice. */
/** TUI2-R1.5 ④(a) (VD-4) — the header text for a cell that has NOT
 *  settled yet (queued, awaiting approval, running).
 *
 *  These three states printed `c.input`: a 60-char slice of the call's
 *  JSON, escapes and all. The done card printed the plain command
 *  through toolTarget, so the SAME call read as
 *  `shell {"command":"for i in 1 2 3 4 5 6; do echo \"step $i · compil`
 *  while it ran and as `shell for i in 1 2 3 4 5 6; …` a second later.
 *  One formatter now, for every state. A cell whose full input somehow
 *  will not parse keeps the old slice — the header always says
 *  something. */
function liveTarget(c: Extract<BodyCell, { kind: "tool" }>): string {
	const target = toolTargetOf(c);
	return escapeTerminal(target === "?" ? c.input : target);
}

function toolTargetOf(c: Extract<BodyCell, { kind: "tool" }>): string {
	let input: Record<string, unknown> = {};
	try {
		input = JSON.parse(c.inputFull) as Record<string, unknown>;
	} catch {
		// the full JSON is always parseable (stringified at toolStart)
		// — the empty fallback never fires
	}
	return toolTarget(c.name, input);
}

/** The tool execution line + the bounded block — every state is its
 *  own render; the lines fold (the summary gives way first). W7 (the
 *  flow contract): the block's BODY (the rows below the header) is
 *  capped in SCREEN rows AFTER the fold, at the current width — the
 *  renderer-cut row (`└ +N … · ctrl+o`) sits INSIDE the cap (a
 *  truncated block is cap−1 output rows + the cut row); the TOOL-cut
 *  row (`└ capped by …` — the tool's OWN truncation note, W10) is a
 *  DIFFERENT fact, never counted in the output cap. W3: the verb is
 *  stripped of its "_file" suffix and padded to 5 columns — the target
 *  paths line up (the pipe path strips the same suffix, render.ts —
 *  both paths print the same verb; a verb ≥ 5 columns is not padded).
 *  The block's cut note keeps the RAW name (it names the tool the
 *  model should call again). W4: the settled row's parentheses hold
 *  the human metadata (settledMeta) — the input summary lived in the
 *  running row; the OUTCOME is what the settled row says. A4: the
 *  settled row keeps the TARGET — verb + target + outcome, the running
 *  row's summary column (the W19 pinned row keeps the full call name
 *  instead). A5: the verdict rides the head row — a decidedBy present
 *  on the cell appends `· approved by X` (extension auto-approvals) or
 *  `· by X` on the pinned deny; the human decision needs no marker. */
class ToolExecution implements Component {
	constructor(private readonly cell: Extract<BodyCell, { kind: "tool" }>) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const c = this.cell;
		const verb = escapeTerminal(displayVerb(c.name));
		const verbCol = verb.length < 5 ? `${verb}${" ".repeat(5 - verb.length)}` : verb;
		// R13 — the W13 rollup row and TUI2-R1 (B)'s exploration row stood
		// here, ahead of everything else a settled call could be. Both are
		// retired with the `rolled` field they read (see the compositor's
		// #foldOrRollup for the reversal in full).
		if (c.state === "done") {
			// R3i phase 5: an answered (or declined) ask_user renders its
			// OWN block — the questions and what the human said. The row
			// it replaces was `  ask_user  (3 lines, 41.2s)`: an empty
			// target and the answers thrown away, though the result
			// already carried them. `askedBlock` returns [] for anything
			// that is not the ask's own JSON, so a payload this renderer
			// did not write can never be guessed at.
			if (c.name === "ask_user" && c.reason === null && !c.isError) {
				const asked = askedBlock(c.resultText, c.startedAt !== null && c.doneAt !== null ? (c.doneAt - c.startedAt) / 1000 : 0, W);
				if (asked.length > 0) return asked;
			}
			// W19: the pinned deny — the claimed shape verbatim: the FULL
			// call name (the denial names the call), the target, the reason
			// in the W4 parentheses idiom, no timing (the call never ran).
			// The same ✗ family as any failure; the [result ✗] body still
			// rides below (never hide information). A5: an extension's
			// denial appends `· by <decidedBy>` — the aggregated head row
			// names the decider; a human denial (no decidedBy) has no tail.
			if (c.reason !== null) {
				const by = attribution(c);
				const out = gutterCut("  ", `${p.red}${escapeTerminal(`${c.name} ${toolTargetOf(c)}`)} (${escapeTerminal(c.reason)}${by})${p.reset}`, W);
				out.push(...toolBlockBody(c, W, ctx));
				return out;
			}
			const elapsed = c.startedAt !== null && c.doneAt !== null ? ((c.doneAt - c.startedAt) / 1000).toFixed(1) : "?";
			// TUI2-R1.5 ⑤ (VD-6): the line count is stated EXACTLY ONCE. Every
			// read card carried it twice — `(2 lines, 0.0s) · 2 lines · ctrl+o
			// expands` — because the parens and the suffix were written by
			// different rounds, each unaware the other was counting. The
			// SUFFIX keeps it (it is the one that also names the key), so a
			// meta that says only "<n> lines" drops out when a suffix will
			// carry it. A meta that says something else — read_file's
			// "200 of 250 lines", a diff's "+1 -1", a shell's "exit 0" — is a
			// different fact and stays.
			const rawMeta = settledMeta(c);
			// VD-6's suppression RETIRED with the thing it was suppressing.
			// A read card said `(2 lines, 0.0s) · 2 lines · ctrl+o expands`
			// because the parens and the suffix were written by different
			// rounds, each unaware the other was counting; the fix blanked
			// the meta whenever the suffix would repeat it. R13 takes the
			// count OUT of the suffix, so there is one place again and the
			// meta is it — blanking it now would drop the fact entirely.
			// "Stated exactly once" is unchanged and is what `countedHead`
			// below preserves: a meta that already counts lines gets no
			// second count beside it.
			const meta = escapeTerminal(rawMeta);
			// A4: the target rides the settled head row — the verb's
			// summary column (W3's 5-char pad keeps the paths lined up).
			// A5: an extension's auto-approval appends `· approved by
			// <decidedBy>` — the "why wasn't I asked" answer; the human
			// approval (no decidedBy) leaves the row unchanged.
			const approvedBy = attribution(c);
			// TUI2-R1 (A): the card names its own key — the suffix rides the
			// settled head row.
			// TUI2-R1.5 ④(c): the suffix is now RESERVED rather than given
			// the leftovers. It used to take the width that happened to be
			// left, so a long command spent it all and the row said nothing
			// about the seven lines behind the key — tolerable while the
			// body was on screen, a silence now that the body is not. The
			// command is the cuttable span (the approval panel's option-2
			// rule name is the same idea); the affordance is the semantics.
			const hidden = hiddenLines(c, W);
			// TUI2-R1.5 ⑤: the shortest tier is RESERVED — the affordance is
			// the semantics. TUI2-R1.5 pin 4: and the parts give way in a
			// PINNED ORDER, rather than whichever happened to be last.
			const nAll = countLines(c.resultText);
			const countedHead = nAll > 0 && !/^\d+( of \d+)? lines?$/.test(rawMeta) ? `${nAll} line${nAll === 1 ? "" : "s"}` : "";
			const text = settledHeadText(verbCol, escapeTerminal(toolTargetOf(c)), meta, approvedBy, elapsed, W - 2 - (hidden === null ? 0 : SUFFIX_MIN), countedHead);
			// R2 (owner, 2026-08-27): no tick, no cross. A symbol earns its
			// cell by carrying a fact the words do not, and a row that
			// already says `exit 0` does not need one more thing saying it
			// went fine. The gutter is two spaces; the OUTCOME lives in the
			// metadata, in words, which is also the only form that survives
			// a pipe with the colour stripped. A failure keeps its colour
			// AND its words — see settledMeta.
			const body = toolBlockParts(c, W, ctx).rows;
			if (body.length > 0 && c.expanded) {
				// An EXPANDED block is already showing everything, and its own
				// footer ("ctrl+o collapses") is what closes it. Giving it an
				// outcome row as well would put two closing rows on one block
				// and move the metadata off a head row every width gate pins.
				// It takes the SURFACE and nothing else.
				const head = c.isError ? `  ${p.red}${text}${p.reset}` : `  ${text}`;
				return slabBlock(appendSuffix(head, expandSuffix(hidden, W - visibleWidth(head))), body, null, W);
			}
			if (body.length > 0) {
				// R13 — THE CARD, when there is something to preview: the head
				// row names the call, the preview sits inside, and the outcome
				// CLOSES it on its own line (§7.5's words, moved off the head
				// row because the head row is no longer the only row). D6: the
				// target is bold there — the head row's job is to say WHAT was
				// run, and the metadata has its own row now.
				//
				// A failure takes NO tint on the head row (R9): only the
				// outcome word is coloured, which is §1.2 exactly — the
				// colour rides the fact, not the object that carries it.
				const target = escapeTerminal(toolTargetOf(c));
				const head = cutLine(`  ${verbCol} ${p.bold}${target}${p.reset}`, W);
				// §7.5's outcome, in words, on its own row: what happened, how
				// much of it there was, how long it took. The count is stated
				// exactly ONCE (VD-6) — a meta that already counts lines does
				// not get a second count beside it.
				const n = countLines(c.resultText);
				const counted = n > 0 && !/^\d+( of \d+)? lines?$/.test(rawMeta) ? `${n} line${n === 1 ? "" : "s"}` : "";
				// pin 4's order, on the row that carries the core now: the
				// ATTRIBUTION drops first, then the count, and the core —
				// what happened and how long it took — is never cut open.
				const join = (...xs: string[]): string => xs.filter((x) => x !== "").join(" · ");
				const attr = approvedBy.replace(/^ · /, "");
				const words = pickTier(
					[join(meta, counted, `${elapsed}s`, attr), join(meta, counted, `${elapsed}s`), join(meta, `${elapsed}s`), meta],
					W - visibleWidth(noteIndent()),
				);
				const outcome = c.isError ? `${p.red}${words}${p.reset}` : words;
				return slabBlock(head, body, outcome, W);
			}
			// R13 — nothing to preview: the SAME card, three rows, with the
			// outcome riding the head row because there is nothing between
			// them to close.
			//
			// DECLARED REVERSAL of the owner's 2026-09-02 narrowing ("a call
			// with no output on screen has no slab at all"), which read §1.6
			// as giving the wash to the machine's VERBATIM text only. The
			// ruling of 2026-09-03 supersedes it: the surface says WORK, not
			// VERBATIM, and a page where some calls are cards and others are
			// loose rows is the instability the owner was pointing at. §1.6
			// moves with it.
			const bare = c.isError ? `  ${p.red}${text}${p.reset}` : `  ${text}`;
			return slabBlock(appendSuffix(bare, expandSuffix(hidden, W - visibleWidth(bare))), [], null, W);
		}
		if (c.state === "approval") {
			// W2: the ❯ is the GUTTER (the left edge), never the line's tail
			const out = gutterCut(`${p.bold}❯${p.reset} `, `${verbCol} ${liveTarget(c)}`, W);
			out.push(...toolBlockBody(c, W, ctx));
			return out;
		}
		if (c.state === "running") {
			// W2: the spinner IS the gutter (the left edge); the elapsed
			// rides the summary's tail.
			// TUI2-R1.5 ④(a) (VD-4): the duration is its OWN trailing segment.
			// It used to be concatenated into the text BEFORE the cut, so a
			// header wider than the row lost it entirely or, worse, kept it
			// welded to the last surviving characters of a cut word
			// ("compil 1s"). The head is cut against the room the duration
			// leaves; the duration then rides the row, always legible.
			const elapsed = c.startedAt !== null ? Math.max(1, Math.round((ctx.now - c.startedAt) / 1000)) : 1;
			const dur = ` · ${elapsed}s`;
			// R3 (design §5.2): a running command BREATHES — one glyph, seven
			// greys, bottoming out on the ground's dim token (§2.2 applies
			// mid-animation, not just at rest). The quadrant spinner it
			// replaces ROTATED, which §5.3 forbids for a call whose duration
			// cannot be predicted: a turning mark implies progress the
			// product does not have. With no ground the breath freezes to a
			// static `●` and says the same thing more quietly.
			// R13 E2 — A RUNNING CALL IS THE SAME CARD, allocated at the
			// SETTLED card's height from its first frame. The settle then
			// changes CONTENT and never position: the spinner becomes two
			// spaces in the same two columns, the live window gives back
			// the rows the result did not need, and the metadata row that
			// said `3s` says `exit 0 · 90 lines · 3.2s`.
			//
			// The elapsed moves OFF the head row onto that metadata row,
			// which is where the settled card keeps it — the head row's job
			// is to say what is running, and it says the same thing before
			// and after.
			//
			// DC-43: with too little room for the seven-row skeleton (two
			// pads, the head, two blanks, one preview row and the metadata)
			// there is no card — the call keeps its head row until it
			// commits, which is the one form that fits anywhere.
			const liveRows = ctx.liveWindow ?? CAP_PREVIEW;
			const gutter = ctx.grouped === true ? "  " : `${breathFrame(ctx.spinnerI)} `;
			if (liveRows <= 0) {
				// the degraded form is the head row ALONE, so it keeps the
				// duration it would otherwise have lost with its card — cut
				// against the room the duration leaves (VD-4: the duration
				// is its own segment, never welded to a cut word).
				const bare = gutterCut(gutter, `${verbCol} ${liveTarget(c)}`, Math.max(4, W - dur.length));
				return [`${bare[0]!}${p.dim}${dur}${p.reset}`];
			}
			// DC-46 — the two GESTURES ride the status row, where they cost
			// nothing. They were a footer INSIDE the window, spending one of
			// its rows on a sentence that is not output; with the window
			// grown from its content, that row was the difference between a
			// settle that swaps content and one that changes height. The
			// row's shape is the settled outcome row's, so the settle
			// rewrites it in place: `3s · esc stops` → `exit 0 · 90 lines ·
			// 3.2s`.
			const gestures = c.name === "shell" ? " · esc stops · alt+⏎ redirects" : "";
			const status = pickTier([`${elapsed}s${gestures}`, `${elapsed}s`], Math.max(1, W - visibleWidth(noteIndent())));
			const live = toolBlockBody(c, W, ctx);
			if (live.length > 0) return slabBlock(gutterCut(gutter, `${verbCol} ${liveTarget(c)}`, W)[0]!, live, status, W);
			// DC-48 — THE THREE-ROW CARD IS ONE ROW, so it is assembled here
			// against the room it actually has.
			//
			// This branch used to cut the head to `W` and hand it to
			// `slabBlock`, which joins head and outcome and cut nothing —
			// so the row came out `W` wide PLUS the whole status, and the
			// compositor did what it promises: it threw. On the owner's
			// 80-column terminal a long `find` produced a 113-column row on
			// its FIRST FRAME, which is the first second of every command.
			//
			// Pin 4's order: the command is the cuttable span and the
			// elapsed is never cut open, so the command takes what the
			// status leaves — the `· ` between them and the two-column
			// gutter included.
			// the status takes its own tier against the room the row has, not
			// against a whole width: on a narrow terminal the gestures give
			// way so the COMMAND keeps something to say, and the elapsed —
			// pin 4's core — never does.
			const MIN_TARGET = 10; // the gutter, the verb column, a character of command
			const oneRow = pickTier([`${elapsed}s${gestures}`, `${elapsed}s`], Math.max(1, W - MIN_TARGET - 3));
			const room = Math.max(4, W - visibleWidth(oneRow) - 3);
			const only = gutterCut(gutter, `${verbCol} ${liveTarget(c)}`, room)[0]!;
			return slabBlock(`${only}${p.dim} · ${oneRow}${p.reset}`, [], null, W);
		}
		// W2: ◦ replaces → for QUEUED — · is the separator inside every
		// metadata group; a queued marker that is also the separator
		// glyph reads as noise
		return gutterCut(`${p.dim}◦${p.reset} `, `${verbCol} ${liveTarget(c)}`, W);
	}
}

// ---- TUI2-R1 (A): the self-naming expand affordance ----

/**
 * TUI2-R1 (A) — how many lines a COLLAPSED settled cell is hiding, or
 * null when it hides nothing.
 *
 * The affordance is a statement about hidden content: a cell whose body
 * is already whole on screen must not advertise a key that would show it
 * the same thing, and a cell that already carries its own renderer cut
 * (`└ +N earlier rows · ctrl+o`, `└ +N more · ctrl+o`) already teaches
 * the key at the place the content stops. What is LEFT — and it is the
 * common case — is every settled non-shell call, whose collapsed body is
 * empty: the whole result sits behind the key with nothing on screen
 * saying so.
 *
 * The count is the RESULT's own line count (the tool's truncation note
 * included — it is a line the expand will show), never a row count and
 * never a cap.
 */
function hiddenLines(c: Extract<BodyCell, { kind: "tool" }>, W: number): number | null {
	if (c.expanded || c.state !== "done" || c.reason !== null) return null;
	if (c.name === "delegate") return null; // its body is the one-line summary, always whole
	const n = countLines(c.resultText);
	if (n === 0) return null;
	if (c.isError) return null; // errorBody's own cut row is the affordance there
	// R13: a call that PREVIEWS carries the key on its own note row when
	// something is cut, and needs no affordance at all when nothing is.
	// A head-row suffix as well would be TUI2-R1's two affordances for
	// one cell — the thing that rule exists to forbid. read_file is the
	// one call with no preview (E1), so the key lives on its head row.
	if (c.name !== "read_file") return null;
	return n;
}

/**
 * TUI2-R1 (A) — the suffix, in the width that is LEFT.
 *
 * Three tiers, degrading: the full form teaches the key AND what it
 * does, the terse form keeps the count and the key, the bare form keeps
 * the key alone. Below that the row is left exactly as it is today — the
 * affordance is worth a suffix, never worth cutting the path the row
 * exists to name (invariant ① holds by construction: the tier is chosen
 * against the room the row actually has).
 */
/** TUI2-R1.5 ⑤ — the cells a settled head row reserves for its
 *  affordance: exactly the shortest tier, " · ctrl+o". The suffix used
 *  to take whatever width happened to be left, so a long target spent it
 *  all and the card said nothing about the lines behind the key. Every
 *  row that fitted its head before still fits it; only a head that would
 *  have eaten the whole row gives up its last nine cells. */
const SUFFIX_MIN = " · ctrl+o".length;

/**
 * TUI2-R1.5 pin 4 — the settled head row's text, with a PINNED cut
 * order.
 *
 * The row carries four things of very different value, and until now a
 * single trailing widthCut decided between them by position: the parens
 * came last, so the parens were what got cut. The walkthrough caught
 * both consequences —
 *
 *   ✓ shell printf '…' 1 2 … 12 (exit 0 · approv… · ctrl+o
 *   ✓ shell for i in 1 2 3 …                          … · ctrl+o
 *
 * — an UNCLOSED parenthesis, and a row that lost the exit code and the
 * duration to a command string that had no claim on them. A cut that
 * leaves `(exit 0 · approv…` has not shortened a fact, it has broken
 * one: the reader is left holding the beginning of a sentence.
 *
 * The order, tightest last:
 *   1. the affordance is already reserved by the caller (⑤);
 *   2. the RESULT CORE — `(exit 0, 3.0s)`, `(+1 -1, 0.2s)` — renders
 *      whole, closing paren included, or not at all;
 *   3. the ATTRIBUTION segment drops before the core is touched: it is
 *      a note about who decided, and the result is what happened;
 *   4. the COMMAND/target truncates with `…`. It is the most
 *      compressible thing on the row — a reader recognises a command
 *      from its head — and it is the only part with a natural ellipsis.
 */
function settledHeadText(verbCol: string, target: string, meta: string, attr: string, elapsed: string, room: number, counted = ""): string {
	// R13 — ONE GRAMMAR FOR BOTH CARDS. This row used to close with W4's
	// parentheses — `read  a.ts (0.1s) · 10 lines · ctrl+o expands` —
	// while the bodied card's outcome row said `exit 0 · 90 lines · 0.4s`
	// in a `·` chain. Two shapes for the same facts, and which one a call
	// got depended on whether it happened to have a preview. The chain
	// wins: it is the one the outcome row already uses, it reads in one
	// direction, and it puts the elapsed where the other card puts it.
	//
	// The giving-way order is pin 4's, unchanged: the ATTRIBUTION drops
	// first, then the count, and the core — what happened and how long it
	// took — is never cut open; below that the target itself truncates.
	const join = (...xs: string[]): string => xs.filter((x) => x !== "").join(" · ");
	const core = join(meta, counted, `${elapsed}s`);
	const withAttr = join(meta, counted, `${elapsed}s`, attr.replace(" · ", ""));
	const lead = `${verbCol} `;
	const fit = (t: string, tail: string): string | null => {
		const line = `${lead}${t}${tail === "" ? "" : ` · ${tail}`}`;
		return visibleWidth(line) <= room ? line : null;
	};
	// 1. everything
	const full = fit(target, withAttr);
	if (full !== null) return full;
	// 2. the attribution gives way
	const bare = fit(target, core);
	if (bare !== null) return bare;
	// 2b. the COUNT gives way next (pin 4), where the suffix is not
	//     already carrying it
	const short = fit(target, join(meta, `${elapsed}s`));
	if (short !== null) return short;
	// 3. the target truncates, the core stays whole
	const stem = join(meta, `${elapsed}s`);
	const budget = room - visibleWidth(lead) - visibleWidth(stem) - 4; // the ellipsis + " · "
	if (budget >= 1) return `${lead}${widthCut(target, budget)}… · ${stem}`;
	// 4. DC-48 — the ELAPSED still rides, and the target takes what is
	//    left. This used to return the target alone, on the argument that
	//    a cut core would leave a half-open parenthesis; R13's chain has
	//    no bracket to leave open, so the reason retired with the
	//    parentheses and pin 4's own rule applies at every width: what
	//    happened and how long it took is never cut away.
	const floor = `${elapsed}s`;
	const left = room - visibleWidth(lead) - visibleWidth(floor) - 4; // the ellipsis + " · "
	if (left >= 1) return `${lead}${widthCut(target, left)}… · ${floor}`;
	return `${lead}${widthCut(target, Math.max(1, room - visibleWidth(lead)))}`;
}

/**
 * TUI2-R1.5 ⑤ (VD-11) — approval attribution, about humans.
 *
 * A5 put the DECIDER on the settled head row to answer "why wasn't I
 * asked". The walkthrough found the answer being given nine times in a
 * row as `approved by mode:default` — and `mode:default` is not an
 * answer. It is the runtime's own backfill (run.ts stamps it when no
 * policy expressed an opinion at all), so the row was announcing the
 * ambient default as though something had decided.
 *
 * The signal is inverted and reduced to the fact worth a human's eye:
 * `decidedBy` PRESENT means a policy handled it — ambient, unremarkable,
 * silent. `decidedBy` ABSENT means the human was asked and answered, and
 * that is worth recording on the row: ` · approved`, ` · denied`.
 */
function attribution(c: Extract<BodyCell, { kind: "tool" }>): string {
	if (c.verdict === null || c.verdict.decidedBy !== undefined) return "";
	return c.verdict.decision === "denied" ? " · denied" : " · approved";
}

export function expandSuffix(lines: number | null, room: number): string {
	if (lines === null) return "";
	// R13 — the COUNT left this suffix for the head row's own `·` chain,
	// where the bodied card keeps it too (`… · 10 lines · 0.1s`). It was
	// here because the parenthesised core had nowhere to put it and the
	// suffix was the only tail the row had; with one grammar for both
	// cards there is one place, and VD-6's "stated exactly once" is what
	// forbids leaving a copy behind.
	for (const tier of [" · ctrl+o expands", " · ctrl+o"]) {
		if (tier.length <= room) return tier;
	}
	return "";
}

/** The suffix as the row's dim tail (the empty suffix leaves the row's
 *  bytes untouched — a caller never has to branch). */
function appendSuffix(row: string, suffix: string): string {
	if (suffix === "") return row;
	const p = palette();
	return `${row}${p.dim}${suffix}${p.reset}`;
}

/**
 * TUI2-R2 ⑤ (D, candidate 1) — the FOCUS tint.
 *
 * The cell the next ctrl+o will act on brightens its own `ctrl+o` token
 * to the code tint; the rest of the suffix — the separator, the count —
 * stays dim, because what is being marked is the KEY's target, not the
 * row. Zero new rows, zero new columns: the affordance the cell already
 * prints is the marker.
 *
 * Applied to a row rather than composed into it on purpose. The token is
 * emitted from several places (the settled suffix, the renderer's own
 * `└ +N … · ctrl+o` cut rows) and threading a flag through all of them
 * would put the invariant "exactly one bright token" in as many hands as
 * there are emitters. Here it has exactly one.
 *
 * NO_COLOR: p.dim is empty, so the row's bytes are untouched.
 */
export function focusToken(row: string, W: number): string {
	const p = palette();
	const at = row.lastIndexOf(EXPAND_KEY);
	if (at !== -1) {
		// the row already names the key — brighten the token in place, and
		// leave every other span exactly as it was
		if (p.dim === "") return row;
		// DC-3: the marker takes the WASH. It used to take the inline-code
		// tint and inherited its 1.54:1 — the cue naming the key that
		// reveals a cell was itself the least readable thing on a white
		// terminal. The wash is right for a second reason: this token has
		// to be UNIQUE on the frame ("exactly one bright token"), and an
		// attribute like bold is spent everywhere. It closes with washEnd
		// rather than a reset, so the surrounding dim survives instead of
		// having to be re-applied.
		return `${row.slice(0, at)}${p.lift}${EXPAND_KEY}${p.dim}${row.slice(at + EXPAND_KEY.length)}`;
	}
	// A LIVE row does not carry the affordance today, and the live cell is
	// the one ctrl+o takes FIRST (expandNext scans the live tail before
	// the committed ring) — so the row the key is aimed at was the one row
	// that never said the key existed. The affordance IS the marker here:
	// it appears on the focused row and nowhere else, which is why no
	// unfocused row's bytes move (every existing live-row assertion
	// renders a cell with no focus and is untouched).
	const room = W - visibleWidth(row);
	if (room < SUFFIX_MIN) return row; // never at the cost of invariant ①
	return `${row}${p.dim} · ${p.lift}${EXPAND_KEY}${p.reset}`;
}

/** DC-41 — the label in ONE place. The key has moved once now, and
 *  a constant named after its binding is a comment that lies. */
const EXPAND_KEY = "ctrl+o";

/** TUI2-R1 (A) — the expanded block's last row: the way back. The
 *  rollup's expanded list carries a second clause (its members' full
 *  outputs live in /last, which the group row cannot show). */
const COLLAPSE_ROW = "ctrl+o collapses";

/** W13 — the rollup opt-in table: which tools collapse, and the count
 *  NOUN (read_file calls → "5 files", list_dir → "5 dirs", search_text
 *  → "5 matches"). Only these tools opt in — a shell burst is never
 *  rolled up (its rows carry meaning). The folded-turn line (W14) reuses
 *  the plurals for its other-tool terms ("2 dirs", "1 match"). */
export const ROLLUP_NOUN: Readonly<Record<string, string>> = {
	read_file: "files",
	list_dir: "dirs",
	search_text: "matches",
};

// ---- TUI2-R1 (B): the exploration rollup ----

/** TUI2-R1 (B) — the exploration row's nouns. Deliberately NOT
 *  ROLLUP_NOUN: that table says what a SINGLE-tool rollup counts
 *  ("5 matches"), and this row counts CALLS across tools, where
 *  "14 searches" is what happened. Both tables stay — changing the
 *  older one would move an assertion this round did not declare. */
const EXPLORE_NOUN: Readonly<Record<string, [string, string]>> = {
	read_file: ["file", "files"],
	list_dir: ["dir", "dirs"],
	search_text: ["search", "searches"],
};

/** TUI2-R1 (B) — the verb column of the expanded list names the ACT.
 *  TUI2-R2pre ④: this used to be a private three-tool table saying the
 *  same thing as the card head's `_file` strip, in a different way and
 *  for a different set of tools. Both are `displayVerb` now — the whole
 *  point of the ruling is that there is ONE answer to "what does the
 *  screen call this". The cut note, which used to be the deliberate
 *  exception here, moved with it (see toolCutNote). */

/** Whether a tool joins an exploration run. Exactly the read-only set —
 *  writes, edits, shells and extension tools never group (a burst of
 *  side effects is a list of things that HAPPENED, and every row of it
 *  carries meaning). */
export function isExploreTool(name: string): boolean {
	return EXPLORE_NOUN[name] !== undefined;
}

/** W14 — the folded-turn line: a whole QUIET turn (no text), once it is
 *  scrollback, becomes ONE line — the work order's claimed shape
 *  (`▞ thought 19s · 5 reads · no edits`), the counts accumulated at
 *  toolStart: read_file → "reads", edit_file → "edits", the other tools
 *  as first-call-order terms (the ROLLUP_NOUN plurals when the tool opts
 *  in, the verb + "s" otherwise).
 *  A9 (ruling R2, mock A): the user chip rides the fold — the human's
 *  words LEAD the one line, `✦ <chip> · thought 19s · read 5 files` —
 *  the chip the SAME SGR-7 bracket as the live user row (#16f, side
 *  pads included). The words take the fold's width budget and width-cut
 *  at the end with the honest "…" (never a silent truncate — invariant
 *  ① holds on the ONE row by construction).
 *
 *  DECLARED SUPERSESSION (R3g, 2026-08-28) — A9 also ruled that "the
 *  metadata terms give way LAST". They do not any more: the KEY does.
 *  A9 was taken when this line carried no key, and at a width where the
 *  chip, the full metadata and " · ctrl+o" cannot coexist, a fold with
 *  no key is the turn's work behind a line with no way back to it. So
 *  the order is now words, then metadata, then — never — the key. The
 *  glyph is ✦ and the zero terms are dropped (R3b), so the example above
 *  is written as the code renders it rather than as A9 first wrote it. */
/**
 * R3b — what a run of work DID, in words. One definition, because two
 * surfaces say it: the fold line (`turnFold`, above) and the expand
 * header the compositor writes when that fold is opened. A second copy
 * would be a second answer to the same question, and the first thing to
 * drift would be the plurals — `search_text` is "matches", not
 * "searchs", and only the ROLLUP_NOUN table knows that.
 *
 * Zero terms are dropped (owner ruling, R3b): a term earns its place by
 * having a count.
 */
/**
 * R3g (2026-08-28) — the fold's own terms, VERB + COUNT + NOUN.
 *
 * DECLARED SUPERSESSION. R3b built these terms out of ROLLUP_NOUN,
 * whose own comment says not to: that table names what a single-tool
 * rollup COUNTS ("5 matches" — five matched lines), and this line
 * counts CALLS. So one search_text call rendered `1 match`, a sentence
 * that is false whenever the search matched any other number — which is
 * almost always. `shell` fell through to the verb branch and read
 * `4 shells`.
 *
 * The phrasing is the owner's, from the shape they asked for:
 * "thought 17s · read 4 files · listed 1 directory · ran 4 shell
 * commands". A tool with no entry says `3 × <verb>`, which counts calls
 * without inventing a noun for them.
 */
/**
 * R3i — ONE TERM TABLE, TWO TENSES: [past, progressive, singular, plural].
 *
 * The stretch line is the same row at every instant of a turn: while
 * the work runs it says what it is DOING, and at the settle it says
 * what it DID. That sentence is only true if both tenses come from one
 * table. The v9 review found the alternative already happening on a
 * hand-written prototype — `searching 1 pattern` live against `ran 1
 * search` settled, the NOUN swapping at the settle, and `running 4
 * shells`, which is verbatim the R3g defect the previous round removed.
 *
 * FOLD_TERM below is derived from this, so the settled vocabulary
 * cannot drift from the live one by construction.
 */
const TERM: Readonly<Record<string, readonly [string, string, string, string]>> = {
	read_file: ["read", "reading", "file", "files"],
	edit_file: ["edited", "editing", "file", "files"],
	write_file: ["wrote", "writing", "file", "files"],
	list_dir: ["listed", "listing", "directory", "directories"],
	search_text: ["ran", "running", "search", "searches"],
	shell: ["ran", "running", "shell command", "shell commands"],
};

const FOLD_TERM: Readonly<Record<string, readonly [string, string, string]>> = Object.fromEntries(
	Object.entries(TERM).map(([name, [past, , singular, plural]]) => [name, [past, singular, plural] as const]),
);

/**
 * R3h (fable, 2026-08-29) — WHICH TERMS COUNT OBJECTS.
 *
 * The rule, one sentence: a term that counts OBJECTS counts distinct
 * objects; a term that counts ACTS counts calls. `read 2 files` after
 * reading ONE file twice is a false sentence, and law 1.3 does not
 * become optional because the falsehood is small. `ran 2 searches`
 * after searching the same pattern twice is TRUE — the acts happened.
 *
 * The table sits beside FOLD_TERM so the two cannot drift: a tool whose
 * noun is a thing ("files", "directories") belongs here; a tool whose
 * noun is an act ("searches", "shell commands") does not.
 */
const FOLD_COUNTS_OBJECTS: ReadonlySet<string> = new Set(["read_file", "edit_file", "write_file", "list_dir"]);

/** Does this tool's fold term count distinct targets rather than calls? */
export function foldCountsObjects(name: string): boolean {
	return FOLD_COUNTS_OBJECTS.has(name);
}

function foldTerm(name: string, n: number): string {
	const t = FOLD_TERM[name];
	if (t === undefined) return `${n} × ${displayVerb(name)}`;
	return `${t[0]} ${n} ${n === 1 ? t[1] : t[2]}`;
}

export function foldTerms(reads: number, edits: number, others: readonly [string, number][]): string[] {
	const parts: string[] = [];
	if (reads > 0) parts.push(foldTerm("read_file", reads));
	if (edits > 0) parts.push(foldTerm("edit_file", edits));
	for (const [name, n] of others) {
		if (n === 0) continue;
		parts.push(foldTerm(name, n));
	}
	return parts;
}

/**
 * R3i — THE STRETCH LINE: the turn's one working row, in three phases.
 *
 * A STRETCH is the run of thinking and tool calls between two blocks of
 * the model's prose. While it runs it is this line plus a bounded act
 * window; when it closes it commits as this same line, frozen, with its
 * key. The contract in one sentence: **the line you watch is the line
 * you keep** — the settle changes the mark, the tense and the key, and
 * nothing else.
 *
 *   thinking   ✧ thinking 4s
 *   acting     ✶ reading 6 files · running 4 shell commands
 *   settled    ✦ thought 9s · read 6 files · ran 4 shell commands · ctrl+o
 *
 * THE GIVE-WAY LADDER, in order, because at some width everything
 * cannot fit:
 *
 *   1. the human's WORDS (the A9 chip on a quiet turn) — they are on
 *      screen above, in the chip band;
 *   2. the NOUNS compact, cheapest word first, and stop as soon as the
 *      row fits — buying one cell must not spend every substitution;
 *   3. the COUNTS cut, with the honest "…";
 *   4. the TROUBLE CLAUSE cuts. The design first said it never gives
 *      way, and that was unimplementable: a long clause overflows after
 *      the counts have already cut to a bare "…", and invariant ①
 *      throws on that row;
 *   5. the KEY gives way NEVER. A fold with no key is the turn's work
 *      behind a line with no way back to it, which is the one thing
 *      this row must not be.
 *
 * `…` in this file means CUT HERE and nothing else — which is why the
 * live phases carry no trailing ellipsis for in-flight, though the
 * reference implementation uses one. The moving mark and the present
 * tense already say it twice.
 */
/**
 * R3i phase 5 — THE ANSWERED QUESTION'S BLOCK.
 *
 * A settled `ask_user` used to render `  ask_user  (3 lines, 41.2s)` —
 * an empty target and the answers discarded, though the tool_result
 * already carried them. The owner asked for this block by pointing at
 * one: after they answer, there is a display for that too.
 *
 *   asked 2 questions (answered, 41.2s)
 *   │ deploy target → staging
 *   │ retry policy → give up after 3 attempts (typed)
 *
 * The question is dim, the join is dim, the ANSWER is at body strength
 * — strip every escape and every fact is still there (law 1.2: colour
 * is emphasis, never information). A typed answer says `(typed)`,
 * because where an answer came from is a fact about it.
 *
 * It is WORDS, not work (law 1.7): it never folds into a stretch line,
 * because the one thing a summary must not do is speak for the human.
 *
 * A result that is not the ask's own JSON yields NOTHING. This renderer
 * reads a payload it did not write, and a guess about what it means
 * would be a row the product cannot stand behind.
 */
export function askedBlock(resultText: string, seconds: number, W: number): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultText);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object") return [];
	const asked = parsed as { answers?: { q?: string; choice?: string; choices?: string[]; custom?: string }[]; declined?: string[] };
	const p = palette();
	const head = (n: number, outcome: string): string =>
		cutLine(`  ${p.bold}asked${p.reset} ${n} ${n === 1 ? "question" : "questions"} ${p.dim}(${outcome}, ${seconds.toFixed(1)}s)${p.reset}`, W);
	const row = (body: string): string => cutLine(`  ${p.dim}│${p.reset} ${body}`, W);

	if (Array.isArray(asked.declined) && asked.declined.length > 0) {
		// the honest decline record: WHAT went unanswered, and what the
		// choices had been — the panel already computes both.
		return [head(asked.declined.length, "declined"), ...asked.declined.map((q) => row(`${p.dim}${escapeTerminal(q)}${p.reset}`))];
	}
	if (!Array.isArray(asked.answers) || asked.answers.length === 0) return [];
	return [
		head(asked.answers.length, "answered"),
		...asked.answers.map((a) => {
			const q = escapeTerminal(String(a.q ?? ""));
			const typed = typeof a.custom === "string" && a.custom !== "";
			const value = typed ? a.custom! : Array.isArray(a.choices) ? a.choices.join(", ") : String(a.choice ?? "");
			return row(`${p.dim}${q} →${p.reset} ${escapeTerminal(value)}${typed ? `${p.dim} (typed)${p.reset}` : ""}`);
		}),
	];
}

export interface StretchTerms {
	/** the segment's OWN measured thinking seconds; 0 drops the term */
	readonly thoughtSeconds: number;
	/** the segment's calls as [tool name, count], in first-call order.
	 *  Object-counting tools are deduped by target upstream (R3h). */
	readonly calls: readonly (readonly [string, number])[];
	/** the targets acted on — read only when the stretch made exactly
	 *  ONE call, where naming the target says everything the two rows it
	 *  replaces said (see the one-call rule below). */
	readonly targets: readonly string[];
	/** the trouble the stretch met: [kind, count, what it was]. */
	readonly trouble: readonly (readonly ["failed" | "denied" | "interrupted", number, string])[];
	/** R4 — the tool names that still have a call IN FLIGHT. The tense is
	 *  PER TERM, not per line: a stretch whose shell has finished while a
	 *  read runs says `ran 1 shell command · reading 1 file`. The whole
	 *  line used to go progressive, which the standing act slot made a
	 *  visible contradiction — the gap frame put `running npm run check`
	 *  directly above a row reading `(exit 0, 12.4s)`. Absent ⇒ every
	 *  term takes the line's own tense, which is what the settled line
	 *  wants. */
	readonly liveNames?: readonly string[];
	/** A9 — the human's words, on a QUIET turn's fold only. */
	readonly words?: string;
	/** the live mark; the caller passes the spinner's current frame. */
	readonly mark?: string;
}

const STRETCH_COMPACT: readonly (readonly [string, string])[] = [
	["directories", "dirs"],
	["directory", "dir"],
	["shell commands", "commands"],
	["shell command", "command"],
];

/** R3i — a stretch of exactly ONE call names its TARGET instead of its
 *  count. `thought 2s · read 1 file` replaces two rows — the thinking
 *  and the call — with a row that says less than either of them did,
 *  and "thinking plus one call" is the commonest shape a narrating
 *  model makes. This is the answer to the defect R3d killed R3b's
 *  per-segment folds over; the "absorbs at least two rows" rule alone
 *  does not answer it. */
function stretchTerms(t: StretchTerms, live: boolean): string[] {
	// R4 — the tense is per TERM. A name with nothing in flight is in the
	// past whatever the line's own phase is; with liveNames absent (the
	// settled line) every term follows the line.
	const tense = (name: string): 0 | 1 => (live && (t.liveNames === undefined || t.liveNames.includes(name)) ? 1 : 0);
	const total = t.calls.reduce((n, [, c]) => n + c, 0);
	// R4 — the one-call TARGET form is the SETTLED line's. Live, the act
	// slot directly below already names the target on its head row, so
	// the line was printing the same words twice, one above the other
	// (`running npm run check` over `shell npm run check`). Settled there
	// is no slot, and naming the target is strictly more than counting to
	// one — which is the R3i rule this keeps, where it applies.
	if (total === 1 && t.targets.length === 1 && !live) {
		const [name] = t.calls[0]!;
		const e = TERM[name];
		return [`${e === undefined ? name : e[0]} ${t.targets[0]!}`];
	}
	return t.calls
		.filter(([, n]) => n > 0)
		.map(([name, n]) => {
			const e = TERM[name];
			if (e === undefined) return `${n} × ${displayVerb(name)}`;
			return `${e[tense(name)]} ${n} ${n === 1 ? e[2] : e[3]}`;
		});
}

// ---- the bounded-block flow contract (W7, W8, W10) ----

/** The caps — screen rows counted AFTER the fold, at the current width
 *  (the W7 table). The renderer-cut row is inside the cap. */
/** R13 — ONE preview cap, every tool. It was the shell's alone while
 *  the shell was the only settled call with rows on screen. */
export const CAP_PREVIEW = 5;
/** DC-46 — the running window's ceiling is the SETTLED preview's, and a
 *  running card reaches it by growing rather than by being handed it.
 *  `LIVE_WINDOW` (CAP_PREVIEW + 1) retires with the allocation it sized. */
/** The rows a card costs besides its window: two pads, the head, two
 *  blanks and the status row. Below this there is no card (DC-43). */
export const CARD_CHROME = 6;
const CAP_DIFF = 12; // the approval diff: head + the named middle + tail

/** The block body rows' prefixes (W2's gutter table): │ a bounded
 *  block's body, └ the block's last row — what was cut, where the rest
 *  is — at the LEFT EDGE (the gutter column: the left edge alone
 *  distinguishes the states at --plain). Structural (constraint 1). */
/** R8a — A TOOL BLOCK'S ROWS ARE INDENTED, NOT GUTTERED.
 *
 *  `│ ` on every row drew a bar down the left of every multi-row
 *  output, which is what the owner kept pointing at. The fact the bar
 *  carried — "these rows are the call's output, not prose" — is real
 *  and law 1.2 requires it survive a pipe, so it moves into the
 *  INDENT: four columns, one level deeper than the header (2) and than
 *  prose (2). Bytes still tell them apart; no column of glyphs.
 *
 *  `└` survives as the mark that OPENS the block, once, on its first
 *  row (see openBlock). In-block notes take the same indent,
 *  no glyph — because a second `└` inside one block would be the same
 *  mark meaning two things (§4.1). CUT_ROW is unchanged for the
 *  surfaces that are not a tool block: the fold row's target list, the
 *  slot's overflow count. */
/** R8a's four columns — off the surface. Inside a painted card every
 *  row sits at column 2 (R13 E4): the head row and the outcome row
 *  bracket the preview, so the indent is no longer what says "these
 *  rows are output". Where nothing paints, it is exactly that, and R8a
 *  stands unchanged. */
const BODY_ROW_FLAT = "    ";
const NOTE_ROW_FLAT = "    ";
const CARD_ROW = "  ";
/** R13 E3 — the column the model's words begin in, the same one the
 *  card's rows and the chip's text begin in. */
const PROSE_COL = "  ";
/** DC-47, ADJUDICATED — the model's THINKING begins in the SAME column
 *  as everything else: two.
 *
 *  It went to four when E3 moved prose to two, so that stripping the
 *  escapes would still tell them apart (§1.2). The owner looked at it
 *  and ruled against it: "the thinking area is not indented by the same
 *  two as the first line — it needs to keep the same first-line indent
 *  as everything else" (2026-09-04). §1.8's one left edge outranks the
 *  distinction, and §1.2 takes a DECLARED EXCEPTION for this one pair —
 *  see design.md §1.2 and §7.2 for what is given up and what is not. */
const THINK_COL = "  ";
const bodyRow = (): string => (slabPaints() ? CARD_ROW : BODY_ROW_FLAT);
const noteIndent = (): string => (slabPaints() ? CARD_ROW : NOTE_ROW_FLAT);
const CUT_ROW = "└ ";

/**
 * R9 P2 — THE SLAB: a single call's block is one washed object.
 *
 * §1.6 gives the wash to the machine's verbatim text, and a call's own
 * output is exactly that. The slab is the surface that says so: full-
 * width washed rows, the head row naming the call, the output inside,
 * the outcome closing it. `└` does not open a slab — the surface is the
 * container, and a corner inside it is §1.3's empty mark one scale up.
 *
 * THE DEGRADATION IS THE POINT OF THE PREDICATE. `wash` is a chosen
 * background on the two KNOWN grounds and reverse video on the third
 * (§3's last rung). A chip inverting for one row is the design working; eight
 * output rows inverting is a blackboard in the middle of the transcript.
 * So a slab paints only where the wash is a real background, and where
 * it is not the block degrades to what it has always been — the R8a
 * four-column indent with a dim tail. Never to reverse video.
 *
 * The content shape does NOT change with the surface: the note row and
 * the outcome row exist either way, in `washDim` on the slab and in the
 * ordinary dim off it. Only the surface and its two blank rows are
 * contingent, because an unpainted blank row is §1.3's empty mark at the
 * scale of a row.
 */
function slabPaints(): boolean {
	const p = palette();
	return p.wash !== "" && currentGround() !== "unknown";
}

/** One washed row, padded to the full width by DISPLAY width. A reset
 *  inside the content would strand the background for the rest of the
 *  row, so every reset re-opens it — the selection bar's discipline,
 *  applied to a surface that spans many rows instead of one. */
function slabRow(inner: string, W: number): string {
	const p = palette();
	const body = inner.replaceAll(p.reset, `${p.reset}${p.wash}`);
	const pad = Math.max(0, W - visibleWidth(inner));
	return `${p.wash}${body}${" ".repeat(pad)}${p.washEnd}`;
}

/** A metadata row inside (or under) a block: `washDim` on the slab,
 *  the ordinary dim off it. §2.1 is why there are two. */
/** The widest form that fits the row, or the last one — the head row's
 *  own discipline (TUI2-R1.5 ⑤, pin 4) applied to the slab's two
 *  metadata rows: the parts give way in a PINNED ORDER, and the part
 *  that carries the semantics is the one reserved. */
function pickTier(tiers: readonly string[], room: number): string {
	for (const t of tiers) if (visibleWidth(t) <= room) return t;
	return tiers[tiers.length - 1]!;
}

function noteRow(text: string, W: number, tone: "dim" | "body"): string[] {
	const p = palette();
	// CUT, never folded — A6's rule for the tool header, and for the same
	// reason: a metadata row that wraps costs the block a row it did not
	// budget, and at 30 columns the fold put "expands" alone on a line of
	// its own. The row names a fact; a cut names it shorter.
	const open = tone === "body" ? p.washDim : p.dim;
	const close = tone === "body" ? p.washDimEnd : p.reset;
	return [cutLine(`${open}${noteIndent()}${text}${close}`, W)];
}

/**
 * Assemble a call's block.
 *
 * `head` is the row that names the call, `body` its rows (already
 * indented and toned), `outcome` the closing line in words (§7.5) or
 * null for a call whose head row already carries it — a read has no
 * body, so nothing needs closing and its outcome stays inline.
 */
function slabBlock(head: string, body: readonly string[], outcome: string | null, W: number): string[] {
	if (!slabPaints()) {
		const out = [head, ...body];
		if (outcome !== null) out.push(...noteRow(outcome, W, "dim"));
		return out;
	}
	// R13 — THE CARD. pad · head · blank · preview · blank · outcome ·
	// pad, and a call with nothing to preview is three rows with its
	// outcome riding the head. Every row sits at column 2 (E4): R8a put
	// a block's body at column 4 so a pipe could tell output from prose,
	// and inside a painted card the head and the outcome bracket it
	// instead — off the surface R8a's indent is still the fact, which is
	// why the degradation above keeps it.
	if (body.length === 0) {
		// DC-48: the join makes a ROW, so it is cut like every other row.
		// The callers above size their parts against the room they have;
		// this is the backstop that makes invariant ① hold whatever they
		// do, and it is what was missing when a running card's head was
		// cut to W and then had a whole status appended to it.
		const only = cutLine(outcome === null ? head : `${head} ${outcome}`, W);
		return [slabRow("", W), slabRow(only, W), slabRow("", W)];
	}
	const top = [slabRow("", W), slabRow(head, W), slabRow("", W), ...body.map((r) => slabRow(r, W))];
	// An EXPANDED block closes with its own footer and passes no outcome;
	// a blank row and an empty metadata row under it would be §1.3's
	// empty mark twice over.
	if (outcome === null) return [...top, slabRow("", W)];
	return [...top, slabRow("", W), ...noteRow(outcome, W, "body").map((r) => slabRow(r, W)), slabRow("", W)];
}

/** R8a — stamp `└` on a block's FIRST row, after every slice and note
 *  has been assembled, so the mark is always on the first row actually
 *  emitted rather than on one a cap may have dropped. */
function openBlock(rows: string[]): string[] {
	// the corner goes on the first row that HAS something on it. A cap
	// or a blank leading output line can put an empty row first, and a
	// corner there would be a mark on a row with nothing to mark — law
	// 1.3, which is the rule this whole change is serving.
	const i = rows.findIndex((r) => visibleWidth(r) > visibleWidth(bodyRow()));
	if (i < 0) return rows;
	const first = rows[i]!;
	const at = first.indexOf(BODY_ROW_FLAT);
	if (at < 0) return rows;
	// the corner REPLACES two of the four indent columns, so the text
	// stays in the same column as every other row of the block.
	return [...rows.slice(0, i), `${first.slice(0, at)}  \u2514 ${first.slice(at + BODY_ROW_FLAT.length)}`, ...rows.slice(i + 1)];
}

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
function toolBlockParts(c: Extract<BodyCell, { kind: "tool" }>, W: number, ctx: FrameCtx): { rows: string[] } {
	const memo = blockMemo.get(c);
	// the SURFACE is part of the key: the same cell renders different rows
	// painted and unpainted, and a ground resolved after the first frame
	// would otherwise be served the pre-ground shape forever.
	const liveRows = ctx.liveWindow ?? CAP_PREVIEW;
	const state = `${c.state}:${c.isError}:${c.name}:${c.expanded ? "x" : ""}:${slabPaints() ? "slab" : "flat"}:${liveRows}`;
	const content: unknown = c.state === "approval" ? (c.diff ?? null) : c.resultText;
	if (memo !== undefined && memo.width === W && memo.state === state && memo.content === content) return memo;
	const p = palette();
	const rows =
		c.expanded
			? // W15: the toggle's full form — the WHOLE body, no cap, no
			  // cut note (nothing is cut; the width fold still holds — the
			  // height may change while live, the user asked for it). The
			  // delegate has no body — its rows are unchanged.
			  c.state === "approval"
					? diffBody(c.diff, W, true)
					: c.name === "delegate"
						? c.state === "running"
							? delegateRunning(c, W)
							: delegateSettled(c, W)
						: blockRows(c.resultText, W)
			: c.state === "done"
				? c.isError
					? errorBody(c, W)
					: c.name === "delegate"
						? delegateSettled(c, W)
						: // R13 — EVERY settled call previews. The shell's tail is
							// VD-5's own cap and direction (the conclusion is at the
							// end); everything else shows its head, because that is
							// where its answer is. read_file is the single exception
							// (E1): its result is the file, kiso has nothing to add by
							// showing five lines of it, and the head row's key opens
							// the whole thing.
							noPreview(c)
								? []
								: c.name === "shell"
									? shellTail(c.resultText, W, slabPaints() ? "body" : "dim")
									: previewHead(c.resultText, W, slabPaints() ? "body" : "dim")
				: c.state === "running"
					? c.name === "delegate"
						? delegateRunning(c, W)
						: // R13 E1 — the call with no preview settled has none while
							// it runs either; its card is three rows the whole way.
							noPreview({ ...c, state: "done" })
							? []
							: liveWindow(c, W, liveCap(c, liveRows), slabPaints() ? "body" : "dim")
					: c.state === "approval"
						? diffBody(c.diff, W)
						: [];
	// E1 governs the PREVIEW — five lines of a file kiso has nothing to
	// add to — not kiso's sentence about the result. `offset=201 for the
	// rest` is actionable and no other row says it (W10 pins exactly
	// that), so a read the TOOL capped takes one body row and a read it
	// did not takes none. That shape difference is information: the two
	// events are different, and the row is what says so.
	const note = c.expanded ? null : toolCutNote(c.name, c.resultText);
	if (note !== null) rows.push(...foldLine(`${p.dim}${noteIndent()}${note}${p.reset}`, W));
	// TUI2-R1 (A): an EXPANDED block says how to put it back. The footer
	// rides a block that HAS rows — an expanded delegate whose summary
	// marker is missing renders nothing, and a lone footer under a head
	// row would be an affordance for an empty block.
	if (c.expanded && rows.length > 0) rows.push(...foldLine(`${p.dim}${noteIndent()}${COLLAPSE_ROW}${p.reset}`, W));
	// R9 P2: `└` opens a block that has no surface. Inside a slab the
	// surface IS the container, and a corner in it is §1.3's empty mark
	// one scale up — so the corner and the slab are alternatives, never
	// both.
	const opened = slabPaints() ? rows : openBlock(rows);
	const parts = { width: W, state, content, rows: opened };
	blockMemo.set(c, parts);
	return parts;
}

/** R13 E1 — the one settled call that previews NOTHING. A read's result
 *  IS the file; five lines of it tell a reader less than the head row
 *  already does, and the key opens the whole thing. (The reference
 *  implementation makes the same call, for the same reason.) Everything
 *  else previews: a shell its tail, the rest their head. */
function noPreview(c: Extract<BodyCell, { kind: "tool" }>): boolean {
	return c.state === "done" && !c.expanded && !c.isError && c.reason === null && c.name === "read_file";
}

/** The block's body rows. */
function toolBlockBody(c: Extract<BodyCell, { kind: "tool" }>, W: number, ctx: FrameCtx): string[] {
	return toolBlockParts(c, W, ctx).rows;
}

/** Fold result text into body rows (the block's own indent): escape,
 *  split, fold each line at W−prefix; trailing empty rows (the result's
 *  final newline) drop. */
function blockRows(text: string, W: number, tone: "dim" | "body" = "dim"): string[] {
	const p = palette();
	const textW = Math.max(1, W - visibleWidth(bodyRow()));
	const rows: string[] = [];
	// R9 P2: inside a SLAB the output rows are body strength, never dim —
	// §2.1 bars dim from the wash (3.91:1 light, 4.35:1 dark) and these
	// rows are the verbatim content the surface exists for. The metadata
	// rows around them take `washDim`, which was chosen for that ground.
	const open = tone === "dim" ? p.dim : "";
	const close = tone === "dim" ? p.reset : "";
	for (const raw of escapeTerminal(text).split("\n")) {
		for (const row of foldLine(raw, textW)) rows.push(`${open}${bodyRow()}${row}${close}`);
	}
	while (rows.length > 0 && visibleWidth(rows[rows.length - 1]!) === visibleWidth(bodyRow())) rows.pop();
	return rows;
}

/** The shell output tail, settled: the LAST rows, capped at 5 — the
 *  renderer cut at the block's bottom ("earlier rows" — the conclusion
 *  is at the end, the reference implementation's truncateToVisualLines
 *  direction). */
function shellTail(text: string, W: number, tone: "dim" | "body" = "dim"): string[] {
	const rows = blockRows(text, W, tone);
	if (rows.length <= CAP_PREVIEW) return rows;
	// R9 P2 / D4: FIVE output rows, and the note is a row of its own. The
	// pre-slab arithmetic spent one of the five on the cut note, because
	// the note had nowhere else to live; the slab's metadata rows are not
	// output and are not counted against the output's cap.
	const kept = CAP_PREVIEW;
	// The note goes ABOVE the tail: it says what was cut, and what was
	// cut is what came BEFORE these rows. One position on both surfaces —
	// the surface degrades, the content shape does not.
	return [...cutNote(rows.length - kept, "earlier", W, tone), ...rows.slice(rows.length - kept)];
}

/** R13 — the preview every OTHER settled call gets: the FIRST rows,
 *  capped at five, the cut note BELOW them. A shell's conclusion is at
 *  the bottom of its output, so its preview is the tail and its note
 *  opens the block (shellTail above); a list, a search, a fetch all
 *  answer at the top, so the note closes it. One rule, two directions,
 *  and the direction follows where the answer is.
 *
 *  This is the DECLARED REVERSAL of VD-5 for every tool but the shell
 *  (0.22.0 reversed the shell alone): VD-5 collapsed a settled call to
 *  its head row because ungrounded output rows owned the screen, and
 *  the card is what changes that arithmetic — the rows are inside a
 *  surface that says where the call begins and ends. */
function previewHead(text: string, W: number, tone: "dim" | "body"): string[] {
	const rows = blockRows(text, W, tone);
	if (rows.length <= CAP_PREVIEW) return rows;
	return [...rows.slice(0, CAP_PREVIEW), ...cutNote(rows.length - CAP_PREVIEW, "more", W, tone)];
}

/** The preview's cut note, in one place so the head and the tail
 *  directions cannot drift apart. The KEY is reserved (TUI2-R1.5 ⑤): a
 *  row that says how much is hidden without saying how to see it is the
 *  silence the affordance exists to remove. */
function cutNote(cut: number, word: "more" | "earlier", W: number, tone: "dim" | "body"): string[] {
	const n = `${cut} ${word} line${cut === 1 ? "" : "s"}`;
	return noteRow(pickTier([`… ${n} · ctrl+o expands`, `… ${n} · ctrl+o`, `… ${cut} · ctrl+o`, "· ctrl+o"], W - visibleWidth(noteIndent())), W, tone);
}

/** The error text head: the FIRST rows, capped at 3 — the answer is at
 *  the start (opencode's collapseToolOutput direction). The header row
 *  already summarizes the first line, so the body starts at line 2. */
function errorBody(c: { name: string; resultText: string; reason?: string | null }, W: number): string[] {
	const p = palette();
	// W4: a shell EXECUTION failure's line 0 ("exit 1: …") no longer
	// rides the header — the parsed code does — so the body keeps the
	// FULL text. Any other error keeps the pre-W4 split: line 0 is the
	// header's metadata, the body shows the rest.
	// W19: a DENIED call's header meta is the PARSED reason (from the
	// denied tag), decoupled from the result text — the body keeps the
	// FULL content including the "[Permission denied] " prefix (never
	// hide information — the folded body rides the pinned row).
	const skipFirst = c.name === "shell" && /^exit \d+/.test(c.resultText) ? 0 : c.reason !== null && c.reason !== undefined ? 0 : 1;
	// R13 — a failure is a CARD like any other call: the same cap of
	// five, the same note wording, the same direction (an error's answer
	// is at the top). It kept a cap of three and `+2 more · ctrl+o` from
	// before the card existed, which made the one shape a reader most
	// wants to read the one shape that showed least of itself.
	return previewHead(c.resultText.split("\n").slice(skipFirst).join("\n"), W, slabPaints() ? "body" : "dim");
}
/**
 * DC-46 — THE RUNNING WINDOW GROWS, and nothing pads it.
 *
 * DECLARED REVERSAL of W8's fixed window and of E2 as first written
 * ("allocated at the settled card's height, and only ever shrinks at
 * settle"). Both fixed a height so it would not move while a command
 * ran; both fixed it at a height the SETTLE then changed, and the settle
 * is where the cost landed. A card allocated at twelve rows and settling
 * at three gives nine rows back, the window's top is clamped and cannot
 * follow, and the difference is a blank band above the composer.
 * Measured on the a7 replay: hole-frames 8.9 / 13.5 / 3.8 percent at
 * 0.23.0 against 16.9 / 24.6 / 7.9 with the shrink. The only source is
 * the shrink, so the cure is to stop shrinking.
 *
 * So the window IS its content: one row while nothing has arrived, one
 * more per line to the cap, then the cut note above a scrolling tail.
 * R7a's "blank, not a bar" retires with the padding it governed — it was
 * about what to draw on rows a FIXED height reserved, and no height is
 * reserved now.
 *
 * The direction is the SETTLED card's, so a settle swaps content and
 * moves nothing: a shell shows its tail with the note above, everything
 * else its head with the note below.
 */
function liveWindow(c: Extract<BodyCell, { kind: "tool" }>, W: number, cap: number, tone: "dim" | "body"): string[] {
	const p = palette();
	// TUI2-R1.5 ④(b) (VD-4): leading empty lines in the sidecar (a
	// 4096-byte tail can begin on a line boundary) are skipped, so the
	// output starts under its own header.
	const all = blockRows(c.resultText, W, tone);
	const from = all.findIndex((r) => visibleWidth(r) > visibleWidth(bodyRow()));
	// DC-46, derived — NOTHING YET IS NO WINDOW AT ALL, so a running call
	// with no output is the same THREE-ROW card as a settled one with
	// none. The ruling's skeleton put a `waiting for output` row here; a
	// command that returns nothing (`true`, a silent build) would then
	// settle from seven rows to three, which is the very shrink the ruling
	// exists to remove — its own rule cannot hold with that row in place.
	//
	// Nothing is lost: the breathing mark says the call is in flight and
	// the status row's elapsed says how long, so a row reading "waiting
	// for output" carries no fact they do not (§1.3). The card grows the
	// instant a line arrives, and growth is what this design permits.
	if (from < 0) return [];
	const rows = all.slice(from);
	if (rows.length <= cap) return rows;
	return c.name === "shell"
		? [...cutNote(rows.length - cap, "earlier", W, tone), ...rows.slice(rows.length - cap)]
		: [...rows.slice(0, cap), ...cutNote(rows.length - cap, "more", W, tone)];
}

/** DC-46 — the window's HIGH-WATER, per cell: the room a frame leaves
 *  caps how far a window may GROW, and never shrinks one that already
 *  grew. Without this a second call starting would pull the first's
 *  window in, which is the same shrink by another route. Keyed on the
 *  cell, like `blockMemo`, and it only ever matters while the cell is
 *  live — a settled cell renders from its result alone. */
const liveHighWater = new WeakMap<object, number>();
function liveCap(c: object, room: number): number {
	const want = Math.min(CAP_PREVIEW, Math.max(1, room));
	const held = liveHighWater.get(c) ?? 0;
	const cap = Math.max(want, held);
	liveHighWater.set(c, cap);
	return cap;
}


/**
 * R4 — the standing act slot.
 *
 * The stretch's ONE line sits above it; this is the region under it,
 * and it STANDS: allocated when the stretch opens, released at the
 * fold.
 *
 * R3i built the same window INTERMITTENTLY — a running call got its
 * fixed 1+3 block (W8), a finished one got nothing — so the live
 * region's height was a function of how many calls happened to be in
 * flight this frame. Over one real stretch that is 2 rows, then 7,
 * then 2, then 17 for a three-call batch, then 2 again, and every
 * transition scrolls everything above it. The owner's report was that
 * the screen "keeps jumping", and it was an accurate description of
 * the design, not a defect in its execution.
 *
 * The cure is not a smaller window, it is a STANDING one: between two
 * calls the slot keeps the call that just finished rather than
 * collapsing, and before any call it keeps the thinking that is
 * producing them — which is R3i ruling 5 ("thinking belongs on the
 * stretch line, IN THE ACT WINDOW, and in full in expansions") finally
 * wired, since R3i stated it while building no window for the thinking
 * phase to live in.
 *
 * Four rows, deliberately the same 1+3 shape W8 gave a running call, so
 * the commonest frame — exactly one call in flight — renders byte-for-
 * byte what 0.17.0 shipped.
 */
export const ACT_SLOT_ROWS = 4;

/**
 * R4 — the slot's body rows: the tail of `text`, newest at the BOTTOM,
 * bottom-padded to exactly `rows`.
 *
 * The same dim │ gutter a running call's window uses (W2's table), and
 * the same two VD-4 rules: leading blank gutters are skipped, and the
 * short-output pad goes at the BOTTOM so output starts under its own
 * header and grows downward. The slot's CONTENTS change; its shape
 * does not.
 */
export function slotTail(text: string, W: number, rows: number): string[] {
	if (rows <= 0) return [];
	const p = palette();
	const all = blockRows(text, W);
	const from = all.findIndex((r) => visibleWidth(r) > visibleWidth(bodyRow()));
	const body = from < 0 ? [] : all.slice(from);
	// R7a: no pad. The slot stopped padding (see slotPad) and this was
	// the same pad by another route — three blank rows under a call with
	// nothing to say yet, which is the hole a7's blank-run guard prices.
	// R8a: the corner opens whatever slice survives the cap.
	return openBlock(body.slice(Math.max(0, body.length - rows)));
}

/** R4 — clamp or pad assembled slot rows to EXACTLY `rows`. The padding
 *  is what makes the slot stand; the clamp is what keeps the slot from
 *  ever being the thing that trips the force-commit cap (a slot that
 *  could overflow would commit real cells to relieve blank rows). */
export function slotPad(content: readonly string[], rows: number): string[] {
	if (rows <= 0) return [];
	// R7a — THE SLOT NO LONGER PADS. It caps, and that is all.
	//
	// R4 padded to a fixed height because the slot's content came and
	// went: a finished call left the block, the block shrank, and every
	// row above it moved. The pad bought stability with rows drawn as
	// `│`, which is why a tall empty gutter ran down the screen under
	// every short block — the owner's own screenshot, and law 1.3's
	// case: a mark on a row with nothing to mark.
	//
	// Blanking the gutter revealed the hole it had been covering, and
	// the a7 replay priced the hole: blank runs over 2 in 653 of 733
	// frames, the screen never durably filling. So the pad had to go —
	// and the height it was buying is now bought by the CONTENT, since
	// R7a keeps every call's row for the life of the stretch. A block
	// whose rows only accumulate cannot shrink, so there is nothing
	// left for a pad to hold up. Measured: 65 of 733 at 40x24, the
	// pre-R7a number exactly, with the motion gates still green.
	return content.slice(0, rows);
}

/** R4 — the slot's overflow row: the calls in flight beyond the head
 *  budget. It lives INSIDE the slot (it is one of the four rows), which
 *  is what keeps a parallel burst from growing the region. */
export function moreRunningRow(n: number, W: number): string {
	const p = palette();
	return cutLine(`  ${p.dim}${CUT_ROW}+${n} more running${p.reset}`, W);
}

/** W12: the delegate's child sessions collapse to the tool row plus ONE
 *  line — the height NEVER changes (running → settled replaces the row
 *  in place). The running row derives from the INPUT: the parent has no
 *  live channel to a running child (ToolContext carries only
 *  signal/sessionId; execute returns ONE result), so the roles are the
 *  honest current data — the spec's "<child's current tool>" has no
 *  event source. The settled row parses the extension's summary marker
 *  (the blob's first line) — its absence falls back to no body (an old
 *  extension's output still renders). The one-line shape is shared with
 *  W18's status row (the work order: "implement them with one helper"). */
function delegateRunning(c: { childRoles: string[] }, W: number): string[] {
	const p = palette();
	const n = c.childRoles.length;
	const text = n === 0 ? "children running…" : `${n === 1 ? "1 child" : `${n} children`} · ${c.childRoles.join(" · ")}`;
	return [oneLineRow(p, text, W)];
}

function delegateSettled(c: { resultText: string }, W: number): string[] {
	const p = palette();
	const m = /^summary: (.+)$/m.exec(c.resultText);
	if (m === null) return [];
	return [oneLineRow(p, `${m[1]} · /last for the report`, W)];
}

/** ONE row at the left gutter, truncated to fit the width — never a
 *  fold (a fold would wrap into TWO rows and break the one-line height
 *  contract). */
function oneLineRow(p: Palette, text: string, W: number): string {
	const esc = escapeTerminal(text);
	if (visibleWidth(`${p.dim}${CUT_ROW}${esc}${p.reset}`) <= W) return `${p.dim}${CUT_ROW}${esc}${p.reset}`;
	const w = Math.max(1, W - visibleWidth(`${p.dim}${CUT_ROW}${p.reset}`));
	return `${p.dim}${CUT_ROW}${esc.slice(0, w - 1)}…${p.reset}`;
}

/** The approval mini-diff (W7): capped at 12 folded rows — the head +
 *  the named middle (the renderer cut — what was cut, how to expand) +
 *  the tail. The rows are folded at the current width BEFORE the cap —
 *  the R1 measured bug: truncateDiff capped at 40 ENTRIES while the
 *  fold turned them into 73 SCREEN rows at W≤80 (a 44-row terminal's
 *  content cap is H−4 = 40 — the approval force-committed a third of
 *  the screen into scrollback inside one frame).
 *  W17: the cap is a ROW budget at every width — the └ cut is ONE line
 *  (a folded cut pushed the total past 12 at narrow widths), and below
 *  a floor of 3 SOURCE lines visible the head/tail pair is noise (each
 *  fragment a sliver of a long line): drop to the head only — the head
 *  takes the whole budget — and the └ row carries the rest.
 *  W21: exported for the approval panel — the expanded path renders
 *  the approval's ALWAYS-verbose args (never the capped copy). */
export function diffBody(diff: import("./diff.js").DiffLine[] | null, W: number, expanded = false): string[] {
	const p = palette();
	if (diff === null) return [];
	const rows: string[] = [];
	// W17: each line's fold START row (the running total) — the pair
	// floor reads it for the head/tail SOURCE-line counts below.
	const starts: number[] = [0];
	for (const d of diff) {
		const body =
			d.kind === "-"
				? `${p.red}- ${escapeTerminal(d.text)}${p.reset}`
				: d.kind === "+"
					? `${p.green}+ ${escapeTerminal(d.text)}${p.reset}`
					: `${p.dim}  ${escapeTerminal(d.text)}${p.reset}`;
		// W2: the diff body is a bounded block's body — the │ gutter
		// (dim), never the old bold ▎ rail (the table lists no ▎); the
		// +/- marks and their colors ride the content
		rows.push(...gutterFold(`${p.dim}│${p.reset} `, body, W));
		starts.push(rows.length);
	}
	if (expanded || rows.length <= CAP_DIFF) return rows;
	const head = Math.floor((CAP_DIFF - 1) / 2);
	const tail = CAP_DIFF - 1 - head;
	// W17: the └ cut is ONE row at every width — the count leads, the
	// expand affordances are cuttable (the same one-line shape as W12's
	// delegate row and W18's status row).
	const cut = (n: number): string => oneLineRow(p, `+${n} rows · ctrl+o to expand · /last for the full diff`, W);
	// W17: the floor — the head window shows the lines whose fold starts
	// before `head` rows; the tail window the lines whose fold ENDS after
	// `rows.length - tail` (starts[i+1] is line i's end). When the pair
	// shows fewer than 3 SOURCE lines together, it is noise at this width
	// (each fragment a sliver of a long line): drop to the head only —
	// the head takes the whole budget, the └ row carries the rest.
	if (starts.filter((s) => s < head).length + starts.slice(1).filter((s) => s > rows.length - tail).length < 3)
		return [...rows.slice(0, CAP_DIFF - 1), cut(rows.length - (CAP_DIFF - 1))];
	return [...rows.slice(0, head), cut(rows.length - head - tail), ...rows.slice(rows.length - tail)];
}

/** The TOOL's OWN truncation note (W10) — a different fact from the
 *  renderer's cut: the tools truncate and append a continuation note
 *  (packages/tools-node/src/index.ts — read_file's "call again with
 *  offset=N", the output cap, list_dir's entry cap). The note reaches
 *  the MODEL and never the human — this row surfaces it. Detected in
 *  the result's TAIL (the note is appended at the end); returns null
 *  when the tool did not truncate.
 *
 *  TUI2-R2pre ④: the verb here is the DISPLAY one now. This row used to
 *  be the sanctioned raw-name exception, on the reasoning that it names
 *  the tool the model should call again — but the row is addressed to
 *  the HUMAN (the model already has the note in its own transcript, which
 *  is where it read it), and the ruling names this advisory family
 *  explicitly. The `offset=N` it carries is the actionable half and is
 *  untouched. */
function toolCutNote(name: string, resultText: string): string | null {
	const tail = resultText.slice(-300);
	const m = /offset=(\d+)/.exec(tail);
	if (m !== null) return `capped by ${escapeTerminal(displayVerb(name))} · offset=${m[1]} for the rest`;
	if (/…\[truncated\]/.test(tail) || /… \+?\d+ more (?:lines|entries)/.test(tail)) return `capped by ${escapeTerminal(displayVerb(name))} · /last for the rest`;
	return null;
}

/** TUI2-MD ⑤ — one markdown block. Pure in (block, W): the same source
 *  and the same width give the same bytes, which is the freeze property
 *  the commit path relies on. The block carries its own leading blank
 *  (the style table's rhythm), so the compositor's W11 join formula
 *  steps aside between two of these. */
class MarkdownBlock implements Component {
	constructor(private readonly cell: { block: MdBlock }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		// R13 E3 — THE MODEL'S WORDS MOVE TO COLUMN 2. A card's rows sit
		// there (E4) and the chip's text does too (D4), so prose at column
		// 0 would leave the page with three left edges for three registers
		// — the opposite of one rhythm. The registers are told apart by
		// SURFACE, which is §1.6's argument; the column is not one of the
		// things doing that work.
		//
		// The block folds in the room the indent leaves, so invariant ①
		// holds by construction. A block's own leading blank (its `gap`)
		// stays EMPTY: an indented blank row is trailing whitespace, and
		// §1.3 forbids a mark on a row with nothing to mark.
		return renderBlock(this.cell.block, Math.max(1, W - PROSE_COL.length)).map((r) => (r === "" ? r : `${PROSE_COL}${r}`));
	}
}

/** The notice lines — the error surface. */
class ErrorLine implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		// TUI2-R1.5 9 (VD-10): a notice is a sentence addressed to a human.
		return foldWords(escapeTerminal(this.cell.text), W);
	}
}

/** The CLI's pre-rendered blocks (the banner, the recap, slash-command
 *  output) — the SGR applied at composition (render.ts), folded here
 *  verbatim: the #16b contract (no re-escaping) holds, and the fold is
 *  SGR-aware so the accent spans survive a break. */
class RawBlock implements Component {
	constructor(private readonly cell: { lines: string[]; wrap?: "words" }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		// TUI2-R1.5 9 (VD-10): the raw channel carries BOTH kinds of text —
		// /help's sentences and /last's verbatim tool output — so the
		// CALLER says which it is. Verbatim is the default: a surface that
		// has not thought about it must not have its bytes reflowed.
		const fold = this.cell.wrap === "words" ? foldWords : foldLine;
		return this.cell.lines.flatMap((l) => fold(l, W));
	}
}

/** The terminal label + the status line. W11: the rhythm gap blank is
 *  gone — the container's formula breathes below a multi-row cell (the
 *  terminal is always multi-row when labelled), never the component. */
class TerminalBlock implements Component {
	constructor(private readonly cell: { label: string; line: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		return [...foldLine(this.cell.label, W), ...foldLine(this.cell.line, W)];
	}
}

/** The startup banner — a LIVE cell: every render re-derives the tier
 *  from the CURRENT width AND height (bannerLines), so a resize re-tiers
 *  the art instead of re-folding frozen rows (the W1 tier table: below
 *  40 cols the logo never paints). W11: no trailing blank — the
 *  container's formula breathes below the (always multi-row) banner. */
class Banner implements Component {
	constructor(private readonly cell: { version: string; extensionsText: string; resume: ResumeMeta[]; meta?: BannerMeta | undefined }) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		// R2: NO blanket dim. bannerLines styles itself — the labels are
		// dim, the values are ink — and wrapping the whole thing in dim
		// made the answers as faint as the questions.
		void p;
		return bannerLines(W, ctx.height, this.cell.version, this.cell.extensionsText, this.cell.resume, ctx.now, this.cell.meta);
	}
}

/** W20 — the task block's fixed-window height: the whole live block
 *  (header + rows) in POST-FOLD screen rows at EVERY width: the header,
 *  the active row, up to 2 pending, the overflow-pending fold, the
 *  done-collapse. Every live row CUTS at W (never folds) — the block's
 *  height is its row count. */
export const CAP_TASK_LIVE = 6;

/** W20 — the live block's fixed-window row cut: an SGR-aware ONE-ROW
 *  truncation (foldLine wraps; a wrapped row would break the height
 *  cap — every live row is exactly one screen row at every width).
 *  A line that fits (≤ W) passes through whole; an overflow cuts the
 *  content at W−1 — the ellipsis's slot — and the ellipsis rides AFTER
 *  the reset (post-reset — the PTY needles' convention). The cut row
 *  never exceeds W (invariant ①). W21: exported for the approval
 *  panel's single-row lines (the rule line, the title, the divider,
 *  the options/affordance rows). */
export function cutLine(line: string, W: number): string {
	if (visibleWidth(line) <= W) return line;
	let out = "";
	let width = 0;
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			// exec returns an ARRAY — copying m coerces it (the match), but
			// m.length is the CAPTURE count (1), not the sequence length:
			// the old `i += m.length` re-processed the sequence's bracket
			// text as literal rows, doubling every code in a cut line
			// (the W21 panel-slot red test). Index 0 is the sequence.
			const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i))?.[0] ?? line[i]!;
			out += m;
			i += m.length;
			continue;
		}
		const cw = displayWidth(line[i]!);
		if (width + cw > W - 1) break; // reserve the ellipsis's column
		out += line[i]!;
		width += cw;
		i += 1;
	}
	// R8a: the reset comes from the PALETTE, not hardcoded. `\x1b[0m`
	// here put an escape into every cut row under NO_COLOR and behind a
	// pipe — the one context COLOR_OFF exists to keep clean (§1.2). A
	// coloured palette is byte-identical, because its reset IS `\x1b[0m`.
	return `${out}${palette().reset}…`;
}

/** W20 — the settled block's duration, the `2h 14m` form (the task
 *  narrative's long-horizon idiom): minutes+seconds under an hour,
 *  hours+minutes past it. */
export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * W20 — the task checklist as STATE: ONE live block that redraws in
 * place (the current turn's in-place updates), settling at the turn's
 * end as ONE recap block. LIVE (done:false): the fixed "task" prefix +
 * the compositor-derived counts (the model tail rides AFTER — never
 * model-controlled), the active item first with ▸ (the menu's "the
 * current one"), pending next (≤2), the done items COLLAPSED behind the
 * W10 cut family `└ +N done · ctrl+o`, overflow pending behind
 * `└ +N more · ctrl+o` — every row cut at W so the cap holds at every
 * width. ctrl+o (W15) toggles the full list in place (expanded). SETTLED
 * (done:true): the recap idiom `task done · N items · <duration>` + the
 * FULL final item list in the checklist's existing shape (▖/□/▣ —
 * indented two, the glyph leads, no │ gutter).
 */
class Checklist implements Component {
	constructor(
		private readonly cell: {
			header: string;
			items: { text: string; status: "pending" | "active" | "done" }[];
			done: boolean;
			expanded: boolean;
			durationSeconds: number;
		},
	) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const { items, done, expanded, durationSeconds } = this.cell;
		const active = items.filter((i) => i.status === "active");
		const pending = items.filter((i) => i.status === "pending");
		const doneCount = items.length - active.length - pending.length;
		const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
		const tail = this.cell.header === "" ? "" : ` · ${this.cell.header}`;
		const fixed = done
			? `task done · ${plural(items.length, "item")} · ${formatDuration(durationSeconds)}`
			: `task · ${plural(items.length, "item")} · ${active.length} active · ${doneCount} done`;
		const header = `${p.bold}✦${p.reset} ${escapeTerminal(fixed + tail)}`;
		// the FULL-list forms: SETTLED — the durable record (the fold is
		// fine — committed content wraps naturally) — and the LIVE ctrl+o
		// toggle (the header CUTS — the block stays one window high; the
		// expanded rows show the ▣ the collapse hid). The live flag picks
		// the glyphs: the settled list keeps the durable ▖, the expanded
		// live list the ▸.
		const glyph = (status: string, live: boolean): string => {
			const g = status === "pending" ? "□" : status === "active" ? (live ? "▸" : "▖") : "▣";
			return g === "▸" ? `${p.bold}▸${p.reset}` : g;
		};
		if (done || expanded) {
			const rows = done ? foldLine(header, W) : [cutLine(header, W)];
			for (const item of items) rows.push(...foldLine(`  ${glyph(item.status, !done)} ${escapeTerminal(item.text)}`, W));
			return rows;
		}
		// LIVE — the fixed window: the header + the item rows CUT at W
		// (one screen row each — the block's height is its row count,
		// CAP_TASK_LIVE, at every width). The cut is the momentary view;
		// the settle (and the ctrl+o toggle) show everything.
		const itemRows: string[] = [];
		if (active.length > 0) itemRows.push(`  ${p.bold}▸${p.reset} ${escapeTerminal(active[0]!.text)}`);
		for (const item of pending.slice(0, 2)) itemRows.push(`  □ ${escapeTerminal(item.text)}`);
		const more = pending.length - 2;
		if (more > 0) itemRows.push(`  ${p.dim}└ +${more} more · ctrl+o${p.reset}`);
		if (doneCount > 0) itemRows.push(`  ${p.dim}└ +${doneCount} done · ctrl+o${p.reset}`);
		return [cutLine(header, W), ...itemRows.map((r) => cutLine(r, W))];
	}
}

// ---- the chrome components (the status container, the slot, the footer) ----

/** The status container's row: the status text (+ the tail) with the
 *  right-aligned "/ commands · ↑ history" hint in the idle state —
 *  the hint CUT FIRST when the width is short (the #16g rule); when
 *  the STATUS ITSELF cannot fit, it cuts with a "…" — the last resort,
 *  enforced by invariant ① (the old code let the status soft-wrap).
 *  W21: the question param is gone — the old question slot retires; a
 *  pending approval's status IS the panel's (the compositor derives
 *  it from the bound panel state). */
/** R8b — THE IDLE HINT GIVES WAY IN ORDER, and `ctrl+r` is on it.
 *
 *  The transcript viewer shipped in 0.19.0 and was reachable only from
 *  the `?` sheet: not on the banner's key line, not here. A feature
 *  whose only advertisement is a screen you have to already know to
 *  open is DC-30's lesson pointing the other way.
 *
 *  It cannot simply be appended, because this hint is dropped WHOLE
 *  when it does not fit — a longer string would take `/ commands` down
 *  with it on a narrow terminal. So the forms are a ladder, and the
 *  order says which affordance is least replaceable: `/ commands`
 *  survives longest because it is the door to everything; `ctrl+r`
 *  outranks `↑ history` because pressing up is how a person finds the
 *  history by accident, and nothing finds ctrl+r by accident. */
export function idleHint(room: number): string {
	// The third rung is today's hint, kept so that NO width loses
	// something that used to fit: without it, a room of 24-30 columns
	// fell all the way to `/ commands` even though the old form fitted.
	// So the ladder is not a strict ranking of the three affordances —
	// it is the widest honest form at each room, and ctrl+r is on the
	// first two rungs rather than on all of them.
	for (const form of [" / commands · ↑ history · ctrl+r transcript", " / commands · ctrl+r transcript", " / commands · ↑ history", " / commands"]) {
		if (visibleWidth(form) <= room) return form;
	}
	return "";
}

export function statusLine(status: string, tail: string, W: number, hint?: string): string {
	const p = palette();
	const text = `${status}${tail === "" ? "" : ` · ${tail}`}`;
	// W18: the hint is a parameter — the compacting row right-aligns its
	// "esc to cancel" (the same one-line-bounded shape as W12's delegate
	// row; the #16g rule still cuts the HINT first, then the status with
	// a "…" — never a fold).
	const statusW = visibleWidth(text);
	if (statusW > W) {
		return `${p.dim}${widthCut(text, W - 1)}…${p.reset}`;
	}
	const hintText = hint ?? idleHint(Math.max(0, W - statusW));
	const hintW = visibleWidth(hintText);
	if (hintW === 0 || statusW + hintW > W) return `${p.dim}${text}${p.reset}`;
	return `${p.dim}${text}${" ".repeat(Math.max(0, W - statusW - hintW))}${hintText}${p.reset}`;
}

/** The display-width prefix of a plain (SGR-free) text. W21: exported
 *  for the approval panel's option-2 rule-name cut. */
export function widthCut(text: string, max: number): string {
	let w = 0;
	let i = 0;
	for (; i < text.length; i += 1) {
		const cw = displayWidth(text[i]!);
		if (w + cw > max) break;
		w += cw;
	}
	return text.slice(0, i);
}

/**
 * TUI2-R3v2 ① — THE selection bar. One engine, every selection surface.
 *
 * The R1.5 ⑧ ruling settled the shape (a full-row reverse bar, not a
 * two-cell marker you have to hunt for in eighty columns) and the @
 * picker, the user chip and the R2 session picker each grew their own
 * copy of the composition. The approval panel would have been the
 * fourth, so the composition moves HERE and the surfaces call it.
 *
 * Two details are the whole reason this is a function and not four
 * inlined string templates:
 *
 *  - the inner `reset`s are rewritten to reset-then-reverse. A plain SGR
 *    0 inside the bar punches a hole in it: the row goes back to normal
 *    video mid-span and the bar reads as two bars with a gap. The close
 *    is SGR 27 (rvEnd), never SGR 0, for the same reason — the bar
 *    composes INSIDE whatever span surrounds it.
 *  - the pad is computed from the caller's measured VISIBLE width, never
 *    from the styled string's length. A bar that stops short is not a
 *    bar, and one that runs past W crashes the compositor's invariant ①
 *    rather than truncating quietly — so the arithmetic is stated once,
 *    here, and proven once, in the sweep gates.
 *
 * The bar spends one cell of frame at each end, so callers build their
 * spans against W−2 whether the row is selected or not — which is what
 * keeps the columns from moving as the bar walks the list.
 */
export function selectionBar(styled: string, visible: number, W: number): string {
	const p = palette();
	// R2 (design §2.1 — nothing dim ever sits on the wash): the bar IS a
	// wash. A dim span inside it renders grey-on-grey — 3.91:1 on the
	// light ground, under the 4.5 floor — and the dim spans are exactly
	// the descriptions and the metadata, i.e. the half of the row the
	// selection was supposed to help you read. Dim is dropped INSIDE the
	// bar and nowhere else; the same row unselected keeps it.
	const inner = (p.dim === "" ? styled : styled.replaceAll(p.dim, "")).replaceAll(p.reset, `${p.reset}${p.rv}`);
	return `${p.rv} ${inner}${" ".repeat(Math.max(0, W - visible - 2))} ${p.rvEnd}`;
}

/**
 * R2 — the composer's rails, and the ONE edge vocabulary.
 *
 * R3 (owner, 2026-08-27): the rule is a SOLID hairline (`\u2500`), not
 * the dashed `\u254c` R2 shipped, and it is solid EVERYWHERE — the
 * composer, every panel's open and close, the band headers and the
 * markdown rule. One line, one weight, no exceptions to remember.
 *
 * W6 turned two \u254c dotted rows into a rounded box, reasoning that
 * "the box already says input lives here". That is reversed here, and
 * the reason is not taste: a rule is a DELIMITER and a box is a
 * CONTAINER, and the screen was carrying six edge vocabularies at once
 * (this box, the panel's \u2502 gutter and \u2514\u2500\u2500 tail, the
 * diff gutter, the quote's \u258f, the table's rails, the markdown
 * rule). ONE rule replaces the ones that SEPARATE; the \u2502 gutter
 * survives where it SCOPES.
 *
 * Row-neutral by construction: CHROME_ROWS is still 4, so every gate
 * keyed on H \u2212 4 is untouched, and the input row gains the two
 * columns the walls were taking.
 */
export function boxTop(W: number): string {
	// R3: the palette's dim, not a hardcoded SGR 2 — `dim` is an absolute
	// grey once the ground is known, and a rail that hardcodes the
	// attribute would be the one chrome row not obeying the table.
	const p = palette();
	return `${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`;
}

/** R2 — the same rule below. Named for its POSITION, not its shape, so
 *  the compositor's two call sites did not have to move. */
export function boxBottom(W: number): string {
	const p = palette();
	return `${p.dim}${"\u2500".repeat(Math.max(0, W))}${p.reset}`;
}

/** The terminal label + rhythm gap (the pipe path's v2c bytes — the
 *  exact render the passthrough needs). */
export function terminalPipe(label: string, statusLineText: string): string {
	return label + renderTerminalGap(statusLineText);
}

/** The pipe-path pieces the passthrough reuses (byte-identical). */
export { foldThinking, foldResult, renderToolSummary, TOOL_SUMMARY_MAX };
