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

import { displayWidth, visibleWidth, widthCut } from "./width.js";
// TUI2-R2pre ④: the ONE display-verb table (strings.ts, beside
// KEY_BINDINGS). strings.js imports only render/width here, so this edge
// adds no cycle.
import { SHEET_CLOSE, bandHeader, displayVerb } from "./strings.js";
import {
	bannerLines,
	breathFrame,
	cutLine,
	escapeTerminal,
	oneRow,
	stripAnsi,
	foldThinking,
	foldResult,
	renderTerminalGap,
	renderToolSummary,
	toolTarget,
	kUnit,
	palette,
	currentGround,
	TWINKLE,
	fadeRule,
	type Palette,
	type ResumeMeta,
	type BannerMeta,
} from "./render.js";
// TUI2-MD: the markdown renderer's surface reaches the tui through this
// module (the tui's components shim re-exports it) — one import edge,
// and it points one way: md.ts measures with the width authority, never
// back through here.
import { headingLevel, inlineSpans, renderBlock, renderMarkdown, type MdBlock } from "./md.js";
import { hunksDiff, hunksOf, type DiffLine } from "./diff.js";
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
	/* DECLARED REVERSAL (R13): R7a's `grouped` flag stood here — a cell
	   drawn UNDER an activity header wore a plain gutter, the breathing
	   mark belonging to the activity. The header retired with the
	   standing slot, and no caller set the flag after that. */
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
export { visibleWidth, widthCut } from "./width.js";
export { cutLine } from "./render.js";

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
 *  (heights, the line cache) never sees a fake row. */
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

/** Graphite §1.8 — THE CONTENT EDGE. Every block begins at column 2
 *  (owner, 2026-09-29: the 0.44 geometry); columns 0–1 are the mark
 *  column — the seal's `✦`, a streaming thought's twinkle, the live row's
 *  mark, the person's `▌`, a card's edge and its mark cell. */
export const EDGE = "  ";
/** The room a block of words has: from the content edge to two columns
 *  short of the right edge, the same margin on both sides. No width cap —
 *  a cap left the answer and thinking far short of the cards beside them
 *  on a wide terminal (owner, 2026-09-29). */
const proseRoom = (W: number): number => Math.max(1, W - EDGE.length * 2);

// ---- the cell model (the CLI's mutation surface — unchanged from v5) ----

/** Graphite §7.12 — the one word of a notice's sentence that carries the
 *  weight, and its colour: the failure colour, the plan's blue, ink, and
 *  (the tasks round) the success colour of an outcome that went well and
 *  the gold of one nobody can know. */
export interface NoticeMark {
	readonly text: string;
	readonly tone: "fail" | "blue" | "ink" | "ok" | "gold";
}

/** The tasks round — a further row of a one-row notice, drawn under the
 *  first with its own label (`""`: none) in the same cell, so the rows of
 *  one notice stay together (two cells would be a blank apart, D1). */
export interface NoticeRow {
	readonly label: string;
	readonly sentence: string;
	readonly mark?: NoticeMark;
}

/** The last sweep (owner, 2026-10-06) — one part of what `/think` or
 *  `/last` brings back: a dim title (`input`, `output`) when it has one,
 *  and its text in the look of what it is — thinking's grey italic, or a
 *  call's output in `ink2`, hung under the title. */
export interface RecallSection {
	readonly title?: string;
	readonly text: string;
	readonly style: "thinking" | "output";
}

export type BodyCell =
	| { kind: "user"; text: string; done: true; turn: number }
	| {
			kind: "thinking";
			text: string;
			done: boolean;
			turn: number;
			folded?: boolean;
	  }
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
			/** W14: the index of the turn record that created this cell
			 *  (−1 before the first turn). */
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
	/** Graphite §7.12 — `label` and `sentence` are the meta row's two
	 *  halves, derived from `text` by the compositor; `text` is what a
	 *  pipe prints, unchanged. */
	| { kind: "notice"; text: string; done: true; label?: string; sentence?: string; mark?: NoticeMark; stacked?: true; oneRow?: true; also?: readonly NoticeRow[] }
	/** Graphite §7.11 — the turn's seal: its forms, widest first; the
	 *  widest that fits is drawn, and the narrowest is cut. */
	| { kind: "seal"; tiers: readonly string[]; done: true }
	/** 4c — the resumed session's earlier history, replayed into cells and
	 *  FOLDED: the row is ONE line on screen and never expands there (a
	 *  resize reprint of a six-thousand-event session redraws one row);
	 *  the children are the replayed cells, read in the ctrl+r viewer.
	 *  `summary` is a compaction checkpoint's text — what the model sees in
	 *  place of the turns it covers — null for a plain fold. */
	| { kind: "fold"; label: string; children: BodyCell[]; summary: string | null; done: true }
	| { kind: "banner"; version: string; extensionsText: string; resume: ResumeMeta[]; meta?: BannerMeta | undefined; done: true }
	| { kind: "raw"; lines: string[]; done: true; wrap?: "words" }
	/** Graphite §7.13 (G3, R2d) — the person's own `!!cmd`: run and shown,
	 *  never sent (a `!cmd` is a user turn and draws the same way from its
	 *  text, see `bangOf`). */
	| { kind: "bang"; command: string; output: string; isError: boolean; done: true }
	/** The last sweep — what `/think` or `/last` brings back, on the
	 *  terminal: a meta row (`THINKING`, `LAST CALL`) and the sections
	 *  under it. `text` is what a pipe prints, unchanged. */
	| { kind: "recall"; text: string; label: string; sentence: string; sections: readonly RecallSection[]; done: true }
	| { kind: "terminal"; label: string; line: string; done: true };

const TOOL_SUMMARY_MAX = 60; // the tool line's parameter summary, chars

/** The component for one cell — the mapping table lives here so the
 *  compositor stays a pure writer. */
export function cellComponent(cell: BodyCell): Component {
	switch (cell.kind) {
		case "user":
			return new UserMessage(cell);
		case "thinking":
			// R7: the committed/live surface is the BLOCK; the pipe path
			// prints render.ts's one-row foldThinking instead, whose bytes
			// are asserted by the --plain identity gate.
			return new ThinkingBlock(cell);
		case "tool":
			return new ToolExecution(cell);
		case "md":
			return new MarkdownBlock(cell);
		case "notice":
			return new ErrorLine(cell);
		case "seal":
			return new SealLine(cell);
		case "fold":
			return new FoldRow(cell);
		case "banner":
			return new Banner(cell);
		case "raw":
			return new RawBlock(cell);
		case "bang":
			return new BangCard(cell);
		case "recall":
			return new RecallBlock(cell);
		case "terminal":
			return new TerminalBlock(cell);
	}
}

/** G3 (R2d) — the block `!cmd` sends: a `console` fence holding `$ <command>`
 *  and what it printed (apps/cli dispatch.ts `runBang`). Null for any
 *  other text. */
export function bangOf(text: string): { command: string; output: string } | null {
	const m = /^```console\n\$ ([^\n]*)\n([\s\S]*)\n```$/.exec(text);
	return m === null ? null : { command: m[1]!, output: m[2]! };
}

/** G3 (R2d) — the person's command as a card on their own warm ground: a
 *  pad row, `$ <command>` with what became of it at the right (`exit N`
 *  when the output says so, then `sent to the model` or `not sent`), what
 *  it printed under the command in `ink2`, a pad row. `cap` keeps the
 *  output's TAIL (a command's conclusion is at its end) with the count of
 *  what was cut above it; null shows it all. Off a known ground: the same
 *  words, no surface. */
