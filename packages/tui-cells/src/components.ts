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
 * silently truncates — the crash is the contract, not a symptom).
 *
 * The fold is SGR-AWARE: a line whose bold/dim span would straddle a
 * fold boundary closes the span at the break and reopens it on the
 * next row — the #16b contract (no literal "[2m" fragments) survives
 * folding. displayWidth/charWidth (width.ts) are the width primitives
 * (untouched); render.ts supplies the original text (palette, escape,
 * tint, fold wording).
 */

import { displayWidth } from "./width.js";
import {
	bannerLines,
	escapeTerminal,
	foldThinking,
	foldResult,
	colorInlineCode,
	renderTerminalGap,
	renderToolSummary,
	toolTarget,
	kUnit,
	palette,
	type Palette,
	type ResumeMeta,
} from "./render.js";

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
	if (rows.length > 1 || prev.length > 1) return ["", ...rows];
	return rows as string[];
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
			/** W13: the rolled-up group summary — set at COMMIT time when
			 *  the head of an N > 2 same-tool run renders the group (the
			 *  work order's claimed shape: "✓ read  5 files (2.4k lines,
			 *  1.1s)" + the target children). The members carry null — the
			 *  compositor's rolled-heads bookkeeping renders them [].
			 *  TUI2-R1 (B): `parts` is set when the run spans MORE THAN ONE
			 *  read-only tool — the same mechanism, the exploration row.
			 *  Absent (a single-name run) keeps W13's row byte for byte. */
			rolled: null | {
				count: number;
				lines: number;
				elapsed: string;
				targets: string[];
				parts?: readonly { name: string; subjects: readonly string[] }[];
			};
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
			 *  <decidedBy>` (the human approval needs no marker — the ⏸ →
			 *  spinner → ✓ sequence told the story). Null until a decision
			 *  lands (the auto-allowed calls never have one). */
			verdict: { decision: "approved" | "denied"; decidedBy?: string; reason?: string } | null;
	  }
	| { kind: "text"; text: string; done: boolean }
	| { kind: "notice"; text: string; done: true }
	| { kind: "banner"; version: string; extensionsText: string; resume: ResumeMeta[]; done: true }
	| { kind: "raw"; lines: string[]; done: true }
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
			/** W20: the LIVE block's ctrl+r toggle (W15) — the capped form
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
			return new ThinkingFold(cell);
		case "tool":
			return new ToolExecution(cell);
		case "text":
			return new AssistantMessage(cell);
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
 * the text at W−2 (the side pads), then pads EVERY row to the longest
 * row's DISPLAY width + one space each side, flush left: the block is
 * only as wide as what was said (never the full-width band — a short
 * message like /think would paint a bar across the terminal). The
 * padding is by cells (charWidth is the width authority), so a CJK row
 * pads by width, never by chars, and the chip never overruns its fold.
 * SGR 7 closed with SGR 27 — never SGR 0, the chip composes with a
 * surrounding span — and NEVER dim: reverse video inverts the CURRENT
 * colours, so dimmed text would invert into a dimmed block with no
 * contrast.
 */
class UserMessage implements Component {
	constructor(private readonly cell: { text: string }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const p = palette();
		const chipW = Math.max(1, W - 2);
		const rows: string[] = [];
		for (const para of this.cell.text.split("\n")) {
			const folded = foldLine(escapeTerminal(para), chipW);
			const inner = Math.max(...folded.map((r) => displayWidth(r)));
			for (const row of folded) {
				const pad = inner - displayWidth(row);
				rows.push(`${p.rv} ${row}${" ".repeat(pad)} ${p.rvEnd}`);
			}
		}
		return rows;
	}
}

/** W22: the pending-queue chips — queued user lines pre-render above
 *  the input row as the SAME UserMessage chip (undimmed: reverse video
 *  inverts the CURRENT colours), the dim `□` gutter marking the queued
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
class ThinkingFold implements Component {
	constructor(private readonly cell: { text: string; done: boolean }) {}
	render(W: number, _ctx: FrameCtx): string[] {
		const block = this.cell.text;
		const trimmed = escapeTerminal(block.trim());
		// the SHORT branch is width-aware TOO: the ≤100 short-circuit was
		// W-blind — a short block at a narrow width returned the line
		// UNFOLDED and tripped invariant ① (the crash class still live on
		// npm for short /think blocks after a resize).
		if (trimmed.length <= 100) return [`${palette().dim}⋯${widthCut(trimmed, Math.max(1, W - 1))}${palette().reset}`];
		const suffix = ` (${block.length} chars · /think)`;
		const slice = Math.max(1, W - 1 - suffix.length);
		return [`${palette().dim}⋯${widthCut(trimmed, slice)}${suffix}${palette().reset}`];
	}
}

/** Fold a line's CONTENT at W−2 and prefix EVERY row with the gutter
 *  (W2: a wrapped tool row keeps its state mark — the left edge alone
 *  distinguishes the states at --plain; the UserMessage rail precedent,
 *  v5 #16f). The gutter carries its own SGR (e.g. the bold ✓). W21:
 *  exported for the approval panel's text args (the same │ gutter). */
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
 *  renderer-cut row (`└ +N … · ctrl+r`) sits INSIDE the cap (a
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
		const verb = escapeTerminal(c.name.replace("_file", ""));
		const verbCol = verb.length < 5 ? `${verb}${" ".repeat(5 - verb.length)}` : verb;
		const parts = c.rolled?.parts;
		if (c.rolled !== null && parts !== undefined) {
			// TUI2-R1 (B) — the exploration row: a run that spans more than
			// one read-only tool. The counts are BOLD (what the reader is
			// being told), the timing and the affordance dim — the
			// prototype's placement. The affordance names what the key
			// SHOWS here ("lists them"), because a group row's expand is a
			// list of calls, not a body of output.
			const r = c.rolled;
			const counts = exploreCounts(parts);
			const head = `${p.bold}✓${p.reset} explored ${p.bold}${counts}${p.reset}`;
			const tail = ` (${r.elapsed}s)`;
			const room = W - visibleWidth(head) - tail.length;
			const affordance = " · ctrl+r lists them";
			return [cutLine(`${head}${p.dim}${tail}${affordance.length <= room ? affordance : ""}${p.reset}`, W)];
		}
		if (c.rolled !== null) {
			// W13 — the rolled-up group's ONE row + the target children:
			// the work order's claimed shape, verbatim — the verbCol's
			// 5-char pad reproduces the "read  5 files" double space, the
			// children are the first 3 basename targets, the overflow row
			// carries the ctrl+r affordance (its "└ … ctrl+r" joins the
			// W15 expand history — the head's commit captures it).
			const r = c.rolled;
			const noun = ROLLUP_NOUN[c.name] ?? "calls";
			const out = gutterCut(`${p.bold}✓${p.reset} `, `${verbCol} ${r.count} ${noun} (${kUnit(r.lines)} lines, ${r.elapsed}s)`, W);
			const shown = r.targets.slice(0, 3);
			if (shown.length > 0) out.push(`  ${p.dim}${CUT_ROW}${escapeTerminal(shown.join(" · "))}${p.reset}`);
			if (r.targets.length > 3) out.push(`  ${p.dim}${CUT_ROW}+${r.targets.length - 3} more — ctrl+r expands${p.reset}`);
			return out;
		}
		if (c.state === "done") {
			// W19: the pinned deny — the claimed shape verbatim: the FULL
			// call name (the denial names the call), the target, the reason
			// in the W4 parentheses idiom, no timing (the call never ran).
			// The same ✗ family as any failure; the [result ✗] body still
			// rides below (never hide information). A5: an extension's
			// denial appends `· by <decidedBy>` — the aggregated head row
			// names the decider; a human denial (no decidedBy) has no tail.
			if (c.reason !== null) {
				const by = attribution(c);
				const out = gutterCut(`${p.red}✗${p.reset} `, `${p.red}${escapeTerminal(`${c.name} ${toolTargetOf(c)}`)} (${escapeTerminal(c.reason)}${by})${p.reset}`, W);
				out.push(...toolBlockBody(c, W));
				return out;
			}
			const elapsed = c.startedAt !== null && c.doneAt !== null ? ((c.doneAt - c.startedAt) / 1000).toFixed(1) : "?";
			// TUI2-R1.5 ⑤ (VD-6): the line count is stated EXACTLY ONCE. Every
			// read card carried it twice — `(2 lines, 0.0s) · 2 lines · ctrl+r
			// expands` — because the parens and the suffix were written by
			// different rounds, each unaware the other was counting. The
			// SUFFIX keeps it (it is the one that also names the key), so a
			// meta that says only "<n> lines" drops out when a suffix will
			// carry it. A meta that says something else — read_file's
			// "200 of 250 lines", a diff's "+1 -1", a shell's "exit 0" — is a
			// different fact and stays.
			const rawMeta = settledMeta(c);
			const dup = hiddenLines(c, W) !== null && new RegExp(`^${hiddenLines(c, W)} lines?$`).test(rawMeta);
			const meta = dup ? "" : escapeTerminal(rawMeta);
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
			// the W4 parentheses idiom: the facts, ` · `-separated, then the
			// timing closing the group. An empty fact simply is not there.
			const facts = [meta, approvedBy.replace(" · ", "")].filter((x) => x !== "");
			const parens = `(${facts.length > 0 ? `${facts.join(" · ")}, ` : ""}${elapsed}s)`;
			const hidden = hiddenLines(c, W);
			// TUI2-R1.5 ⑤: the shortest tier is RESERVED — the affordance is
			// the semantics, the target is the cuttable span.
			const room = W - (hidden === null ? 0 : SUFFIX_MIN);
			const out = c.isError
				? gutterCut(`${p.red}✗${p.reset} `, `${p.red}${verbCol} ${escapeTerminal(toolTargetOf(c))} ${parens}${p.reset}`, room)
				: gutterCut(`${p.bold}✓${p.reset} `, `${verbCol} ${escapeTerminal(toolTargetOf(c))} ${parens}`, room);
			out[0] = appendSuffix(out[0]!, expandSuffix(hidden, W - visibleWidth(out[0]!)));
			out.push(...toolBlockBody(c, W));
			return out;
		}
		if (c.state === "approval") {
			// W2: the ⏸ is the GUTTER (the left edge), never the line's tail
			const out = gutterCut(`${p.bold}⏸${p.reset} `, `${verbCol} ${liveTarget(c)}`, W);
			out.push(...toolBlockBody(c, W));
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
			const out = gutterCut(`${p.bold}${SPINNER[ctx.spinnerI % SPINNER.length]}${p.reset} `, `${verbCol} ${liveTarget(c)}`, Math.max(4, W - dur.length));
			out[0] = `${out[0]!}${p.dim}${dur}${p.reset}`;
			out.push(...toolBlockBody(c, W));
			return out;
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
 * (`└ +N earlier rows · ctrl+r`, `└ +N more · ctrl+r`) already teaches
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
	if (c.expanded || c.state !== "done" || c.rolled !== null || c.reason !== null) return null;
	if (c.name === "delegate") return null; // its body is the one-line summary, always whole
	const n = countLines(c.resultText);
	if (n === 0) return null;
	if (c.isError) return null; // errorBody's own cut row is the affordance there
	// TUI2-R1.5 ④(c) (VD-5): a settled shell renders NO body, so its whole
	// output is behind the key exactly like every other settled call. The
	// retired branch only claimed a suffix once the output passed the
	// five-row cap, because below that the tail was on screen; there is no
	// tail now, and a card hiding four lines while saying nothing is the
	// silence TUI2-R1 (A) set out to remove.
	return n; // every other settled call renders NO body — all of it is behind the key
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
 *  affordance: exactly the shortest tier, " · ctrl+r". The suffix used
 *  to take whatever width happened to be left, so a long target spent it
 *  all and the card said nothing about the lines behind the key. Every
 *  row that fitted its head before still fits it; only a head that would
 *  have eaten the whole row gives up its last nine cells. */
const SUFFIX_MIN = " · ctrl+r".length;

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
	const count = `${lines} line${lines === 1 ? "" : "s"}`;
	for (const tier of [` · ${count} · ctrl+r expands`, ` · ${count} · ctrl+r`, " · ctrl+r"]) {
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

/** TUI2-R1 (A) — the expanded block's last row: the way back. The
 *  rollup's expanded list carries a second clause (its members' full
 *  outputs live in /last, which the group row cannot show). */
const COLLAPSE_ROW = "ctrl+r collapses";

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

/** TUI2-R1 (B) — the verb column of the expanded list. `search_text`
 *  reads as "search" there: the column names the ACT, and the raw tool
 *  name is what the cut notes carry (they name what the model calls). */
const EXPLORE_VERB: Readonly<Record<string, string>> = { read_file: "read", list_dir: "list", search_text: "search" };

/** Whether a tool joins an exploration run. Exactly the read-only set —
 *  writes, edits, shells and extension tools never group (a burst of
 *  side effects is a list of things that HAPPENED, and every row of it
 *  carries meaning). */
export function isExploreTool(name: string): boolean {
	return EXPLORE_NOUN[name] !== undefined;
}

/** "8 files · 14 searches" — the per-tool counts in first-call order. */
export function exploreCounts(parts: readonly { name: string; subjects: readonly string[] }[]): string {
	return parts
		.map((part) => {
			const [singular, plural] = EXPLORE_NOUN[part.name] ?? ["call", "calls"];
			return `${part.subjects.length} ${part.subjects.length === 1 ? singular : plural}`;
		})
		.join(" · ");
}

/** TUI2-R1 (B) — the expanded list: ONE row per tool, the verb column
 *  then the distinct subjects in first-call order, a repeated subject
 *  carrying its ×count, the first three shown and the rest counted.
 *  A search's subject is its PATTERN (quoted — the thing that was
 *  looked for); a read's or a list's is its path. */
export function exploreRows(parts: readonly { name: string; subjects: readonly string[] }[], W: number): string[] {
	const p = palette();
	const rows: string[] = [];
	for (const part of parts) {
		const counts = new Map<string, number>();
		for (const s of part.subjects) counts.set(s, (counts.get(s) ?? 0) + 1);
		const shown = [...counts.entries()].slice(0, 3).map(([s, n]) => (n > 1 ? `${s} ×${n}` : s));
		const more = counts.size > 3 ? ` (+${counts.size - 3})` : "";
		const verb = EXPLORE_VERB[part.name] ?? part.name;
		rows.push(cutLine(`${p.dim}${BODY_ROW}${escapeTerminal(`${verb.padEnd(6)} ${shown.join(" · ")}${more}`)}${p.reset}`, W));
	}
	// TUI2-R1.5 ① (VD-15): the footer used to promise "/last shows the full
	// outputs". /last shows the LAST call only — for a nine-call burst that
	// is one output out of nine, and a footer that sends the human to a
	// place the content is not is worse than a footer that says nothing.
	rows.push(cutLine(`${p.dim}${CUT_ROW}${COLLAPSE_ROW}${p.reset}`, W));
	return rows;
}

/** The count term with the singular/plural forms — "no reads", "1 read",
 *  "5 reads". The noun's singular drops the plural suffix ("dirs" → "dir",
 *  "matches" → "match"). */
function countTerm(n: number, singular: string, plural: string): string {
	if (n === 0) return `no ${plural}`;
	if (n === 1) return `1 ${singular}`;
	return `${n} ${plural}`;
}

/** W14 — the folded-turn line: a whole QUIET turn (no text), once it is
 *  scrollback, becomes ONE line — the work order's claimed shape
 *  (`▞ thought 19s · 5 reads · no edits`), the counts accumulated at
 *  toolStart: read_file → "reads", edit_file → "edits", the other tools
 *  as first-call-order terms (the ROLLUP_NOUN plurals when the tool opts
 *  in, the verb + "s" otherwise).
 *  A9 (ruling R2, mock A): the user chip rides the fold — the human's
 *  words LEAD the one line, `▞ <chip> · thought 19s · 5 reads · no
 *  edits` — the chip the SAME SGR-7 bracket as the live user row (#16f,
 *  side pads included). The words take the fold's width budget: the
 *  metadata terms survive (the W14 metadata rule — they give way LAST),
 *  the words width-cut at the end with the honest "…" (never a silent
 *  truncate — invariant ① holds on the ONE row by construction). */
export function turnFold(t: { words: string; thoughtSeconds: number; reads: number; edits: number; others: [string, number][] }, W: number): string[] {
	const p = palette();
	const parts = [`thought ${t.thoughtSeconds}s`, countTerm(t.reads, "read", "reads"), countTerm(t.edits, "edit", "edits")];
	for (const [name, n] of t.others) {
		const noun = ROLLUP_NOUN[name];
		if (noun !== undefined) {
			parts.push(countTerm(n, noun.endsWith("es") ? noun.slice(0, -2) : noun.slice(0, -1), noun));
		} else {
			const verb = name.replace("_file", "");
			parts.push(countTerm(n, verb, `${verb}s`));
		}
	}
	const meta = parts.join(" · ");
	const words = escapeTerminal(t.words);
	if (words === "") {
		const row = `${p.bold}▞${p.reset} ${meta}`;
		return visibleWidth(row) <= W ? [row] : [`${p.bold}▞${p.reset} ${widthCut(meta, Math.max(1, W - 3))}…`]; // a wordless turn folds to the W14 shape
	}
	// A9 (ruling R2, mock A): the user chip rides the fold — the human's
	// words LEAD the one line, the same SGR-7 bracket as the live user
	// row (#16f, side pads included). The words take the fold's width
	// budget: W − the gutter ("▞ " = 2) − the join (" · " = 3) − the
	// chip's side pads (2) − the cut-tail reserve (1, the "…") − the
	// metadata's own width — the metadata survives, the words width-cut
	// at the end with the honest "…" (the "…" alone is the honest floor:
	// the words were there, cut).
	const budget = Math.max(0, W - visibleWidth(`▞ ${meta}`) - 6);
	const cut = visibleWidth(words) > budget ? `${widthCut(words, budget)}…` : words;
	const row = `${p.bold}▞${p.reset} ${p.rv} ${cut} ${p.rvEnd} · ${meta}`;
	if (visibleWidth(row) <= W) return [row];
	// the last resort: the METADATA gives way — the words hold their
	// budget, the meta cuts with the honest "…"; invariant ① never trips
	// at ANY width (a degenerate W's fold is a cut, never a crash).
	return [`${p.bold}▞${p.reset} ${p.rv} ${cut} ${p.rvEnd} · ${widthCut(meta, Math.max(1, W - 8 - visibleWidth(cut)))}…`];
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
 *  is — at the LEFT EDGE (the gutter column: the left edge alone
 *  distinguishes the states at --plain). Structural (constraint 1). */
const BODY_ROW = "│ ";
const CUT_ROW = "└ ";

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
	const state = `${c.state}:${c.isError}:${c.name}:${c.expanded ? "x" : ""}`;
	const content: unknown = c.state === "approval" ? (c.diff ?? null) : c.resultText;
	if (memo !== undefined && memo.width === W && memo.state === state && memo.content === content) return memo.rows;
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
						: // TUI2-R1.5 ④(c) (VD-5): a settled shell collapses like
							// every other settled call. It used to keep its last
							// rows plus a "+N earlier rows · ctrl+r" cut FOREVER —
							// six rows per call, so three shells owned a screen. The
							// approved R1 prototype's state 2 is one line; the head
							// row's own suffix already names the count and the key,
							// and ctrl+r shows the whole block, not a five-row window
							// of it.
							[]
				: c.state === "running"
					? c.name === "delegate"
						? delegateRunning(c, W)
						: c.name === "shell"
							? shellLiveTail(c.resultText, W)
							: liveWindow(c.resultText, W)
					: c.state === "approval"
						? diffBody(c.diff, W)
						: [];
	const note = c.expanded ? null : toolCutNote(c.name, c.resultText);
	if (note !== null) rows.push(...foldLine(`${p.dim}${CUT_ROW}${note}${p.reset}`, W));
	// TUI2-R1 (A): an EXPANDED block says how to put it back. The footer
	// rides a block that HAS rows — an expanded delegate whose summary
	// marker is missing renders nothing, and a lone footer under a head
	// row would be an affordance for an empty block.
	if (c.expanded && rows.length > 0) rows.push(...foldLine(`${p.dim}${CUT_ROW}${COLLAPSE_ROW}${p.reset}`, W));
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
 *  is at the end, the reference implementation's truncateToVisualLines
 *  direction). */
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
	const rows = blockRows(c.resultText.split("\n").slice(skipFirst).join("\n"), W);
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

/**
 * TUI2-R1 (C) — the RUNNING shell's live tail.
 *
 * The rows are the sidecar's last lines, NEWEST AT THE BOTTOM (a tail
 * grows downward, and the row nearest the footer is the newest thing the
 * command said). The window is the SAME three rows W8 fixed: two tail
 * rows and the footer, blank-padded before the output fills them, so the
 * block's height still changes exactly once — at settle.
 *
 * With nothing observed the shape is exactly today's "waiting for
 * output": a sidecar that never appeared, a command that has not
 * printed, and a temp dir that refused the write are indistinguishable
 * from here, and all three mean the same thing — nothing to show.
 *
 * The footer names the state AND the two gestures that apply while a
 * command runs, because this is precisely when a human wants them.
 */
function shellLiveTail(text: string, W: number): string[] {
	if (text === "") return liveWindow("", W);
	const p = palette();
	// TUI2-R1.5 ④(b) (VD-4): the tail's first row is never a blank gutter.
	// Two sources, both fixed here, and the W8 fixed-window height is kept
	// by both fixes:
	//  - leading empty lines in the sidecar (a 4096-byte tail can begin on
	//    a line boundary, and the reader's .trimEnd only trims the other
	//    end) are skipped;
	//  - the short-output pad moved from the TOP to the BOTTOM. It exists
	//    so the block's height never changes while the command runs (W8);
	//    at the top it put an empty row above the command's very first
	//    line, which is the frame the walkthrough filed. At the bottom the
	//    output starts under its own header and grows downward, and the
	//    height is just as fixed.
	const all = blockRows(text, W);
	const from = all.findIndex((r) => visibleWidth(r) > visibleWidth(BODY_ROW));
	const rows = from < 0 ? [] : all.slice(from);
	if (rows.length === 0) return liveWindow("", W);
	const kept = rows.slice(Math.max(0, rows.length - (CAP_LIVE_WINDOW - 1)));
	while (kept.length < CAP_LIVE_WINDOW - 1) kept.push(`${p.dim}${BODY_ROW}${p.reset}`);
	return [...kept, cutLine(`${p.dim}${CUT_ROW}live tail · esc stop · alt+⏎ redirect${p.reset}`, W)];
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
	const cut = (n: number): string => oneLineRow(p, `+${n} rows · ctrl+r to expand · /last for the full diff`, W);
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
	constructor(private readonly cell: { version: string; extensionsText: string; resume: ResumeMeta[] }) {}
	render(W: number, ctx: FrameCtx): string[] {
		const p = palette();
		const rows = bannerLines(W, ctx.height, this.cell.version, this.cell.extensionsText, this.cell.resume, ctx.now);
		return rows.map((r) => `${p.dim}${r}${p.reset}`);
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
	return `${out}\x1b[0m…`;
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
 * W10 cut family `└ +N done · ctrl+r`, overflow pending behind
 * `└ +N more · ctrl+r` — every row cut at W so the cap holds at every
 * width. ctrl+r (W15) toggles the full list in place (expanded). SETTLED
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
		const header = `${p.bold}▞${p.reset} ${escapeTerminal(fixed + tail)}`;
		// the FULL-list forms: SETTLED — the durable record (the fold is
		// fine — committed content wraps naturally) — and the LIVE ctrl+r
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
		// the settle (and the ctrl+r toggle) show everything.
		const itemRows: string[] = [];
		if (active.length > 0) itemRows.push(`  ${p.bold}▸${p.reset} ${escapeTerminal(active[0]!.text)}`);
		for (const item of pending.slice(0, 2)) itemRows.push(`  □ ${escapeTerminal(item.text)}`);
		const more = pending.length - 2;
		if (more > 0) itemRows.push(`  ${p.dim}└ +${more} more · ctrl+r${p.reset}`);
		if (doneCount > 0) itemRows.push(`  ${p.dim}└ +${doneCount} done · ctrl+r${p.reset}`);
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
export function statusLine(status: string, tail: string, W: number, hint?: string): string {
	const p = palette();
	const text = `${status}${tail === "" ? "" : ` · ${tail}`}`;
	// W18: the hint is a parameter — the compacting row right-aligns its
	// "esc to cancel" (the same one-line-bounded shape as W12's delegate
	// row; the #16g rule still cuts the HINT first, then the status with
	// a "…" — never a fold).
	const hintText = hint ?? " / commands · ↑ history";
	const statusW = visibleWidth(text);
	if (statusW > W) {
		return `${p.dim}${widthCut(text, W - 1)}…${p.reset}`;
	}
	const hintW = visibleWidth(hintText);
	if (statusW + hintW > W) return `${p.dim}${text}${p.reset}`;
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

/** W6 — the box: the chrome's top rail. The two ╌ dotted rows become
 *  a rounded box (the box already says "input lives here"); the rails
 *  stay dim, the width is still the full W (the box is a rail with
 *  corners — the menu/gap rows above and the status below are
 *  untouched). */
export function boxTop(W: number): string {
	return `\x1b[2m╭${"─".repeat(Math.max(0, W - 2))}╮\x1b[0m`;
}

/** W6 — the box: the chrome's bottom rail. */
export function boxBottom(W: number): string {
	return `\x1b[2m╰${"─".repeat(Math.max(0, W - 2))}╯\x1b[0m`;
}

/** The terminal label + rhythm gap (the pipe path's v2c bytes — the
 *  exact render the passthrough needs). */
export function terminalPipe(label: string, statusLineText: string): string {
	return label + renderTerminalGap(statusLineText);
}

/** The pipe-path pieces the passthrough reuses (byte-identical). */
export { foldThinking, foldResult, renderToolSummary, TOOL_SUMMARY_MAX };