function bangRows(command: string, output: string, isError: boolean, fate: string, W: number, cap: number | null): string[] {
	const p = palette();
	const painted = p.human !== "";
	const exit = /^exit (\d+)/.exec(output);
	const outcome = [exit !== null ? `exit ${exit[1]}` : isError ? "failed" : "", fate].filter((x) => x !== "").join(" \u00b7 ");
	const textW = Math.max(1, W - PERSON_COL - 2 - CHIP_RIGHT);
	let lines = escapeTerminal(stripAnsi(output)).replace(/\n+$/, "").split("\n").flatMap((l) => foldLine(l, textW));
	if (lines.length === 1 && lines[0] === "") lines = [];
	let cut = 0;
	if (cap !== null && lines.length > cap) {
		cut = lines.length - cap;
		lines = lines.slice(lines.length - cap);
	}
	const cmd = escapeTerminal(command);
	const headRoom = Math.max(1, W - PERSON_COL - CHIP_RIGHT);
	const tail = ` ${outcome}`;
	const headText = visibleWidth(`$ ${cmd}${tail}`) + 1 <= headRoom ? `$ ${cmd}` : widthCut(`$ ${cmd}`, Math.max(1, headRoom - visibleWidth(tail) - 2));
	const gap = " ".repeat(Math.max(1, headRoom - visibleWidth(headText) - visibleWidth(outcome)));
	if (!painted) {
		const rows = [cutLine(`${" ".repeat(PERSON_COL)}${p.bold}${headText}${p.reset}${gap}${p.dim}${outcome}${p.reset}`, W)];
		if (cut > 0) rows.push(cutLine(`${" ".repeat(PERSON_COL + 2)}${p.dim}\u2026 ${cut} earlier line${cut === 1 ? "" : "s"}${p.reset}`, W));
		for (const l of lines) rows.push(cutLine(`${" ".repeat(PERSON_COL + 2)}${p.dim}${l}${p.reset}`, W));
		return rows;
	}
	const row = (inner: string): string => {
		const pad = " ".repeat(Math.max(0, W - 2 - visibleWidth(inner)));
		return `${p.humanEdge} ${p.human}${p.humanInk} ${inner.replaceAll("\x1b[0m", `\x1b[0m${p.human}${p.humanInk}`)}${pad}${p.fgEnd}${p.washEnd}`;
	};
	const padRow = `${p.humanEdge} ${p.human}${" ".repeat(Math.max(0, W - 1))}${p.washEnd}`;
	// `$ <command>` is ONE span: a reader (and a needle) finds the command
	// line as it was typed
	const head = `${p.bold}${headText}${p.reset}${gap}${p.dim}${outcome}${p.reset}`;
	const body = [...(cut > 0 ? [`  ${p.dim}\u2026 ${cut} earlier line${cut === 1 ? "" : "s"}${p.reset}`] : []), ...lines.map((l) => `  ${p.ink2}${l}${p.fgEnd}`)];
	return [padRow, row(head), ...body.map(row), padRow].map((r) => cutLine(r, W));
}

/** G3 (R2d) — `!!cmd`: the card, all of the output (the person asked to
 *  see it here), `not sent`. */
class BangCard implements Component {
	constructor(private readonly cell: { command: string; output: string; isError: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		return bangRows(this.cell.command, this.cell.output, this.cell.isError, "not sent", W, null);
	}
}

/**
 * REL-0152-D13 — how much of a turn the chip shows.
 *
 * Twelve rows is enough to recognise what you sent and short enough
 * that sending it does not scroll away what you were looking at. The
 * bound is on ROWS, after folding, so one enormous line is caught by
 * the same rule as three thousand short ones.
 */
const USER_CHIP_ROWS = 12;
/** Graphite §7.9 — the text starts at the content edge (column 4) and
 *  stops two columns short of the right edge. */
const CHIP_RIGHT = 2;

/** Graphite §7.9 — the person's words start at the content edge. */
const PERSON_COL = EDGE.length;

/**
 * Graphite §7.9 — THE PERSON'S BLOCK.
 *
 * On a known ground: the warm `human` ground across the full width, a
 * whole row of it above and below (§1.5: a pad is a row of BACKGROUND —
 * the half-row glyphs R1b tried left a seam in Apple Terminal), an EDGE
 * cell of quieted gold in column 0 down every row — the same width as a
 * card's edge, and like it a background, since a `▌` glyph shows a break
 * at every row there — and the text at the content edge in `humanInk`.
 * No label and no time: the block says whose words these are.
 *
 * On an unknown ground nothing is painted that assumes a background
 * (§3.1): the `▌` in column 0, which is a character and so still marks
 * the person's words once the escapes are stripped (§1.2), and reverse
 * video from column 1.
 *
 * The fold is by WORD (R9 Q3: a word wider than the row still breaks,
 * because invariant ① outranks it), ONE width over every row (DC-6), and
 * padding is by display width, so a CJK row pads by cells.
 */
class UserMessage implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		// G3 (R2d): a `!cmd` turn — the block the dispatcher sends — draws as
		// the person's command card; the model's bytes are the text as sent
		const bang = bangOf(this.cell.text);
		if (bang !== null) return bangRows(bang.command, bang.output, false, "sent to the model", W, USER_CHIP_ROWS);
		const painted = p.human !== "";
		const chipW = Math.max(1, W - PERSON_COL - CHIP_RIGHT);
		const paras = this.cell.text.split("\n");
		// Graphite §5 (G6, R2b): the person's words render as markdown, the
		// line breaks they typed kept. REL-0152-D13: only as far as the
		// bound needs — a pasted file has thousands of lines and twelve rows
		// are shown, so a prefix of the source is rendered (a few lines past
		// the bound, so a block that closes there still closes).
		const source = paras.slice(0, USER_CHIP_ROWS + 4).join("\n");
		const rendered = renderMarkdown(escapeTerminal(source), chipW, { hardBreaks: true });
		const truncated = rendered.length > USER_CHIP_ROWS || paras.length > USER_CHIP_ROWS + 4;
		const content = rendered.slice(0, USER_CHIP_ROWS);
		const fill = (row: string): string => " ".repeat(Math.max(0, chipW - visibleWidth(row) + CHIP_RIGHT));
		const padRow = `${p.humanEdge} ${p.human}${" ".repeat(Math.max(0, W - 1))}${p.washEnd}`;
		// every reset inside a row re-opens the block's ground and ink, so a
		// styled span never strands the rest of the row off the block
		const onGround = (row: string): string =>
			row.replaceAll("\x1b[0m", `\x1b[0m${p.human}${p.humanInk}`).replaceAll("\x1b[49m", p.human).replaceAll("\x1b[39m", p.humanInk);
		const out = painted
			? [padRow, ...content.map((row) => `${p.humanEdge} ${p.human}${p.humanInk} ${onGround(row)}${fill(row)}${p.fgEnd}${p.washEnd}`), padRow]
			: content.map((row) => `\u258c${p.rv} ${row.replaceAll("\x1b[0m", `\x1b[0m${p.rv}`)}${fill(row)}${p.rvEnd}`);
		if (!truncated) return out;
		// The notice is OUTSIDE the block, in the cut-row vocabulary, and it
		// says what matters: the model got all of it (DC-45: it folds too —
		// `sent in full` is the semantics and gives way last).
		const more = Math.max(0, paras.length - content.length);
		const count = more > 0 ? `+${more} more line${more === 1 ? "" : "s"}` : "cut here";
		const short = more > 0 ? `+${more}` : "cut";
		// on a very narrow terminal the edge gives way before the notice does
		const lead = W - PERSON_COL >= 8 ? " ".repeat(PERSON_COL) : "";
		out.push(cutLine(`${lead}${p.dim}\u2514 ${pickTier([`${count} \u00b7 sent in full`, `${short} \u00b7 sent in full`, "sent in full", count], Math.max(1, W - lead.length - 2))}${p.reset}`, W));
		return out;
	}
}

/**
 * Graphite §8.7, the main-sync round (owner, 2026-09-30) — a STEER that
 * has not landed is ONE row in the live zone:
 *
 *   ◇ <the message's first line>                  next step · ↑ takes back
 *
 * ADR-0057: Enter while a run works steers it — there is no queue on a
 * terminal — and the steer lands inside the same run at its next quiet
 * step, or after an open approval, which it never answers. The gold `◇`
 * (a message the person sent that has not landed, §4) in the mark column
 * and the text at the content edge; no label word (owner: the mark says
 * it). The keys at the right say what happens next and give way first
 * when the row is short. DECLARED REVERSAL of the `◇ queued … after this
 * turn · ↑ edit` row, whose queue main retired in 0.45.0.
 */
export function pendingQueueRows(lines: readonly string[], W: number, waiting: "step" | "approval" = "step"): string[] {
	const p = palette();
	const mark = p.goldMark === "" ? "\u25c7" : `${p.goldMark}\u25c7${p.fgEnd}`;
	const keys = `${waiting === "approval" ? "after the approval" : "next step"} \u00b7 \u2191 takes back`;
	return lines.map((line) => {
		const lead = `${mark} `;
		const leadW = visibleWidth(lead);
		const text = escapeTerminal(line);
		const withKeys = W - leadW - visibleWidth(keys) - 2;
		if (withKeys >= Math.min(12, visibleWidth(text))) {
			const shown = visibleWidth(text) <= withKeys ? text : `${widthCut(text, Math.max(1, withKeys - 1))}\u2026`;
			return `${lead}${shown}${" ".repeat(Math.max(2, W - leadW - visibleWidth(shown) - visibleWidth(keys)))}${p.dim}${keys}${p.reset}`;
		}
		const room = Math.max(1, W - leadW);
		return cutLine(`${lead}${visibleWidth(text) <= room ? text : `${widthCut(text, Math.max(1, room - 1))}\u2026`}`, W);
	});
}

/**
 * Graphite §7.2 — THINKING IS WORDS, under its label.
 *
 * `THINK <seconds>` in blue at the content edge, then the model's
 * reasoning as `dim` italic paragraphs, shown in full and never folded
 * (R7, the owner: "I cannot see what it was thinking" was the complaint
 * through four rounds of folding). While the block streams, the label
 * carries the twinkle, hanging in the mark column; the seconds appear
 * when it settles, and only if they were measured — a block replayed from
 * the log has no clock.
 *
 * The LABEL is what tells thinking from the answer once the escapes are
 * stripped (§1.2): the answer carries none. A pipe never sees a thinking
 * paragraph — the inactive path writes `foldThinking`'s one line.
 *
 * `ctrl+t` hides every block to its label line (`· hidden · ctrl+t`), and
 * the text is never drawn while hidden, live or settled.
 *
 * Paragraphs are kept (a blank row between them); newlines INSIDE one
 * collapse, because a hard-wrapped source line is the model's width, not
 * the reader's.
 */
/**
 * Graphite §7.2 — THINKING: the model's reasoning as it streams, `dim`
 * italic at the content edge, folded by WORD like every prose surface.
 * No label (owner, 2026-09-29): the grey italic is what tells it from the
 * answer. While it streams the twinkle hangs in the mark column of its
 * first row; settled, the column is empty (§4.2). Hidden (ctrl+t), it is
 * one dim row that says so. With colour off there is no grey and no
 * italic to tell it by, so there — and only there — its first row opens
 * with the plain word `thinking:`.
 *
 * 0.47.3 — a paragraph's INLINE markdown is drawn, as the answer's is
 * (`inlineSpans`, with the grey italic as the style every span closes
 * back to): a reasoning summary opens on a `**title**`, and its asterisks
 * read as noise. `**bold**`, code spans, links and escapes render; a
 * marker with no closer yet stays literal (the stream's half-written
 * `**`). Blocks do not: a paragraph is still one folded run, so lists,
 * headings and fences read as their source. An italic span inside
 * thinking is already italic, so its closing SGR 23 is dropped — kept,
 * it would end the paragraph's own italic halfway through.
 */
class ThinkingBlock implements Component {
	constructor(private readonly cell: { text: string; done: boolean; folded?: boolean }) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const c = this.cell;
		const text = escapeTerminal(c.text).trim();
		if (text === "") return [];
		const mark = c.done ? EDGE : `${p.gold}${TWINKLE[ctx.spinnerI % TWINKLE.length]}${p.gold === "" ? "" : p.fgEnd} `;
		if (c.folded) return [cutLine(`${mark}${p.dim}${p.italic}thinking \u00b7 hidden \u00b7 ctrl+t${p.italicEnd}${p.reset}`, W)];
		const room = proseRoom(W);
		const plainWord = p.italic === "" && p.dim === "" ? "thinking: " : "";
		const base = `${p.dim}${p.italic}`;
		const rows: string[] = [];
		for (const para of text.split(/\n\s*\n/)) {
			const flat = para.replace(/\s+/g, " ").trim();
			if (flat === "") continue;
			if (rows.length > 0) rows.push("");
			const spans = inlineSpans(flat, base);
			const styled = p.italicEnd === "" ? spans : spans.split(p.italicEnd).join("");
			const lead = rows.length === 0 ? `${plainWord}${styled}` : styled;
			for (const line of foldWords(lead, room)) rows.push(`${rows.length === 0 ? mark : THINK_COL}${base}${line}${p.italicEnd}${p.reset}`);
		}
		return rows;
	}
}

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

/** A line of text folded to `width` cells, breaking after the last space
 *  that fits (the space is the break), or hard at the width when a run has
 *  none. Every other character is kept, in order. */
export function foldAtSpaces(text: string, width: number): string[] {
	const rows: string[] = [];
	let rest = text;
	while (visibleWidth(rest) > width) {
		const head = widthCut(rest, width);
		const space = head.lastIndexOf(" ");
		const cut = space > 0 ? space + 1 : Math.max(1, head.length);
		rows.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut);
	}
	rows.push(rest);
	return rows;
}

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
export function foldWords(line: string, W: number): string[] {
	if (W < 1) return [line];
	const out: string[] = [];
	for (const para of line.split("\n")) {
		if (visibleWidth(para) <= W) {
			out.push(para);
			continue;
		}
		// LINEAR (the thinking-freeze fix, 2026-09-30): the row's remainder is
		// never re-measured or rebuilt as a string. It was — `visibleWidth` of
		// the whole rest and a new rest string per row — which is O(n²/W) for
		// one long paragraph, and a thinking block is ONE flattened paragraph
		// re-folded every frame: 61 ms a render at 40k characters, long enough
		// to starve the working row's timer (the twinkle froze while the model
		// thought). The rows are byte for byte what they were: `rest` is the
		// same `open` prefix + the same tail, read through a cursor.
		// the spans open at the cut point, so each emitted row closes them
		// and the next row reopens them — foldLine's own discipline, applied
		// across the segments this function creates.
		let pos = 0;
		let open: string[] = [];
		while (widerFrom(para, pos, W)) {
			// the widest prefix that fits, then back up to the last space in
			// it — the SGR-aware cut keeps the spans intact
			const pre = open.join("");
			const head = headOf(pre, para, pos, W);
			const at = head.lastIndexOf(" ");
			if (at <= 0) break; // one long word (or no space at all) — hard-break it
			const cut = head.slice(0, at);
			out.push(`${cut}${open.length > 0 || /\x1b\[[0-9;]*m/.test(cut) ? "\x1b[0m" : ""}`);
			open = spansOpenAfter(cut, open);
			// the space the row broke at is consumed; the prefix was never in `para`
			pos += at + 1 - pre.length;
		}
		out.push(...foldLine(`${open.join("")}${para.slice(pos)}`, W));
	}
	return out.length > 0 ? out : [""];
}

/** `visibleWidth(s.slice(from)) > W`, answered by reading at most the
 *  first W + 1 visible cells (and the escapes among them) — never the
 *  whole remainder. The same skip rule as visibleWidth. */
function widerFrom(s: string, from: number, W: number): boolean {
	let w = 0;
	for (let i = from; i < s.length; ) {
		if (s[i] === "\x1b") {
			const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i, i + 256));
			i += m !== null ? m[0].length : 1;
			continue;
		}
		// per UTF-16 unit, exactly as visibleWidth counts
		w += displayWidth(s[i]!);
		if (w > W) return true;
		i += 1;
	}
	return false;
}

/** `widthCut(pre + s.slice(from), W)` without building the whole string:
 *  widthCut stops within its first W cells, so a window of the tail is
 *  enough — widened (doubling) only when the cut ran to the window's end
 *  before the tail's (a run of zero-width code points). */
function headOf(pre: string, s: string, from: number, W: number): string {
	for (let span = 2 * W + 256; ; span *= 2) {
		const probe = `${pre}${s.slice(from, from + span)}`;
		const head = widthCut(probe, W);
		if (head.length < probe.length || from + span >= s.length) return head;
	}
}

export function gutterFold(gutter: string, line: string, W: number): string[] {
	const textW = Math.max(1, W - 2);
	return foldLine(line, textW).map((r) => `${gutter}${r}`);
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
function settledMeta(c: { name: string; input: string; inputFull: string; resultText: string; added: number; removed: number; isError: boolean }): string {
	if (c.isError) {
		// a shell EXECUTION failure names its code first ("exit 1: …") —
		// that IS the metadata, and the body shows the full text. A
		// shell without the code (a denial, a precondition) is not an
		// exit failure: the first line stays the metadata, exactly like
		// any other error.
		if (c.name === "shell" && /^exit \d+/.test(c.resultText)) return `exit ${/^exit (\d+)/.exec(c.resultText)![1]}`;
		// Graphite §7.5: the outcome is a WORD on the head row — the error's
		// own text is the card's body, where it has the room to be read
		return "failed";
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
		// R2a: the call's own diff speaks for it — a batch's hunks counted
		// together, a write as a new file or a rewrite
		const edit = editDiffOf(c);
		if (edit !== null) return edit.meta;
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
		const hunks = c.name === "edit_file" && parsed !== null ? hunksOf(parsed) : null;
		if (hunks !== null) {
			const added = hunks.reduce((n, h) => n + countLines(h.replace), 0);
			const removed = hunks.reduce((n, h) => n + countLines(h.search), 0);
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

/**
 * Graphite §7.4 — THE CARD: one per call (R13), one skeleton in every
 * state —
 *
 *   head · body · foot
 *
 * The head carries the verb, the target (a command folds under itself,
 * at most three rows collapsed), and at its right end the outcome, a
 * running or waiting card's mark in front of it (§7.5). The body is the
 * preview, aligned under the verb; when it cut rows away, its cut note
 * carries the `ctrl+o` key at the right margin. The foot is the way back
 * on an expanded card; a card with no body carries the key at the end of
 * its head row instead (the card round, owner 2026-10-05). The ground is
 * the call's STATE (§1.6): the machine's blue while it runs and once it
 * has run, red failed or refused, gold waiting for the person. No pad
 * rows and no side bar: surfaces are backgrounds only (§1.5).
 *
 * On an unknown ground nothing is painted (§3.1): the head at the content
 * edge, the body indented under it and opened by `└`, the foot dim. The
 * CONTENT is the same either way.
 */
class ToolExecution implements Component {
	constructor(private readonly cell: Extract<BodyCell, { kind: "tool" }>) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const c = this.cell;
		const verb = escapeTerminal(displayVerb(c.name)).toUpperCase();
		// the card round: a command folds whole (three rows collapsed, all of
		// it expanded); every other target is one row
		const fold = c.name === "shell" ? (c.expanded ? Number.POSITIVE_INFINITY : HEAD_ROWS) : 0;
		if (c.state === "done") {
			// R3i phase 5: an answered (or declined) ask_user renders its OWN
			// block — the questions and what the human said.
			if (c.name === "ask_user" && c.reason === null && !c.isError) {
				const asked = askedBlock(c.resultText, c.startedAt !== null && c.doneAt !== null ? (c.doneAt - c.startedAt) / 1000 : c.startedAt === null && c.doneAt === null ? null : 0, W);
				if (asked.length > 0) return asked;
			}
			// W19: the refused call — a failed card whose outcome is the
			// refusal and its reason; the [result] body still rides below
			// (never hide information). A5: an extension's denial names it.
			// Graphite §7.5 (R3b): a call still open when the person stopped the
			// turn was not refused by anyone — it says `interrupted`, on the
			// machine's ground (it was running), its output so far below. It
			// used to read `denied · interrupted` on the failure ground.
			if (c.reason === "interrupted") {
				const body = toolBlockParts(c, W, ctx);
				return card("run", "  ", verb, escapeTerminal(toolTargetOf(c)), ["interrupted"], body.rows, null, W, false, fold);
			}
			if (c.reason !== null) {
				// VD-11: a PERSON's refusal is worth saying (they were asked
				// and answered); a policy's is ambient. The outcome word says
				// which, once.
				const word = c.verdict !== null && c.verdict.decision === "denied" && c.verdict.decidedBy === undefined ? "denied by you" : "denied";
				// 0.47.1 (finding 0470-F4, owner 2026-10-07): said once. The
				// runtime's reason when the person gave none is the words
				// "denied by user" — `denied by you · denied by user` said the
				// refusal twice on one row, and the body (`[Permission denied]
				// denied by user`, what the model was handed) a third time. So
				// that refusal is `denied by you` alone, with no body. A refusal
				// WITH a reason keeps both: the head gives its reason way on a
				// narrow row (the pinned order), and the body still says it.
				const quiet = word === "denied by you" && c.reason === DEFAULT_REFUSAL;
				const outcome = quiet ? [word] : [`${word} \u00b7 ${escapeTerminal(c.reason)}`, word];
				const body = quiet && c.resultText.trim() === `[Permission denied] ${c.reason}` ? { rows: [] as string[] } : toolBlockParts(c, W, ctx);
				return card("fail", "  ", verb, escapeTerminal(toolTargetOf(c)), outcome, body.rows, null, W, true, fold);
			}
			// 4c: a card settled from the durable log carries no clock at
			// all — it says nothing about time rather than `?s`.
			const elapsed = c.startedAt !== null && c.doneAt !== null ? settledLabel((c.doneAt - c.startedAt) / 1000) : c.startedAt === null && c.doneAt === null ? "" : "?s";
			// The tasks round (owner, 2026-10-06): a BACKGROUND delegation
			// returns at once, so its card settles in a tenth of a second with
			// the work only just begun. It names its children — the roles on
			// the head, `N in the background`, a row per child with the task id
			// `/tasks` and the notice use — instead of the foreground summary it
			// never writes (the card read `DELEGATE … 1 line` with no target).
			const children = c.name === "delegate" && !c.isError ? backgroundChildren(c) : null;
			if (children !== null) {
				const p2 = palette();
				const rw = Math.max(...children.map((x) => x.role.length));
				const room = bodyRowRoom(W);
				const rows = children.map((x) => cutLine(`${bodyRow()}${x.id}  ${p2.ink2}${x.role.padEnd(rw)}${p2.ink2 === "" ? "" : p2.fgEnd}  ${p2.dim}${x.task}${p2.reset}`, room));
				const outcome = `${children.length} in the background${elapsed === "" ? "" : ` \u00b7 ${elapsed}`}`;
				return card("done", "  ", verb, children.map((x) => x.role).join(" \u00b7 "), [outcome], slabPaints() ? rows : openBlock(rows), null, W, false);
			}
			const rawMeta = settledMeta(c);
			const meta = escapeTerminal(rawMeta);
			const attr = attribution(c).replace(/^ · /, "");
			// VD-6: the line count is stated exactly ONCE — a meta that
			// already counts lines gets no second count beside it.
			// R2a: an edit's or a write's result is kiso's receipt (`edited
			// <path>` and its revision), not something it made: its diff is
			// the body, and the receipt's line count is no fact about it
			const n = editDiffOf(c) === null ? countLines(c.resultText) : 0;
			const counted = n > 0 && !/^\d+( of \d+)? lines?$/.test(rawMeta) ? `${n} line${n === 1 ? "" : "s"}` : "";
			const join = (...xs: string[]): string => xs.filter((x) => x !== "").join(" \u00b7 ");
			// pin 4's order: the ATTRIBUTION gives way first, then the count;
			// what happened and how long it took is never cut open.
			// The last tier is the CORE — what happened and how long it took;
			// below it the target elides (headCore), never the core.
			const tiers = [join(meta, counted, elapsed, attr), join(meta, counted, elapsed), join(meta, elapsed)];
			const body = toolBlockParts(c, W, ctx);
			const state = c.isError ? "fail" : "done";
			if (body.rows.length > 0) {
				// the foot is the way back: an expanded card's, when collapsing
				// would hide something again (a card whose whole body always
				// shows has no way back to offer). A collapsed card's key stands
				// on its cut note's row (the card round, `cutNote`).
				const collapsed = { ...c, expanded: false };
				const behind = c.expanded && (toolBlockParts(collapsed, W, ctx).cut || hiddenLines(collapsed, W) !== null);
				const foot = behind ? COLLAPSE_ROW : null;
				return card(state, "  ", verb, escapeTerminal(toolTargetOf(c)), tiers, body.rows, foot, W, c.isError, fold);
			}
			// no body: the head row between its pads, and the key — when the
			// result sits behind it (a read) — at the end of the head row
			const hidden = hiddenLines(c, W);
			// the key is RESERVED (TUI2-R1.5 ⑤): its words shorten only after
			// the attribution and the count have given way
			const keyed = hidden === null ? tiers : [...tiers.map((t) => `${t} \u00b7 ${EXPAND_ROW}`), `${tiers[tiers.length - 1]!} \u00b7 ctrl+o`];
			return card(state, "  ", verb, escapeTerminal(toolTargetOf(c)), keyed, [], null, W, c.isError, fold);
		}
		if (c.state === "approval") {
			const body = toolBlockParts(c, W, ctx);
			// a foot only where there is a body above it (§1.3)
			return card("ask", `${p.gold}\u276f${p.gold === "" ? "" : p.fgEnd} `, verb, liveTarget(c), ["needs you"], body.rows, c.expanded && body.rows.length > 0 ? COLLAPSE_ROW : null, W, false, fold);
		}
		if (c.state === "running") {
			// R3 (design §5.2): a running call BREATHES in its mark cell; its
			// duration rides the head row's right end, where the settled
			// card's outcome will stand — the settle changes the words and
			// the ground, never the height (DC-46: the settle may add only
			// the foot).
			const elapsed = c.startedAt !== null ? Math.max(1, Math.round((ctx.now - c.startedAt) / 1000)) : 1;
			const el = elapsedLabel(elapsed);
			const gestures = c.name === "shell" ? " \u00b7 esc stops \u00b7 alt+\u23ce redirects" : "";
			// the gestures give way first (the live row names the same keys);
			// `running · Ns` is the core, and the narrow ladder keeps the
			// elapsed alone at the very end
			const tiers = [`running \u00b7 ${el}${gestures}`, `running \u00b7 ${el}`];
			const mark = `${breathFrame(ctx.spinnerI)} `;
			// DC-43: with too little room for a card the call keeps its head
			// row alone until it commits — the one form that fits anywhere.
			const liveRows = ctx.liveWindow ?? CAP_PREVIEW;
			if (liveRows <= 0) return [cardHeadRow(mark, verb, liveTarget(c), tiers, W, false, false)];
			const body = toolBlockParts(c, W, ctx);
			return card("run", mark, verb, liveTarget(c), tiers, body.rows, c.expanded && body.rows.length > 0 ? COLLAPSE_ROW : null, W, false, fold);
		}
		// not started yet (queued behind an exclusive call): the same card,
		// its outcome says so.
		return card("run", "  ", verb, liveTarget(c), ["queued"], [], null, W, false, fold);
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
 * (the `… N · ctrl+o expands` note) already teaches the key at the
 * place the content stops. What is LEFT — and it is the
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
	if (c.isError) return null; // an error previews its text, and the foot carries the key
	// R13: a call that PREVIEWS carries the key on its own note row when
	// something is cut, and needs no affordance at all when nothing is.
	// A head-row suffix as well would be TUI2-R1's two affordances for
	// one cell — the thing that rule exists to forbid. read_file is the
	// one call with no preview (E1), so the key lives on its head row.
	if (c.name !== "read_file") return null;
	return n;
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

/* DECLARED REVERSAL (D-S2-1, owner-ruled 2026-09-06): `focusToken` and
   `EXPAND_KEY` stood here — TUI2-R2 ⑤'s bright ctrl+o token on the
   newest live card, "exactly one bright token per frame". DC-50 made
   ctrl+o a global switch, so there was no target left for a marker to
   name; the status row's idle hint names the switch (`idleHint`). */

/** TUI2-R1 (A) — the expanded card's key: the way back. */
const COLLAPSE_ROW = "ctrl+o collapses";
/** Graphite §7.4 — the key on a card with rows behind it. */
const EXPAND_ROW = "ctrl+o expands";

/* DECLARED REVERSAL (R13, owner-ruled 2026-09-03): the W13 rollup's
   noun table (`ROLLUP_NOUN`) and TUI2-R1 (B)'s exploration-run set
   (`EXPLORE_NOUN`, `isExploreTool`) stood here. Both collapses retired
   with the fold; the verb column is `displayVerb` for every tool. */

/**
 * THE TERM TABLE — [past, singular, plural], one row per tool the recap
 * names (R3g's phrasing, the owner's: "thought 17s · read 4 files ·
 * listed 1 directory · ran 4 shell commands"). A tool with no entry
 * says `3 × <verb>`, which counts calls without inventing a noun for
 * them; a zero term is dropped (R3b: a term earns its place by having a
 * count). The terms count CALLS, which is what the CLI hands them.
 *
 * DECLARED REVERSAL (R13, owner-ruled 2026-09-03): this table served
 * the folded-turn line (W14, `turnFold`) and R3i's stretch line, and
 * carried a PROGRESSIVE column so the live tense and the settled tense
 * could not drift apart. Nothing folds and nothing reads the
 * progressive; the recap (`foldTerms`) is the table's only reader.
 * R3h's object-vs-act distinction (`foldCountsObjects`) retired with
 * the fold that consumed it.
 */
const TERM: Readonly<Record<string, readonly [string, string, string]>> = {
	read_file: ["read", "file", "files"],
	edit_file: ["edited", "file", "files"],
	write_file: ["wrote", "file", "files"],
	list_dir: ["listed", "directory", "directories"],
	search_text: ["ran", "search", "searches"],
	shell: ["ran", "shell command", "shell commands"],
};

function foldTerm(name: string, n: number): string {
	const t = TERM[name];
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
 * It is WORDS, not work (law 1.7): no summary ever stands for it,
 * because the one thing a summary must not do is speak for the human.
 *
 * A result that is not the ask's own JSON yields NOTHING. This renderer
 * reads a payload it did not write, and a guess about what it means
 * would be a row the product cannot stand behind.
 */
/** `seconds` null: 4c's replayed card, settled from a log with no clock —
 *  the head names the outcome and says nothing about time. */
export function askedBlock(resultText: string, seconds: number | null, W: number): string[] {
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
		cutLine(`${EDGE}${p.bold}asked${p.reset} ${n} ${n === 1 ? "question" : "questions"} ${p.dim}(${seconds === null ? outcome : `${outcome}, ${seconds.toFixed(1)}s`})${p.reset}`, W);
	const row = (body: string): string => cutLine(`${EDGE}${p.dim}│${p.reset} ${body}`, W);

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

/* DECLARED REVERSAL (R13, owner-ruled 2026-09-03): the stretch line's
   term machinery stood here — `StretchTerms`, `STRETCH_COMPACT`,
   `stretchTerms` (R3i's one-line-per-stretch, R4's per-term tense).
   The line retired with the fold; the TERM table above survives for the
   turn's recap alone. */

// ---- the bounded-block flow contract (W7, W8, W10) ----

/** The caps — screen rows counted AFTER the fold, at the current width
 *  (the W7 table). The renderer-cut row is inside the cap. */
/** R13 — ONE preview cap, every tool. It was the shell's alone while
 *  the shell was the only settled call with rows on screen. */
export const CAP_PREVIEW = 5;
/** DC-46 — the running window's ceiling is the SETTLED preview's, and a
 *  running card reaches it by growing rather than by being handed it.
 *  `LIVE_WINDOW` (CAP_PREVIEW + 1) retires with the allocation it sized. */
const CAP_DIFF = 12; // the approval diff: head + the named middle + tail

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
 *  mark meaning two things (§4.1). */
/** Graphite §7.4 — off the surface (unknown ground), a card's body sits
 *  two columns under its head: the head at the content edge (2), the body
 *  at 4, opened by `└` (R8a's indent, which is what says "these rows are
 *  output" once nothing is painted). */
const BODY_ROW_FLAT = "    ";
/** Inside a painted card the body sits at the content edge, under the
 *  verb — the head and what it printed line up (owner, 2026-09-29, the
 *  0.44 card's alignment). */
const CARD_BODY = "";
/** A card's inner right margin. */
const CARD_RIGHT = 1;
/** The cells a painted card has for its content: after its edge cell and
 *  its mark cell, from the content edge to the right edge. */
const cardInner = (W: number): number => Math.max(1, W - EDGE.length);
/** Graphite §1.8 — the model's words and its thinking begin at the
 *  content edge, like every other block. */
const PROSE_COL = EDGE;
const THINK_COL = EDGE;
const bodyRow = (): string => (slabPaints() ? CARD_BODY : BODY_ROW_FLAT);
const noteIndent = bodyRow;
/** The cells a body row's text has: under the target inside a card, under
 *  the flat indent outside one. */
const bodyTextWidth = (W: number): number => Math.max(1, slabPaints() ? cardInner(W) - CARD_BODY.length - CARD_RIGHT : W - BODY_ROW_FLAT.length);
/** The cells a whole body row has (its indent included). */
const bodyRowRoom = (W: number): number => Math.max(1, slabPaints() ? cardInner(W) - CARD_RIGHT : W);

/**
 * Graphite §7.4 / §3.1 — a card paints only where the ground is known:
 * there its surfaces are real backgrounds. On the unknown ground they
 * would be reverse video, and eight inverted output rows are a black slab
 * in the middle of the transcript, so the card keeps its content and
 * loses its surface.
 */
function slabPaints(): boolean {
	return palette().washDone !== "" && currentGround() !== "unknown";
}

/**
 * Graphite §7.4 — a card's STATE, which is its ground. Running and run
 * share the machine's blue (owner, 2026-09-29): a call that finishes in a
 * tenth of a second used to flash blue and turn grey, and the state is
 * already carried by the mark (the breath while it runs) and the outcome
 * word. Red is failed or refused; gold waits for the person.
 */
type CardState = "run" | "done" | "fail" | "ask";
function cardPaint(state: CardState): { bg: string; edge: string } {
	const p = palette();
	if (state === "fail") return { bg: p.washFail, edge: p.failEdge };
	if (state === "ask") return { bg: p.washAsk, edge: p.askEdge };
	return { bg: p.washRun, edge: p.runEdge };
}

/** One painted card row, the full width: the edge cell in column 0, the
 *  mark cell in column 1, the content from the content edge, the state's
 *  ground to the right edge, padded by DISPLAY width. A reset inside the
 *  content would strand the ground for the rest of the row, so every
 *  reset re-opens it (the selection bar's discipline). */
function slabRow(inner: string, W: number, paint: { bg: string; edge: string }, mark = " "): string {
	const p = palette();
	const room = cardInner(W);
	const fitted = visibleWidth(inner) > room ? cutLine(inner, room) : inner;
	const body = fitted.replaceAll(p.reset, `${p.reset}${paint.bg}`);
	const pad = Math.max(0, room - visibleWidth(fitted));
	return `${paint.edge} ${paint.bg}${mark.replaceAll(p.reset, `${p.reset}${paint.bg}`)}${body}${paint.bg}${" ".repeat(pad)}${p.washEnd}`;
}

/** A card's pad: a whole row of its ground (§1.5), its edge cell too. */
function padRow(paint: { bg: string; edge: string }, W: number): string {
	const p = palette();
	return `${paint.edge} ${paint.bg}${" ".repeat(Math.max(0, W - 1))}${p.washEnd}`;
}

/** The widest form that fits the row, or the last one — the head row's
 *  own discipline (TUI2-R1.5 ⑤, pin 4) applied to the slab's two
 *  metadata rows: the parts give way in a PINNED ORDER, and the part
 *  that carries the semantics is the one reserved. */
function pickTier(tiers: readonly string[], room: number): string {
	return firstFit(tiers, room) ?? tiers[tiers.length - 1]!;
}

/** The widest form that fits the row, or null when none does. */
function firstFit(tiers: readonly string[], room: number): string | null {
	for (const t of tiers) if (visibleWidth(t) <= room) return t;
	return null;
}

/** A metadata row inside a card's body (a cut note, the tool's own cap):
 *  cut, never folded — a metadata row that wraps costs the block a row it
 *  did not budget. */
function noteRow(text: string, W: number, tone: "dim" | "body"): string[] {
	const p = palette();
	const open = tone === "body" ? p.washDim : p.dim;
	const close = tone === "body" ? p.washDimEnd : p.reset;
	return [cutLine(`${open}${noteIndent()}${text}${close}`, bodyRowRoom(W))];
}

/** `text` elided in its MIDDLE to `room` cells — a path keeps its head
 *  and its file name, which is how a reader recognises it (§7.5). */
function elideMiddle(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	if (room <= 1) return "\u2026".slice(0, Math.max(0, room));
	const right = Math.floor((room - 1) / 2);
	const left = room - 1 - right;
	const chars = Array.from(text);
	let tail = "";
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (displayWidth(chars[i]! + tail) > right) break;
		tail = chars[i]! + tail;
	}
	return `${widthCut(text, left)}\u2026${tail}`;
}

/** §7.5 — only the outcome WORD takes colour: the first segment of the
 *  outcome — `exit 0` in the success colour, a failure's word in the
 *  failure colour, `needs you` in gold (the card round: it stands with
 *  its `❯` now) — and the rest is `dim`. */
function outcomeStyled(text: string, error: boolean): string {
	const p = palette();
	if (text === "") return "";
	const at = text.indexOf(" \u00b7 ");
	const first = at < 0 ? text : text.slice(0, at);
	const rest = at < 0 ? "" : text.slice(at);
	const tone = error ? p.red : /^exit 0$/.test(first) ? p.green : first === "needs you" ? p.gold : "";
	return tone === "" ? `${p.dim}${text}${p.reset}` : `${tone}${first}${p.reset}${rest === "" ? "" : `${p.dim}${rest}${p.reset}`}`;
}

/**
 * §7.4 / §7.5 — a card's head row, without the card's edge cell: the verb
 * (upper case, `dim`), the target, and the outcome right-aligned in
 * `room` cells, `mark` (one styled cell, or "") standing in front of the
 * outcome's words. It gives way in a pinned order: the outcome's tiers
 * first (the attribution, then the count), then the target elides in its
 * middle; the outcome word is never cut. The row never folds; a command
 * folds in `headRows`.
 */
function headCore(verb: string, target: string, tiers: readonly string[], room: number, error: boolean, mark = ""): string {
	const p = palette();
	// the verb and ONE space, then the target (owner, 2026-09-29: the verb
	// column padded to seven left the target stranded between the verb and
	// the body under it — 0.44's `shell pwd && ls -la` reads as one line)
	const lead = `${p.dim}${verb}${p.reset} `;
	const avail = Math.max(1, room - (verb.length + 1));
	// the card round (owner, 2026-10-05): the running `●` and the waiting
	// `❯` stand where the settled outcome will, so the state is read in one
	// place and nothing sits against the verb
	const marked = (out: string): string => `${mark === "" ? "" : `${mark} `}${outcomeStyled(out, error)}`;
	const mw = mark === "" ? 0 : 2;
	const compose = (tg: string, out: string): string => `${lead}${tg}${" ".repeat(Math.max(2, avail - visibleWidth(tg) - visibleWidth(out) - mw))}${marked(out)}`;
	for (const t of tiers) if (visibleWidth(target) + 2 + visibleWidth(t) + mw <= avail) return compose(target, t);
	const last = tiers[tiers.length - 1] ?? "";
	const tRoom = avail - 2 - visibleWidth(last) - mw;
	if (tRoom >= 4) return compose(elideMiddle(target, tRoom), last);
	// A NARROW row: the target gives way entirely, then the verb's padding
	// and the verb, then everything but the outcome — and the outcome's
	// last word, how long it took, is the one thing kept to the end (pin 4:
	// what happened and how long it took is never cut open).
	const bareLead = `${p.dim}${verb}${p.reset} `;
	// the outcome's segments give way from the FRONT — the count, then
	// the outcome word (and the mark with it) — so how long it took, and
	// the key where there is one, are the last to go
	const segs = last.split(" \u00b7 ");
	const suffixes = segs.map((_, k) => segs.slice(k).join(" \u00b7 "));
	for (const row of [`${lead}${marked(last)}`, `${bareLead}${marked(last)}`, ...suffixes.map((x, k) => (k === 0 ? marked(x) : `${p.dim}${x}${p.reset}`))]) {
		if (visibleWidth(row) <= room) return row;
	}
	return cutLine(`${p.dim}${suffixes[suffixes.length - 1]}${p.reset}`, room);
}

/** The card round — the cells the head's first row keeps for the outcome
 *  when a command folds, whatever the outcome says now: `● running · 59m
 *  59s` and `exit 127 · 59m 59s` both fit. The fold is measured against
 *  this, never against the words of the moment, so a card neither
 *  re-folds while it runs nor changes height when it settles (DC-46: a
 *  live card never shrinks). */
const OUTCOME_ROOM = 20;
/** The least room a command's first row keeps; narrower, the head is one
 *  row and the command elides (the narrow ladder, `headCore`). */
const FOLD_MIN = 12;
/** A collapsed card's command shows at most this many rows. */
const HEAD_ROWS = 3;

/**
 * The card round (owner, 2026-10-05) — the head's rows. A shell command
 * is code the person approves and audits, so it is never cut in its
 * middle: when it does not fit beside the outcome it folds at its spaces,
 * each further row hanging under its own first character, for at most
 * `max` rows — past that the last row ends in `…` and ctrl+o shows the
 * rest. Every other target (a path keeps its head and its file name) is
 * one row, `headCore`'s. DECLARED REVERSAL of §7.5's "the row never
 * folds" for a command.
 */
function headRows(verb: string, target: string, tiers: readonly string[], room: number, error: boolean, mark: string, max: number): string[] {
	const single = [headCore(verb, target, tiers, room, error, mark)];
	if (max <= 1) return single;
	const lead = verb.length + 1;
	const avail = room - lead;
	const last = tiers[tiers.length - 1] ?? "";
	const first = avail - 2 - Math.max(OUTCOME_ROOM, visibleWidth(last) + (mark === "" ? 0 : 2));
	if (first < FOLD_MIN || visibleWidth(target) <= first) return single;
	const head = widthCut(target, first);
	const space = head.lastIndexOf(" ");
	const cut = space > 0 ? space + 1 : Math.max(1, head.length);
	const rest = target.slice(cut).trimStart();
	const rows = [target.slice(0, cut).trimEnd(), ...(rest === "" ? [] : foldAtSpaces(rest, avail))];
	const shown = rows.length <= max ? rows : [...rows.slice(0, max - 1), `${widthCut(rows.slice(max - 1).join(" "), avail - 1)}\u2026`];
	return [headCore(verb, shown[0]!, tiers, room, error, mark), ...shown.slice(1).map((r) => `${" ".repeat(lead)}${r}`)];
}

/** DC-43 — the head row ALONE, its mark in the mark column: a running
 *  call's form when the room left is too small for a card. `mark` is two
 *  cells (the glyph and a space, or two spaces). */
function cardHeadRow(mark: string, verb: string, target: string, tiers: readonly string[], W: number, _painted: boolean, error: boolean): string {
	return cutLine(`${mark}${headCore(verb, target, tiers, Math.max(1, W - EDGE.length), error)}`, W);
}

/** The card's foot: the key, right-aligned. */
function footRow(key: string, room: number): string {
	const p = palette();
	return `${" ".repeat(Math.max(0, room - visibleWidth(key)))}${p.dim}${key}${p.reset}`;
}

/**
 * Graphite §7.4 — assemble a card: pad · head · body · foot · pad on the
 * state's ground, full width, its edge cell in column 0, column 1 blank;
 * or, off the surface, the same content without it — the mark in the
 * mark column, the head at the content edge, the body under it, the foot
 * dim. `mark` is two cells: the glyph and a space, or two spaces. Inside
 * a card the glyph stands in front of the outcome's words (the card
 * round: in column 1 it sat against the verb). `fold` is how many rows
 * the head's command may take (0: the target never folds).
 */
function card(state: CardState, mark: string, verb: string, target: string, tiers: readonly string[], body: readonly string[], foot: string | null, W: number, error: boolean, fold = 0): string[] {
	if (!slabPaints()) {
		const [first, ...more] = headRows(verb, target, tiers, Math.max(1, W - EDGE.length), error, "", fold);
		const out = [cutLine(`${mark}${first}`, W), ...more.map((r) => cutLine(`${EDGE}${r}`, W)), ...body];
		if (foot !== null) out.push(cutLine(footRow(foot, W), W));
		return out;
	}
	const paint = cardPaint(state);
	const inner = cardInner(W);
	const glyph = mark.replace(/ $/, "");
	const head = headRows(verb, target, tiers, inner - CARD_RIGHT, error, glyph.trim() === "" ? "" : glyph, fold);
	const rows = [padRow(paint, W), ...head.map((r) => slabRow(r, W, paint)), ...body.map((r) => slabRow(r, W, paint))];
	if (foot !== null) rows.push(slabRow(footRow(foot, inner - CARD_RIGHT), W, paint));
	rows.push(padRow(paint, W));
	return rows;
}

/*
 * RETIRED (DC-50 / R14, 2026-09-05) — `expandedCard`.
 *
 * It drew the APPENDED block the old ctrl+o produced: a card printed far
 * below the call it belonged to, which is why its head row had to carry
 * `expanded · N turns back` and why its body carried section headers
 * around the raw input and output. All of that was addressing — a way
 * for a copy to say which original it was a copy of.
 *
 * DC-50 removes the copy. An expanded card is the ordinary `toolCard`
 * with `expanded` set, rendered where the call stands, so nothing needs
 * to say where it came from. Its shape is gated in
 * `r13-rhythm-surface.test.ts`.
 */

/** 0.24.2 ② — the live region's `thinking…` placeholder: dim italic at
 *  the content edge, no glyph, the SAME shape a thinking paragraph takes so that
 *  whatever arrives replaces it in place. Never committed — see the
 *  compositor's #project for why that is what makes it allowed. */
export function thinkingRow(): string {
	const p = palette();
	return `${THINK_COL}${p.dim}${p.italic}thinking…${p.italicEnd}${p.reset}`;
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
	return [...rows.slice(0, i), `${first.slice(0, at)}${" ".repeat(BODY_ROW_FLAT.length - 2)}\u2514 ${first.slice(at + BODY_ROW_FLAT.length)}`, ...rows.slice(i + 1)];
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
	cut: boolean;
}
const blockMemo = new WeakMap<object, BlockMemo>();

/** The block's body rows below the header (memoized, W9), and whether
 *  the preview CUT anything — which is what puts the key on a card's
 *  foot (§7.4). */
function toolBlockParts(c: Extract<BodyCell, { kind: "tool" }>, W: number, ctx: FrameCtx): { rows: string[]; cut: boolean } {
	const memo = blockMemo.get(c);
	// the SURFACE is part of the key: the same cell renders different rows
	// painted and unpainted, and a ground resolved after the first frame
	// would otherwise be served the pre-ground shape forever.
	const liveRows = ctx.liveWindow ?? CAP_PREVIEW;
	const state = `${c.state}:${c.isError}:${c.name}:${c.expanded ? "x" : ""}:${slabPaints() ? "slab" : "flat"}:${liveRows}`;
	// R2a: an edit or a write shows what it changed while it runs and once
	// it has — never after a refusal (nothing changed) or an error
	const edit = !c.isError && c.reason === null && (c.state === "running" || c.state === "done") ? editDiffOf(c) : null;
	const content: unknown = c.state === "approval" ? (c.diff ?? null) : edit !== null ? edit : c.resultText;
	if (memo !== undefined && memo.width === W && memo.state === state && memo.content === content) return memo;
	const p = palette();
	const tone = slabPaints() ? "body" : "dim";
	let cut = false;
	const keyed = c.state === "done" && !c.expanded;
	const capped = (all: string[], dir: "head" | "tail", starts: readonly boolean[] = []): string[] => {
		if (all.length <= CAP_PREVIEW) return all;
		cut = true;
		// R9 P2 / D4: FIVE output rows, and the note is a row of its own.
		// A shell's conclusion is at the bottom, so its note goes ABOVE the
		// tail; everything else answers at the top, so its note closes it.
		// The card round: a settled, collapsed card's key rides the note.
		if (dir === "tail") {
			const w = tailWindow(all, CAP_PREVIEW, starts);
			return [...cutNote(w.lines, "earlier", W, tone, keyed, w.partial), ...w.rows];
		}
		const h = headCut(all, CAP_PREVIEW, starts);
		return [...h.rows, ...cutNote(h.lines, "more", W, tone, keyed, h.partial)];
	};
	const shellTail = (out: { rows: string[]; starts: boolean[] }, dir: "head" | "tail"): string[] => capped(out.rows, dir, out.starts);
	// a diff inside a card: its own rows, the head of them until the key
	const diffCapped = (lines: readonly DiffLine[] | null, cap: number): string[] => {
		const all = lines === null ? [] : diffRows(lines, W);
		if (c.expanded || all.length <= cap) return all;
		cut = true;
		return [...all.slice(0, cap), ...cutNote(all.length - cap, "more", W, tone, keyed)];
	};
	const rows =
		edit !== null
			? diffCapped(edit.lines, edit.cap)
			: c.state === "approval" && slabPaints()
				? diffCapped(c.diff, CAP_DIFF)
				: c.expanded
			? // W15: the WHOLE body, no cap, no cut note (nothing is cut).
				c.state === "approval"
				? diffBody(c.diff, W, true)
				: c.name === "delegate"
					? c.state === "running"
						? delegateRunning(c, W)
						: delegateSettled(c, W)
					: blockRows(c.resultText, W, tone)
			: c.state === "done"
				? c.isError
					? capped(errorRows(c, W, tone), "head")
					: c.name === "delegate"
						? delegateSettled(c, W)
						: // R13 — EVERY settled call previews: a shell its tail,
							// everything else its head. read_file is the single
							// exception (E1): its result is the file, and the key
							// opens the whole thing.
							noPreview(c)
							? []
							: shellTail(blockLines(c.resultText, W, tone), c.name === "shell" ? "tail" : "head")
				: c.state === "running"
					? c.name === "delegate"
						? delegateRunning(c, W)
						: // R13 E1 — the call with no preview settled has none
							// while it runs either.
							noPreview({ ...c, state: "done" })
							? []
							: liveWindow(c, W, liveCap(c, liveRows), tone)
					: c.state === "approval"
						? diffBody(c.diff, W)
						: [];
	// E1 governs the PREVIEW, not kiso's sentence about the result: a read
	// the TOOL capped takes one body row (`offset=201 for the rest`).
	const note = c.expanded || edit !== null ? null : toolCutNote(c.name, c.resultText);
	if (note !== null) rows.push(...noteRow(note, W, "dim"));
	// R8a: `└` opens a block that has no surface; inside a card the surface
	// IS the container.
	const opened = slabPaints() ? rows : openBlock(rows);
	const parts = { width: W, state, content, rows: opened, cut };
	blockMemo.set(c, parts);
	return parts;
}

/** The tasks round — a background delegation's children, from what the
 *  call returned (`started 2 background children: t1 explorer (session …),
 *  t2 reviewer (session …). They read …`) and what it was asked (each
 *  task's role and words): the task id, the role, the task's first line.
 *  Null for anything else — a foreground delegation, a refusal. */
function backgroundChildren(c: { resultText: string; inputFull: string }): { id: string; role: string; task: string }[] | null {
	const m = /^started \d+ background (?:child|children): (.*?)\. They read the workspace/s.exec(c.resultText);
	if (m === null) return null;
	let asked: { tasks?: readonly { role?: unknown; task?: unknown }[] } = {};
	try {
		asked = JSON.parse(c.inputFull) as typeof asked;
	} catch {
		// the full input is always JSON (stringified at toolStart)
	}
	const pool = (asked.tasks ?? []).map((t) => ({ role: String(t.role ?? ""), task: oneRow(escapeTerminal(String(t.task ?? "").split("\n")[0] ?? "")), used: false }));
	const out: { id: string; role: string; task: string }[] = [];
	for (const s of m[1]!.matchAll(/(\S+) (\S+) \(session [^)]*\)/g)) {
		const at = pool.findIndex((t) => !t.used && t.role === s[2]);
		if (at >= 0) pool[at]!.used = true;
		out.push({ id: escapeTerminal(s[1]!), role: escapeTerminal(s[2]!), task: at >= 0 ? pool[at]!.task : "" });
	}
	return out.length === 0 ? null : out;
}

/** R13 E1 — the one settled call that previews NOTHING. A read's result
 *  IS the file; five lines of it tell a reader less than the head row
 *  already does, and the key opens the whole thing. (The reference
 *  implementation makes the same call, for the same reason.) Everything
 *  else previews: a shell its tail, the rest their head. */
function noPreview(c: Extract<BodyCell, { kind: "tool" }>): boolean {
	return c.state === "done" && !c.expanded && !c.isError && c.reason === null && c.name === "read_file";
}

/** How far a wrapped output line's continuation rows stand in. */
const HANG = 2;

/** Fold result text into body rows (the block's own indent): escape,
 *  split, fold each line in the body's text width; trailing empty rows
 *  (the result's final newline) drop. Inside a card the output is
 *  `ink2` (§2: tool output); off the surface it is dim. */
function blockRows(text: string, W: number, tone: "dim" | "body" = "dim"): string[] {
	return blockLines(text, W, tone).rows;
}

/** `blockRows`, with which rows begin a line of output (a wrapped line's
 *  continuation rows do not) — what a tail window needs to start on a
 *  whole line. */
function blockLines(text: string, W: number, tone: "dim" | "body" = "dim"): { rows: string[]; starts: boolean[] } {
	const p = palette();
	const textW = bodyTextWidth(W);
	const rows: string[] = [];
	const starts: boolean[] = [];
	const open = tone === "dim" ? p.dim : p.ink2;
	const close = tone === "dim" ? p.reset : p.ink2 === "" ? "" : p.fgEnd;
	// 0.40.0: the output's own styling is dropped whole before the escape
	// The card round (owner, 2026-10-05): a line too long for the row
	// continues HANG cells in, so one line of output reads as one.
	const hang = textW > HANG * 4 ? HANG : 0;
	for (const raw of escapeTerminal(stripAnsi(text)).split("\n")) {
		const [first = "", ...more] = foldLine(raw, textW);
		rows.push(`${bodyRow()}${open}${first}${close}`);
		starts.push(true);
		if (more.length === 0) continue;
		for (const row of foldLine(more.join(""), textW - hang)) {
			rows.push(`${bodyRow()}${" ".repeat(hang)}${open}${row}${close}`);
			starts.push(false);
		}
	}
	while (rows.length > 0 && visibleWidth(rows[rows.length - 1]!) === visibleWidth(bodyRow())) {
		rows.pop();
		starts.pop();
	}
	return { rows, starts };
}

/** The preview's cut note — how much was cut and in which direction.
 *  With `key` (a settled card, collapsed) the key that shows the rest
 *  stands at the same row's right margin: what was cut at the left, how
 *  to see it at the right (the card round, owner 2026-10-05). DECLARED
 *  REVERSAL of §7.4's foot for a collapsed card — the note and the key
 *  were two rows for one fact. The key gives way after the count's word,
 *  the count never. */
function cutNote(cut: number, word: "more" | "earlier", W: number, tone: "dim" | "body", key = false, partial = false): string[] {
	// 0.47.1 (finding 0470-F1, owner 2026-10-07): `cut` counts output
	// LINES, the unit the note names (it counted rows: a wrapped line hidden
	// whole was two or more "lines"). `partial`: the line at the cut is
	// shown only in part — its start above a tail, its rest below a head —
	// and the note says so rather than counting it.
	const part = word === "earlier" ? "start" : "rest";
	const lines = `${cut} ${word} line${cut === 1 ? "" : "s"}`;
	const n = !partial ? lines : cut === 0 ? `the ${part} of this line` : `${lines} and the ${part} of this one`;
	const short = !partial ? `\u2026 ${cut}` : cut === 0 ? "\u2026" : `\u2026 ${cut}+`;
	// the part's clause gives way before the count's word does
	const tiers = partial && cut > 0 ? [`\u2026 ${n}`, `\u2026 ${lines}`, short] : [`\u2026 ${n}`, short];
	const room = bodyTextWidth(W);
	if (key) {
		for (const [left, k] of [...tiers.map((l) => [l, EXPAND_ROW] as const), [short, "ctrl+o"] as const]) {
			const gap = room - visibleWidth(left) - visibleWidth(k);
			if (gap >= 2) return noteRow(`${left}${" ".repeat(gap)}${k}`, W, tone);
		}
	}
	return noteRow(pickTier(tiers, room), W, tone);
}

/** What a cut window hides, for its note (0.47.1, finding 0470-F1): the
 *  output lines among the hidden rows, and whether the line at the cut is
 *  shown in part. `starts` marks each row that begins a line; where it is
 *  unknown (empty) every row counts as a line, as before. A tail that opens
 *  on a continuation row shows the end of a line whose start is hidden —
 *  that line is not counted, it is the note's `partial`. */
function tailCount(shown: string[], hidden: readonly number[], starts: readonly boolean[], first: number): { rows: string[]; lines: number; partial: boolean } {
	const partial = starts[first] === false;
	return { rows: shown, lines: hidden.filter((i) => starts[i] !== false).length - (partial ? 1 : 0), partial };
}
function headCut(rows: readonly string[], cap: number, starts: readonly boolean[]): { rows: string[]; lines: number; partial: boolean } {
	let lines = 0;
	for (let i = cap; i < rows.length; i += 1) if (starts[i] !== false) lines += 1;
	return { rows: rows.slice(0, cap), lines, partial: starts[cap] === false };
}

/** The card round — a shell's tail never opens on a blank row or in the
 *  middle of a wrapped line, and keeps its height (DC-46: a live window
 *  never shrinks, and the settle moves nothing). When the window's top row
 *  would be either, the window starts at an earlier line's first row and
 *  blank rows inside it give way to make the room, the top-most first: a
 *  blank row carries no fact, and the conclusion is at the bottom. It
 *  looks back at most `TAIL_REACH` rows (a bounded walk, never a scan of
 *  the whole output); when no line start can be reached, the window is
 *  the plain tail. The rows it hides are counted in the note. `starts`
 *  marks each row that begins a line of output. */
const TAIL_REACH = 12;

/** The runtime's reason for a refusal the person gave no words for
 *  (session.approve(id, false)) — a card says `denied by you` alone then. */
const DEFAULT_REFUSAL = "denied by user";
function tailWindow(rows: readonly string[], cap: number, starts: readonly boolean[]): { rows: string[]; lines: number; partial: boolean } {
	const n = rows.length;
	if (n <= cap) return { rows: [...rows], lines: 0, partial: false };
	const blank = (i: number): boolean => visibleWidth(rows[i]!) <= visibleWidth(bodyRow());
	let blanks = 0;
	for (let i = n - cap; i < n; i += 1) if (blank(i)) blanks += 1;
	// s stops at 1: the window reaches only while a row above it stays
	// cut, so the note never counts nothing but the blanks it skipped
	for (let s = n - cap; s >= Math.max(1, n - cap - TAIL_REACH); s -= 1) {
		if (s < n - cap && blank(s)) blanks += 1;
		const extra = n - s - cap;
		if (blank(s) || starts[s] === false || blanks < extra) continue;
		const out: string[] = [];
		const hidden: number[] = Array.from({ length: s }, (_, i) => i);
		let dropped = 0;
		for (let i = s; i < n; i += 1) {
			if (dropped < extra && blank(i)) {
				dropped += 1;
				hidden.push(i);
			} else out.push(rows[i]!);
		}
		return tailCount(out, hidden, starts, s);
	}
	return tailCount(rows.slice(n - cap), Array.from({ length: n - cap }, (_, i) => i), starts, n - cap);
}

/** The error text, uncapped: the answer is at the start, and the whole
 *  of it is the body — the head row carries only the outcome word
 *  (W4, W19: never hide information). */
function errorRows(c: { resultText: string }, W: number, tone: "dim" | "body"): string[] {
	return blockRows(c.resultText, W, tone);
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
	const { rows: all, starts } = blockLines(c.resultText, W, tone);
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
	if (c.name === "shell") {
		const w = tailWindow(rows, cap, starts.slice(from));
		return [...cutNote(w.lines, "earlier", W, tone, false, w.partial), ...w.rows];
	}
	const h = headCut(rows, cap, starts.slice(from));
	return [...h.rows, ...cutNote(h.lines, "more", W, tone, false, h.partial)];
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


/* DECLARED REVERSAL (R13, owner-ruled 2026-09-03): R4's standing act
   slot stood here — `ACT_SLOT_ROWS`, `slotTail`, `slotPad`,
   `moreRunningRow` — a fixed four-row region that held the stretch's
   running call so the live region's height would not follow the call
   count. Every call is its own card now, allocated at its own height
   (E2, DC-46), so there is no slot for a call to occupy. */

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
	return [bodyLineRow(p, text, W)];
}

function delegateSettled(c: { resultText: string }, W: number): string[] {
	const p = palette();
	const m = /^summary: (.+)$/m.exec(c.resultText);
	if (m === null) return [];
	return [bodyLineRow(p, `${m[1]} · /last for the report`, W)];
}

/** ONE row at the left gutter, truncated to fit the width — never a
 *  fold (a fold would wrap into TWO rows and break the one-line height
 *  contract). */
function oneLineRow(p: Palette, text: string, W: number): string {
	const esc = escapeTerminal(text);
	if (visibleWidth(`${p.dim}\u2514 ${esc}${p.reset}`) <= W) return `${p.dim}\u2514 ${esc}${p.reset}`;
	const w = Math.max(1, W - 2);
	return `${p.dim}\u2514 ${esc.slice(0, w - 1)}\u2026${p.reset}`;
}

/** Graphite §7.4 — a card body's ONE row (the delegate's): at the body
 *  column like every body row, dim, cut to its room. */
function bodyLineRow(p: Palette, text: string, W: number): string {
	const esc = escapeTerminal(text);
	const room = bodyTextWidth(W);
	return `${bodyRow()}${p.dim}${visibleWidth(esc) <= room ? esc : `${widthCut(esc, Math.max(1, room - 1))}\u2026`}${p.reset}`;
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
					: d.kind === "note"
						? // 0.40.0: a note starts in the MARKER column, where no line
							// of the file ever does — it reads as kiso's sentence about
							// the diff, not as an unchanged line inside it
							`${p.dim}${escapeTerminal(d.text)}${p.reset}`
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

/** Graphite §6 (R2a) — the rows a card shows for a diff: a `-` / `+` line
 *  on its tint (a background, §1.5) from the content edge to the card's
 *  inner margin, the marker in its colour, the changed words on a deeper
 *  tint; a kept line `dim`; kiso's own notes (`···` between hunks, a miss)
 *  `dim` in the marker column. A long line folds under its text with the
 *  tint on every row. Off a painted card the lines keep the flat form:
 *  marker and text in the line's colour, the changed words underlined. */
function diffRows(lines: readonly DiffLine[], W: number): string[] {
	const p = palette();
	const painted = slabPaints();
	const room = bodyRowRoom(W) - bodyRow().length;
	const textW = Math.max(1, bodyTextWidth(W) - 2);
	const out: string[] = [];
	for (const d of lines) {
		const text = escapeTerminal(d.text);
		if (d.kind === "note") {
			out.push(...noteRow(text, W, "dim"));
			continue;
		}
		if (d.kind === " ") {
			for (const r of foldLine(text, textW)) out.push(`${bodyRow()}${p.dim}  ${r}${p.reset}`);
			continue;
		}
		const del = d.kind === "-";
		const rows = foldLine(text, textW);
		// the marks index the line's own text: they hold only where the
		// escape left it as it was and the fold cut it without loss
		const marks = text === d.text && rows.join("") === text ? (d.marks ?? []) : [];
		const base = del ? p.del : p.add;
		const [on, off] = painted ? [del ? p.delWord : p.addWord, base] : [p.underline, p.underlineEnd];
		let at = 0;
		for (const [i, r] of rows.entries()) {
			let body = "";
			let k = 0;
			for (const [s0, e0] of marks) {
				const s1 = Math.max(s0, at) - at;
				const e1 = Math.min(e0, at + r.length) - at;
				if (e1 <= s1) continue;
				body += `${r.slice(k, s1)}${on}${r.slice(s1, e1)}${off}`;
				k = e1;
			}
			body += r.slice(k);
			at += r.length;
			const lead = i === 0 ? d.kind : " ";
			if (painted) {
				const pad = " ".repeat(Math.max(0, room - 2 - visibleWidth(r)));
				out.push(`${bodyRow()}${base}${del ? p.fail : p.ok}${lead}${p.fgEnd} ${body}${pad}`);
			} else {
				out.push(`${bodyRow()}${del ? p.red : p.green}${lead} ${body}${p.reset}`);
			}
		}
	}
	return out;
}

/** How many of a write's lines its card shows before the key. */
const WRITE_HEAD = 5;

/** R2a — what an edit or a write CHANGED, from the call's own input: the
 *  lines to draw, the head row's words for it, and how many rows show
 *  before the key. Null for any other call, or an input with nothing to
 *  draw. Memoized per cell: a call's input never changes. */
interface EditDiff {
	readonly lines: readonly DiffLine[];
	readonly meta: string;
	readonly cap: number;
}
const editDiffMemo = new WeakMap<object, EditDiff | null>();
function editDiffOf(c: { name: string; inputFull: string }): EditDiff | null {
	if (c.name !== "edit_file" && c.name !== "write_file") return null;
	const known = editDiffMemo.get(c);
	if (known !== undefined) return known;
	let input: Record<string, unknown> | null = null;
	try {
		const v: unknown = JSON.parse(c.inputFull);
		input = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		input = null;
	}
	let out: EditDiff | null = null;
	if (input !== null && c.name === "edit_file") {
		const hunks = hunksOf(input);
		const d = hunks === null ? null : hunksDiff(hunks);
		if (hunks !== null && d !== null && d.lines.length > 0) {
			const counts = `+${d.added} -${d.removed}`;
			out = { lines: d.lines, meta: hunks.length > 1 ? `${counts} \u00b7 ${hunks.length} hunks` : counts, cap: CAP_DIFF };
		}
	} else if (input !== null && typeof input.content === "string") {
		const content = input.content.replace(/\n$/, "");
		const all = content === "" ? [] : content.split("\n");
		// a write that cites "absent" creates the file; any other rewrites
		// one whose old text is not in the log, so its lines are shown as
		// they now read, not as additions
		const created = input.expectedRevision === "absent";
		const n = `${all.length} line${all.length === 1 ? "" : "s"}`;
		out = { lines: all.map((text) => ({ kind: created ? ("+" as const) : (" " as const), text })), meta: created ? `new file \u00b7 ${n}` : `rewrote \u00b7 ${n}`, cap: WRITE_HEAD };
	}
	editDiffMemo.set(c, out);
	return out;
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
		// Graphite §1.8: at the content edge, 92 columns at most (§7.15).
		const rows = renderBlock(this.cell.block, proseRoom(W)).map((r) => (r === "" ? r : `${PROSE_COL}${r}`));
		// Graphite §5 (R2b): a `##` heading carries `§` in the mark column
		// (`rail`), outside the block, the way the prototype hangs it
		const p = palette();
		if (headingLevel(this.cell.block) === 2 && p.rail !== "") {
			const at = rows.findIndex((r) => r !== "");
			if (at >= 0) rows[at] = `${p.rail}\u00a7${p.fgEnd} ${rows[at]!.slice(PROSE_COL.length)}`;
		}
		return rows;
	}
}

/** Graphite §7.12 — the label column of a meta row: the longest label
 *  (`INTERRUPTED`) and one space, so the sentences line up with a card's
 *  body (column 16). */
const META_LABEL = 12;
/** The labels that name an outcome, and so take its colour (§1.2). */
const META_FAIL = new Set(["FAILED", "UNCERTAIN"]);

/**
 * Graphite §7.12 — kiso's own sentences are META ROWS: a bold label at
 * the content edge and the sentence beside it, folded by word under
 * itself (VD-10: a notice is a sentence addressed to a human). No card
 * and no ground — they are not the machine's work. A notice with no
 * kind of its own (a command's confirmation) has no label and stays
 * whole at the content edge.
 */
class ErrorLine implements Component {
	constructor(private readonly cell: { text: string; label?: string; sentence?: string; mark?: NoticeMark; stacked?: true; oneRow?: true; also?: readonly NoticeRow[] }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const c = this.cell;
		// a sentence with no kind of its own stays whole at the content edge
		if (c.label === undefined) return foldWords(escapeTerminal(c.sentence ?? c.text), Math.max(1, W - EDGE.length)).map((r) => `${EDGE}${r}`);
		const sentence = escapeTerminal(c.sentence ?? "");
		const room = Math.max(1, W - EDGE.length - META_LABEL);
		const tone = META_FAIL.has(c.label) ? p.red : p.dim;
		const head = `${EDGE}${p.bold}${tone}${c.label.padEnd(META_LABEL - 1)}${p.reset} `;
		// a label wider than the row's room is cut like any row (invariant ①)
		if (sentence === "") return [cutLine(head.trimEnd(), W)];
		const folded = foldWords(sentence, room);
		// Graphite R3e (the MODE row): one word of the sentence carries the
		// weight — the mode switched to, bold, bypass in the failure colour
		const m = c.mark;
		const lit = (r: string): string => {
			if (m === undefined || !r.includes(m.text)) return `${p.dim}${r}${p.reset}`;
			const tone = m.tone === "fail" ? p.red : m.tone === "blue" ? p.blue : m.tone === "ok" ? p.green : m.tone === "gold" ? p.gold : "";
			// the word after the arrow (the mode switched TO), not an earlier one
			const arrow = r.indexOf(`\u2192 ${m.text}`);
			const at = arrow >= 0 ? arrow + 2 : r.indexOf(m.text);
			return `${p.dim}${r.slice(0, at)}${p.reset}${p.bold}${tone}${m.text}${p.reset}${p.dim}${r.slice(at + m.text.length)}${p.reset}`;
		};
		// Graphite R3e (owner, 2026-09-29): the MODE switch is the person's own
		// choice, so its label is GOLD — the colour of what the person says —
		// and its short `from → to` follows two spaces after it on the same
		// row, not the meta rows' twelve-column label column
		if (c.stacked === true) {
			const label = `${EDGE}${p.bold}${p.gold}${c.label}${p.reset}  `;
			const lead = visibleWidth(label);
			return foldWords(sentence, Math.max(1, W - lead)).map((r, i) => cutLine(i === 0 ? `${label}${lit(r)}` : `${" ".repeat(lead)}${lit(r)}`, W));
		}
		// the tasks round: a row that names a thing (a task, a project) is ONE
		// row — what ran is cut with an ellipsis, never folded under itself
		if (c.oneRow === true) {
			const rows = [cutLine(`${head}${lit(sentence)}`, W)];
			for (const r of c.also ?? []) rows.push(...new ErrorLine({ text: c.text, label: r.label, sentence: r.sentence, ...(r.mark !== undefined ? { mark: r.mark } : {}), oneRow: true }).render(W, _ctx));
			return rows;
		}
		return folded.map((r, i) => (i === 0 ? cutLine(`${head}${lit(r)}`, W) : `${EDGE}${" ".repeat(META_LABEL)}${p.dim}${r}${p.reset}`));
	}
}

/** The last sweep (owner, 2026-10-06) — `/think` and `/last` on the
 *  terminal. They printed at column 0 under `--- … ---` rules, a blank row
 *  between every part; now the row says what came back (`THINKING the last
 *  block · 3 lines`, `LAST CALL LIST (root) · 2 lines`) and each part
 *  follows in its own look: thinking as the thinking block draws it, a
 *  call's input and output under dim titles, in `ink2`, hung by two. One
 *  cell, so no blank row splits it. */
class RecallBlock implements Component {
	constructor(private readonly cell: { label: string; sentence: string; sections: readonly RecallSection[] }) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const rows = new ErrorLine({ text: "", label: this.cell.label, sentence: this.cell.sentence, oneRow: true }).render(W, ctx);
		for (const s of this.cell.sections) {
			if (s.title !== undefined) rows.push(cutLine(`${EDGE}${p.dim}${s.title}${p.reset}`, W));
			if (s.style === "thinking") {
				rows.push(...new ThinkingBlock({ text: s.text, done: true }).render(W, ctx));
				continue;
			}
			const room = Math.max(1, W - EDGE.length - HANG);
			const lines = escapeTerminal(stripAnsi(s.text)).replace(/\n+$/, "").split("\n").flatMap((l) => foldLine(l, room));
			for (const l of lines) rows.push(`${EDGE}${" ".repeat(HANG)}${p.ink2}${l}${p.fgEnd}`);
		}
		return rows;
	}
}

/**
 * Graphite §7.11 — THE SEAL: the turn's line — `✦` in gold hanging in
 * the mark column, the words `dim` at the content edge. Its forms come widest first (the cold
 * cache sheds its label before anything is cut, R3g); the widest that
 * fits is drawn, and the last is cut with `…` — one row at every width.
 */
class SealLine implements Component {
	constructor(private readonly cell: { tiers: readonly string[] }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const mark = p.goldMark === "" ? `${p.bold}\u2726${p.reset}` : `${p.goldMark}\u2726${p.fgEnd}`;
		// the mark HANGS in the mark column (§1.8), the words at the edge
		const room = Math.max(1, W - EDGE.length);
		const text = pickTier(this.cell.tiers, room);
		const fitted = visibleWidth(text) <= room ? text : `${widthCut(text, Math.max(1, room - 1))}\u2026`;
		return [cutLine(`${mark} ${p.dim}${fitted}${p.reset}`, W)];
	}
}

/** 4c — the folded history's ONE row. Dim, like every row that is about
 *  the transcript rather than in it; cut, never wrapped, so it is one row
 *  at every width. */
class FoldRow implements Component {
	constructor(private readonly cell: { label: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		return [cutLine(`${EDGE}${p.dim}${escapeTerminal(this.cell.label)}${p.reset}`, W)];
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

/** The LIVE elapsed label — every place a duration is shown while it is
 *  still running, and on the card that settles from it, so a card and the
 *  status row can never disagree.
 *
 *  It replaced the hand-written second counts, which is how the status
 *  row came to read "working 637s": ten minutes as a four-figure number,
 *  with no branch anywhere that said otherwise. Past an hour it keeps
 *  seconds, because a clock the user is watching tick should not stop
 *  ticking.
 *
 *  Negative is clamped: a clock skew is not a negative duration. */
export function elapsedLabel(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ${s % 60}s`;
}

/** The SETTLED call's duration — R13's grammar (`exit 0 · 90 lines ·
 *  0.4s`). A finished call knows its length to a tenth, which is
 *  information a running clock cannot have and a finished one should not
 *  throw away: under a minute the tenth stays.
 *
 *  Past a minute the tenth stops being the interesting digit and the
 *  live label takes over — a twelve-minute call settled as `734.2s`, the
 *  same unreadable four-figure count the status row had. NOTHING under a
 *  minute moves, which is every duration the suite pinned before this.
 *  The suffix is part of the label (the live form's already is), so no
 *  caller appends its own `s`. */
export function settledLabel(totalSeconds: number): string {
	const tenths = Math.max(0, Math.round(totalSeconds * 10) / 10);
	return tenths < 60 ? `${tenths.toFixed(1)}s` : elapsedLabel(tenths);
}

// ---- the chrome components (the status container, the footer) ----

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
export function idleHint(room: number, expand: "expand all" | "collapse all" | null = null): string {
	// The third rung is today's hint, kept so that NO width loses
	// something that used to fit: without it, a room of 24-30 columns
	// fell all the way to `/ commands` even though the old form fitted.
	// So the ladder is not a strict ranking of the three affordances —
	// it is the widest honest form at each room, and ctrl+r is on the
	// first two rungs rather than on all of them.
	//
	// D-S2-1 (owner-ruled 2026-09-06): the ctrl+o SWITCH is named on the
	// two widest rungs, beside ctrl+r, and only while a card on screen
	// has something behind the key — the caller passes null otherwise,
	// and the ladder is then exactly the one above. It replaced the
	// per-card bright token (TUI2-R2 ⑤): a global switch has no single
	// target to mark.
	const switchRungs = expand === null ? [] : [` / commands · ↑ history · ctrl+o ${expand} · ctrl+r transcript`, ` / commands · ctrl+o ${expand} · ctrl+r transcript`];
	for (const form of [...switchRungs, " / commands · ↑ history · ctrl+r transcript", " / commands · ctrl+r transcript", " / commands · ↑ history", " / commands"]) {
		if (visibleWidth(form) <= room) return form;
	}
	return "";
}

export function statusLine(status: string, tail: string, W: number, hint?: string, expand: "expand all" | "collapse all" | null = null): string {
	const p = palette();
	// Graphite §8.7 (R3b): a status that waits for the person (`❯ …`, a
	// panel's own words) says so first — `❯ needs you · run paused` — the
	// `❯` gold where there is colour, the words as they were after it. The
	// window title already says `needs you` (§8.10); now the screen does.
	const waiting = status.startsWith("\u276f ");
	const said = waiting ? `\u276f needs you \u00b7 ${status.slice(2)}` : status;
	const text = `${said}${tail === "" ? "" : ` · ${tail}`}`;
	// the gold goes on the `❯` only while the cut row still starts with it
	const lead = (s: string): string => (waiting && p.gold !== "" && s.startsWith("\u276f") ? `${p.gold}\u276f${p.fgEnd}${p.dim}${s.slice(1)}` : `${p.dim}${s}`);
	// W18: the hint is a parameter — the compacting row right-aligns its
	// "esc to cancel" (the same one-line-bounded shape as W12's delegate
	// row; the #16g rule still cuts the HINT first, then the status with
	// a "…" — never a fold).
	const statusW = visibleWidth(text);
	if (statusW > W) {
		return `${lead(widthCut(text, W - 1))}…${p.reset}`;
	}
	const hintText = hint ?? idleHint(Math.max(0, W - statusW), expand);
	const hintW = visibleWidth(hintText);
	if (hintW === 0 || statusW + hintW > W) return `${lead(text)}${p.reset}`;
	return `${lead(text)}${" ".repeat(Math.max(0, W - statusW - hintW))}${hintText}${p.reset}`;
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
	// Graphite §8.2 (R3a) — on a known ground the selected row is a card's
	// head in the colour that waits for the person: its `askEdge` cell in
	// column 0, the row on `washAsk` to the right edge, and a row's `→`
	// marker (the approval, question, pick and command lists carry one in
	// column 1) drawn as a gold `›`. DECLARED REVERSAL of the reverse-video
	// bar and its `→` there; `dim` stays (it meets the floor on washAsk).
	// Off a known ground the reverse-video bar below stays — one row, so no
	// seam.
	if (slabPaints()) {
		const marked = styled.replace(/^((?:\x1b\[[0-9;]*m)*)\u2192/, `$1${p.gold}\u203a${p.fgEnd}`);
		const inner = marked.replaceAll(p.reset, `${p.reset}${p.washAsk}`);
		return `${p.askEdge} ${p.washAsk}${inner}${" ".repeat(Math.max(0, W - 1 - visible))}${p.washEnd}`;
	}
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
	// Graphite §7.8: the one rule that carries colour — gold at its left
	// end, where the person's edge is, fading to the hairline.
	return fadeRule(W);
}

/** Graphite R3e — a read-only sheet over the input (`/status`): the band's
 *  named hairline, one fact per row — its label dim in a column, its value
 *  folded by word under itself — and the row that says how it closes.
 *  It closes like the keys sheet, but what is typed after it is typed. */
export function infoSheetRows(title: string, facts: readonly { readonly label: string; readonly value: string }[], W: number): string[] {
	const p = palette();
	const labelW = Math.max(0, ...facts.map((f) => f.label.length)) + 2;
	const room = Math.max(1, W - 2 - labelW);
	const rows = [bandHeader(title, W)];
	for (const f of facts) {
		const folded = foldWords(escapeTerminal(f.value), room);
		for (const [i, line] of folded.entries()) rows.push(`  ${i === 0 ? `${p.dim}${f.label.padEnd(labelW)}${p.reset}` : " ".repeat(labelW)}${line}`);
	}
	rows.push(`  ${p.dim}${SHEET_CLOSE}${p.reset}`);
	return rows.map((r) => cutLine(r, W));
}

/** R2 — the same rule below, in the hairline colour (§1.1). Named for its
 *  POSITION, not its shape, so the compositor's two call sites did not
 *  have to move. */
export function boxBottom(W: number): string {
	const p = palette();
	return `${p.line === "" ? p.dim : p.line}${"\u2500".repeat(Math.max(0, W))}${p.line === "" ? p.reset : p.fgEnd}`;
}

/** The terminal label + rhythm gap (the pipe path's v2c bytes — the
 *  exact render the passthrough needs). */
export function terminalPipe(label: string, statusLineText: string): string {
	return label + renderTerminalGap(statusLineText);
}

/** The pipe-path pieces the passthrough reuses (byte-identical). */
export { foldThinking, foldResult, renderToolSummary, TOOL_SUMMARY_MAX };

// ── Graphite §8.2 — what every list band shares ─────────────────────
// Moved from the @ picker (P3) so the pick panels, which draw in this
// package, read the same window, marks, key row and matcher.

/**
 * The subsequence embedding, TIGHTENED — the two-pass walk every good
 * fuzzy finder uses, and the reason `@ra` emboldens the "ra" of
 * "src/range.js" rather than the r of "src" and the a of "range".
 *
 * Pass 1 walks forward and stops at the EARLIEST index that completes
 * the query — this both answers "does it match at all" and fixes the
 * right-hand edge. Pass 2 walks backward from that edge, taking the
 * LATEST position for each query character in turn, which slides every
 * matched character as far right as it can go without crossing the
 * next one. The result is the most clustered embedding that ends where
 * the earliest match ends.
 *
 * Case-insensitive: both sides are lowercased by the caller once per
 * query rather than once per character.
 *
 * Returns the ascending match indices, or null when the query is not a
 * subsequence of the path at all.
 */
export function atEmbed(lowerPath: string, lowerQuery: string): number[] | null {
	if (lowerQuery === "") return [];
	// pass 1 — forward, to the earliest completing index
	let qi = 0;
	let end = -1;
	for (let pi = 0; pi < lowerPath.length; pi += 1) {
		if (lowerPath[pi] === lowerQuery[qi]) {
			qi += 1;
			if (qi === lowerQuery.length) {
				end = pi;
				break;
			}
		}
	}
	if (end === -1) return null; // not a subsequence — no embedding exists
	// pass 2 — backward from that edge, sliding each character right
	const hit = new Array<number>(lowerQuery.length);
	let pi = end;
	for (let j = lowerQuery.length - 1; j >= 0; j -= 1) {
		while (lowerPath[pi] !== lowerQuery[j]) pi -= 1;
		hit[j] = pi;
		pi -= 1;
	}
	return hit;
}

/**
 * Graphite P2 (owner, 2026-10-03) — the band's window, shared by the file
 * picker, the command list and the session picker: EIGHT rows on a
 * terminal 30 rows or taller, five below.
 */
export function bandVisible(height: number): number {
	return height >= 30 ? 8 : 5;
}

/** The window over a list, with a scroll-off of one: while more lies past
 *  an edge the cursor stays a row inside it, so the edge row that carries
 *  a more-mark is never the selected one. Stateless, like bandWindow. */
export function bandWindow(total: number, selected: number, visible: number): { first: number; count: number } {
	const count = Math.min(total, visible);
	return { first: Math.max(0, Math.min(selected - count + 2, total - count)), count };
}

/** The more-mark for row `i` of a window: `↑` on its first row when the
 *  list goes on above, `↓` on its last when it goes on below. */
export function moreMark(i: number, first: number, count: number, total: number): string | null {
	return i === first && first > 0 ? "↑" : i === first + count - 1 && first + count < total ? "↓" : null;
}

/** The key row that closes a band: what the keys do, then the selection's
 *  place in the list at the right edge. The keys give way from the least
 *  needed (the first in `keys`); the counter stays. */
export function bandKeyRow(keys: readonly string[], selected: number, total: number, W: number): string {
	const p = palette();
	const count = total === 0 ? "0/0" : `${selected + 1}/${total}`;
	let kept = [...keys];
	while (kept.length > 0 && 2 + visibleWidth(kept.join(" · ")) + 2 + count.length + 1 > W) kept = kept.slice(1);
	const text = kept.join(" · ");
	const gap = Math.max(1, W - 1 - 2 - visibleWidth(text) - count.length);
	return `${p.dim}${widthCut(`  ${text}${" ".repeat(gap)}${count}`, Math.max(0, W))}${p.reset}`;
}

/** Text with the given code-unit positions in bold gold — what the person
 *  typed, in the colour of what the person says — and the rest in `base`. */
export function goldHits(text: string, hits: ReadonlySet<number>, base: string): string {
	const p = palette();
	// off a known ground there is no gold: the warn tint carries it (as
	// /resume's title does), so a selected row — bold throughout — still
	// shows which letters matched
	const gold = p.gold !== "" ? p.gold : p.warn;
	// one span per RUN of hits, not per letter: a typed prefix is a run
	let out = "";
	let inHit: boolean | null = null;
	let i = 0;
	for (const ch of text) {
		const hit = hits.has(i);
		if (hit !== inHit) out += hit ? `${p.reset}${p.bold}${gold}` : `${inHit === null ? "" : p.reset}${base}`;
		inHit = hit;
		out += ch;
		i += ch.length;
	}
	return `${out}${p.reset}`;
}
