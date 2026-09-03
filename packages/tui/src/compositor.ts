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
 *    the reference implementation's model): a line COMMITS (leaves the
 *    live region) via the real-LF
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
 *    (components fold; a violation THROWS with diagnostics — the
 *    no-silent-truncate ruling); ② every steady-
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
 * Layout at H rows (V6-3 — the design §03 chrome; W6 — the box):
 * content rows 1..H−4, box top H−3, editor (the slot) H−2, box
 * bottom H−1, status H.
 * Pipes / NO_COLOR: the passthrough branches below keep the v2a/v2b
 * line-mode bytes byte-for-byte (the e2e guards them).
 */

import { truncateDiff } from "./diff.js";
import { MENU_ITEMS, displayWidth, type MenuItem } from "./editor.js";
import { leadWidth } from "./width.js"; // W23: the ONE width authority (the editor, #inputRow, and editCol share it)
// KC3.5: the panel-slot reads come from the DISPATCHERS — one source
// for four reads, so an ask can never render half as an approval.
import { panelFrameOf, panelLeadOf, panelRowsOf, panelStatusOf } from "./ask-panel.js";
import { MOUSE_OFF } from "./editor.js";
import type { PanelState } from "./approval-panel.js";
import { atPanelRows, bandHeader, type AtMatch } from "./at-picker.js";
// TUI2-R2 ②: the session picker's rows — the band's third occupant.
import { sessionPickerRows, type SessionPickState } from "./session-picker.js";

/** KC3 §4 — the @ picker's bound state (the editor's atState()). */
export interface AtPanelState {
	readonly matches: readonly AtMatch[];
	readonly selected: number;
	readonly capped: boolean;
}
import {
	LIVE_WINDOW,
	Container,
	ROLLUP_NOUN,
	MOTION_FRAMES,
	MdStream,
	bodySpacing,
	boxBottom,
	boxTop,
	cellComponent,
	foldCountsObjects,
	foldTerms,
	focusToken,
	exploreRows,
	foldLine,
	gutterCut,
	cutLine,
	isExploreTool,
	moreRunningRow,
	pendingQueueRows,
	slotPad,
	slotTail,
	statusLine,
	turnFold,
	visibleWidth,
	type BodyCell,
	type FrameCtx,
	breathFrame,
} from "./components.js";
import { bannerLines, escapeTerminal, foldResult, foldThinking, palette, renderTerminalGap, renderToolSummary, toolTarget, type BannerMeta, type ResumeMeta } from "./render.js";
import { displayVerb, keysSheetRows } from "./strings.js";
// R5 — the transcript viewer's PURE projection. The compositor supplies
// the entries (it holds the cells); the arrangement lives there.
import {
	VIEWER_GUTTER,
	viewerFlat,
	viewerHint,
	viewerInit,
	viewerMove,
	viewerRows,
	viewerScroll,
	viewerTitle,
	viewerToggle,
	viewerToggleAll,
	type ViewerEntry,
	type ViewerState,
} from "./transcript.js";

/** The cursor marker — an APC private sequence the focus component
 *  embeds at the edit position; the compositor strips it and moves
 *  relatively (it never reaches the terminal). */
export const CURSOR_MARKER = "\x1b_[kiso-cur]\x1b\\";

const FRAME_MS = 16; // state changes coalesce to ≥16ms frames
const SPINNER_MS = 200; // the spinner cadence — a ONE-SHOT re-armed on demand
/** REL-0152-R1: a held row that has never been painted, so the first
 *  frame writes every row rather than trusting an empty string. */
const NOT_PAINTED = "\u0000never";

/** REL-0152-D18 — how long a drag has to be quiet before it is over.
 *  Long enough that a continuous drag never crosses it, short enough
 *  that a single resize still feels immediate. */
const RESIZE_SETTLE_MS = 80;

const CHROME_ROWS = 4; // box top + input + box bottom + status — the design §03 chrome (V6-3; the box is W6)

/** R3i — how many calls in flight the act window shows at once. Beyond
 *  it the block would grow with the model's parallelism, which is the
 *  same unbounded height the projection exists to remove; the rest are
 *  COUNTED, never dropped silently. */
const LIVE_ACT_HEADS = 3;
/** R8 — the command band's window: five rows plus a counter, the same
 *  budget the composer's own ceiling can afford above it. */
const MENU_WINDOW = 5;

/** KC1 §5 — the input row's bound state. The legacy pair stays
 *  REQUIRED and keeps its exact meaning (the cursor line's visible
 *  slice and its display column), so a one-row provider — the old
 *  `{line, cursor}` shape — keeps working unchanged; the composer's
 *  rows ride as OPTIONAL fields, which is what makes the CLI's binding
 *  signature-neutral (zero cli source growth). */
export interface InputState {
	readonly line: string;
	readonly cursor: number;
	/** the visible rows (≤ N_visible), dim "…" markers included */
	readonly lines?: readonly string[];
	/** the cursor's row within `lines` */
	readonly cursorRow?: number;
	/** the cursor's display column within that row */
	readonly cursorCol?: number;
}

export interface BodyOptions {
	/** REL-0150-D1 test seam: overrides the TERM_PROGRAM detection for
	 *  the conservative frame mode — process.env is SHARED across
	 *  concurrently-running test files in one worker, so a test that
	 *  mutated the env would bleed 40ms frames into its neighbors. */
	readonly termProgram?: string;
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

/** W14 — one turn's record: pushed at userLine, released at the turn's
 *  text (hasText — the tool cells commit individually, with the W13
 *  rollups) or at its end (ended — a QUIET turn folds into the one line).
 *  The counts are the folded-turn line's terms, accumulated at toolStart
 *  (reads = read_file, edits = edit_file, others = the rest in
 *  first-call order). A9: `words` is the user's own line — the chip that
 *  leads the fold (ruling R2, mock A). */
interface TurnRecord {
	ended: boolean;
	hasText: boolean;
	/** R6/D1 — the turn has produced its first thinking or tool cell, so
	 *  the act block is allocated. It stays allocated until endTurn: a
	 *  settling stretch commits its fold row ABOVE a block that does not
	 *  move, and the next stretch swaps the block's CONTENTS. */
	begun: boolean;
	thoughtSeconds: number;
	reads: number;
	edits: number;
	others: Map<string, number>;
	/** R3h — the distinct targets already counted, per OBJECT-counting
	 *  tool (see foldCountsObjects). A second read of the same file is a
	 *  second act but not a second file, and the fold's noun is the file. */
	seen: Map<string, Set<string>>;
	words: string;
	/** the fold was emitted at the first held cell's commit — the rest of
	 *  the turn's thinking/tool cells render [] (never a second fold). */
	folded: boolean;
	/**
	 * R3b — the turn's SEGMENTS, in order.
	 *
	 * A segment is a maximal run of thinking/tool cells with no text
	 * between them. The turn's own counters above are the WHOLE turn's
	 * (the quiet-turn fold's terms, unchanged); these are each segment's
	 * own, because a fold line that says `thought 19s · 5 reads` for the
	 * third segment of a turn has to mean that segment and not the sum
	 * of everything before it.
	 *
	 * `openedAt` is wall time, so a segment can report its own elapsed
	 * without waiting for `endTurn` — which is the only place
	 * `thoughtSeconds` is written today, and therefore useless to a fold
	 * that has to happen mid-turn.
	 */
	segments: SegmentRecord[];
}

/** R3b — one segment: the run of work between two text blocks. */
interface SegmentRecord {
	/** wall ms at the segment's first cell — its own clock */
	openedAt: number;
	/** wall ms at the text (or turn end) that closed it; null while open */
	closedAt: number | null;
	reads: number;
	edits: number;
	others: Map<string, number>;
	/** R3h — this segment's own distinct targets (see TurnRecord.seen). */
	seen: Map<string, Set<string>>;
	/** R3i — the segment's OWN thinking milliseconds, and its open clock.
	 *  The live line reports the thinking of the stretch a human is
	 *  watching, not the turn's total, and it runs by the same rule the
	 *  CLI applies to the turn: from the first thinking delta until the
	 *  first non-thinking event. Never a wall clock wearing the word
	 *  "thought" — that was the R3g defect. */
	thinkingMs: number;
	thinkingSince: number | null;
	/** the fold line was emitted for this segment — the rest of its cells
	 *  render [] (never a second fold, and never a lost one). */
	folded: boolean;
	/** the cell index that emitted this segment's fold line — the expand
	 *  key's anchor, and null until the fold is emitted. */
	headCell: number | null;
	/**
	 * R3b — the segment's own cell indices, appended as they are stamped.
	 *
	 * The fold's tests (how many cells? any trouble? which tools?) used to
	 * SCAN every cell in the body, and they run per cell inside the commit
	 * loop — O(n²) over a session's history. It was not visible in a unit
	 * test and was very visible in the PTY suite, where it burned enough
	 * worker CPU to starve vitest's reporter RPC. Membership is recorded
	 * where it is known, once.
	 */
	cells: number[];
	/** the segment was force-committed past the hold, so its cells are
	 *  already in the scrollback and CANNOT be replaced by a fold line.
	 *  The honest degradation: it stays expanded, and says nothing false. */
	spilled: boolean;
}
/* R13 — `rolledTitle`, `rolledDetail` and `rolledOf` retired with the
   W13 rollup and TUI2-R1 (B)'s exploration row (see #foldOrRollup). */

/**
 * TUI2-R1 (B) / R3b — the per-tool parts of an explore run, in
 * first-call order. A search's subject is the PATTERN it looked for
 * (quoted); a read's or a list's is the path it named.
 *
 * Extracted at R3b because TWO paths need it now: the commit-time
 * rollup, which has always built it, and the segment fold's EXPANSION,
 * which shows the rollup's rows rather than one row per call. Two
 * copies of this would be two answers to "what did that run do".
 */
function exploreParts(members: readonly Extract<BodyCell, { kind: "tool" }>[]): { name: string; subjects: string[] }[] {
	const parts: { name: string; subjects: string[] }[] = [];
	for (const m of members) {
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(m.inputFull) as Record<string, unknown>;
		} catch {
			// the full JSON is always parseable (stringified at toolStart)
		}
		const target = toolTarget(m.name, input);
		const subject = m.name === "search_text" ? `"${String(input.pattern ?? "")}"` : target;
		const part = parts.find((x) => x.name === m.name);
		if (part === undefined) parts.push({ name: m.name, subjects: [subject] });
		else part.subjects.push(subject);
	}
	return parts;
}

/** R3b — a segment's terms, for the expand header. The fold line's own
 *  wording comes from `turnFold`; this is the same facts in the header
 *  idiom the other expands use. */
function foldMeta(seg: SegmentRecord): string {
	const parts = foldTerms(seg.reads, seg.edits, [...seg.others]);
	return parts.length === 0 ? "thinking" : parts.join(" · ");
}

/** R3b — the turn's open segment, opened on demand at the first cell of
 *  work that follows a text block (or the turn's start). Returns null
 *  only when there is no turn at all, which is the pipe path's shape. */
function openSegment(turn: TurnRecord | undefined, now: number): SegmentRecord | null {
	if (turn === undefined) return null;
	const last = turn.segments[turn.segments.length - 1];
	if (last !== undefined && last.closedAt === null) return last;
	const fresh: SegmentRecord = { openedAt: now, closedAt: null, reads: 0, edits: 0, others: new Map(), seen: new Map(), thinkingMs: 0, thinkingSince: null, folded: false, spilled: false, headCell: null, cells: [] };
	turn.segments.push(fresh);
	return fresh;
}

/** R3b — close the turn's open segment, if it has one. Idempotent: text
 *  arriving twice in a row closes nothing the second time, which is what
 *  keeps a zero-cell segment from ever existing. */
function closeSegment(turn: TurnRecord | undefined, now: number): void {
	const last = turn?.segments[turn.segments.length - 1];
	if (last === undefined || last.closedAt !== null) return;
	stopThinking(last, now);
	last.closedAt = now;
}

/** R3i — the segment's thinking clock stops. It runs from the first
 *  thinking delta of a stretch and stops at the first NON-thinking
 *  event, the same rule the CLI applies to the turn — so `thought Ns`
 *  is thinking time at every scale and never a wall clock wearing the
 *  word (the R3g defect, kept closed at the new scale). */
function stopThinking(seg: SegmentRecord | undefined, now: number): void {
	if (seg === undefined || seg.thinkingSince === null) return;
	seg.thinkingMs += Math.max(0, now - seg.thinkingSince);
	seg.thinkingSince = null;
}

/** W20 — the whole-table-replace comparison: the live task block only
 *  redraws when the items actually changed (the task extension's
 *  idempotent shape — an unchanged replace is a no-op, no frame). */
function sameTask(a: { text: string; status: "pending" | "active" | "done" }[], b: { text: string; status: "pending" | "active" | "done" }[]): boolean {
	return a.length === b.length && a.every((x, i) => x.text === b[i]!.text && x.status === b[i]!.status);
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
	#lastSkip = 0; // the last frame's window top in model rows — the A8b scroll's leaving-count base
	/**
	 * REL-0152-R1 — the SCREEN, held.
	 *
	 * H strings: what the terminal is showing right now, as this
	 * compositor believes it. Every frame computes the screen it WANTS
	 * and writes only the rows where the two differ.
	 *
	 * This is the whole round. The old renderer's correctness came from
	 * remembering what it had written — which rows it had painted, which
	 * it had scrolled, what the window's top had been last time — and
	 * every defect in the D series that survived a patch came from that
	 * memory disagreeing with the terminal. A renderer that HOLDS the
	 * screen cannot disagree with itself: it computes a difference and
	 * emits it, and a row that is wrong for any reason is repaired on the
	 * next frame because the difference includes it.
	 *
	 * Six fixes were built and reverted before this — one for the tear,
	 * five for the chip loss — and each traded a loss for a duplicate
	 * somewhere else. They were all attempts to make the memory agree.
	 *
	 * The one thing a diff cannot repair is the SCROLLBACK, which is
	 * irreversible: see #scrolledOff.
	 */
	#screen: string[] = [];
	/**
	 * REL-0152-R1 — the row the cursor is on, as far as this compositor
	 * knows.
	 *
	 * The park at the end of a frame is a RELATIVE move, and the old
	 * renderer could hard-code its base: the bottom-up march always ended
	 * on the status row at H, so `from` was H by construction. A diff
	 * ends wherever the last CHANGED row happens to be — which on a
	 * streaming frame is the live band, not the bottom of the screen — so
	 * the base has to be tracked rather than assumed.
	 *
	 * Getting this wrong does not damage the frame; it parks the cursor
	 * in the wrong place, which is what the PTY gates that assert "every
	 * frame ends with the cursor on an input row" are for. They caught it.
	 */
	#cursorRow = 0;
	/**
	 * REL-0152-R1 — how many model rows have gone into the terminal's
	 * scrollback. Monotonic, because scrolling is.
	 *
	 * A row may only be scrolled off when it can never be shown again.
	 * The window is bottom-anchored, so its top moves BOTH ways as the
	 * live band grows and shrinks; scrolling on that movement pushed rows
	 * away that the next shrink brought back, which is the A7 replay's
	 * frame-106 duplicate. The floor below is where the window's top
	 * would sit with the live band empty and the chrome at its minimum —
	 * the only part of the movement that is one-way.
	 */
	#scrolledOff = 0;
	/** REL-0152-R1: this frame is the repaint after a SIGWINCH. */
	#resizeFrame = false;
	/** REL-0152-D18: a drag's signals are still arriving. */
	#resizePending = false;
	/** REL-0152-D19: the inherited terminal has not been released yet. */
	#needsReset = false;
	#resizeTimer: ReturnType<typeof setTimeout> | null = null;
	#lastH = 0;
	/** DC-34 — did THIS FRAME refold the committed cells?
	 *
	 *  It must be reset where the question is asked, not only where it
	 *  is answered. Armed once and consumed later, it latched: the
	 *  session's FIRST frame ran a vacuous refold over zero committed
	 *  cells and set it, and nothing cleared it until the first resize —
	 *  so every session's first widen still ran the adopt it was
	 *  supposed to skip, and swallowed the live band's worth of
	 *  committed rows. Three paragraphs, in the measurement that found
	 *  it. */
	#refolded = false;
	/** DC-34 — the previous frame's width; the reach-back guard is for a
	 *  WIDTH change, which re-indexes the model, not a height change. */
	#lastW = 0;
	// KC1 §6: the composer's recorded extent — the row count the last
	// frame drew (exit's clear walks it) and the row its CHA parked the
	// cursor on (the steady frame's relative anchor). N = 1 reproduces
	// the retired constants exactly (one input row, the anchor at H−2).
	#lastInputRows = 1;
	#lastAnchorRow = 0;
	#frameTimer: NodeJS.Timeout | null = null;
	#spinnerTimer: NodeJS.Timeout | null = null;
	#spinnerI = 0;
	#lastThinking: string | null = null;
	#lastTool: { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } } | null = null;
	#pendingCalls = new Map<string, { name: string; input: Record<string, unknown>; result: { content: string; isError: boolean } }>();
	/** R3b — cell index → the index of the segment it belongs to, for
	 *  thinking/tool cells; -1 for every other kind. Parallel to #cells,
	 *  because a segment is the COMPOSITOR's bookkeeping and does not
	 *  belong on the cell type the renderer sees. */
	readonly #cellSegment: number[] = [];
	#pipeBuf = ""; // the passthrough's thinking buffer
	/** TUI2-MD ⑤ — the markdown scanner of the message currently
	 *  streaming, and the cell index its first block landed at. Null
	 *  between messages: the scanner's life is one assistant message. */
	#md: MdStream | null = null;
	#mdBase = 0;
	#toolCells = new Map<string, number>(); // callId → cell index (parallel tools)
	// W15: the collapsed (cut) tool cells — committed cells whose last
	// rendered row carried the "ctrl+o" affordance; the expand key's
	// cycling pointer walks this list from the newest back.
	#collapsed: number[] = [];
	/** R4 (C1) — the ring walk is by IDENTITY, not by a modular pointer.
	 *  `#collapsed` is unshifted on every commit that carries the key, so
	 *  a numeric pointer's target silently CHANGED whenever a new fold
	 *  landed mid-cycle: the ring was not stable under itself, and the
	 *  next press opened something other than what the last press
	 *  implied. This set records what the current cycle has already
	 *  opened; the walk takes the newest entry not in it, and empties it
	 *  when every entry has been seen. */
	#opened = new Set<number>();
	// W14: the turn records — one per userLine, the fold-hold's state
	// machine (ended / hasText / folded) plus the folded-turn line's
	// counts (accumulated at toolStart). The cells carry the record's
	// index as their turn boundary.
	#turns: TurnRecord[] = [];
	// W13: the rolled-up run heads — the commit-time scan's verdict:
	// the head's group summary renders, the members render [].
	#rolledHeads = new Set<number>();
	#write: (s: string) => void;
	#resizeHandler: (() => void) | null = null;
	/** TUI2-R3v2 ②: the panel option rows' absolute screen span, as of the
	 *  last frame. Null whenever no clickable list is on screen. */
	#panelRowSpan: { top: number; count: number; first: number } | null = null;
	// the chrome state (the Dock façade)
	#status = "";
	#statusHint: string | null = null;
	#tail = "";
	// W21: the panel's bound state — the PanelSelect slot occupant (the
	// old ApprovalPrompt's question slot retires with it): while a
	// panel is up it replaces the live region, owns the input lead, and
	// derives the status row (the CLI's painting status yields).
	#panelState: (() => PanelState | null) | null = null;
	/** TUI2-R1 (D): the keys sheet's slot read — the editor's boolean.
	 *  Unbound, the sheet cannot render and every frame is byte-identical
	 *  to before the round. */
	#sheetState: (() => boolean) | null = null;
	/** R5 — the transcript viewer's state, or null when it is closed. It
	 *  lives HERE rather than in the editor because its entries are the
	 *  compositor's cells; the editor only sends it commands. */
	#viewer: ViewerState | null = null;
	#viewerWasUp = false;
	/** TUI2-R1.5 7(a): the sheet's previous up/down state — a transition
	 *  in either direction takes the full-redraw path. */
	#sheetWasUp = false;
	/** This frame is an overlay open or close — it must not scroll. */
	#overlayFrame = false;
	#inputState: () => InputState = () => ({ line: "", cursor: 0 });
	#inputPrompt = "";
	#menuState: (() => { items: readonly MenuItem[]; selected: number } | null) | null = null;
	// KC3 §4: the @ picker's bound state — the SAME band as the menu
	// (see #menuRows: the two are mutually exclusive by construction).
	#atState: (() => AtPanelState | null) | null = null;
	// TUI2-R2 ②: the session picker's bound state — the same band again
	// (see #menuRows), and modal, so it takes the band first.
	#pickState: (() => SessionPickState | null) | null = null;
	// W22: the pending-turn queue's bound state — the CLI's live slots
	// (chat.ts); the chips render in the menu-rows family (above the
	// box top), the live caps shrink by their rows, and the status
	// row's right hint shows the count while any turn waits.
	#queueState: () => readonly string[] = () => [];

	/** REL-0150-D1 — the conservative frame mode. Terminal.app does not
	 *  support DEC 2026 synchronized output (half-frames paint on its own
	 *  schedule — the reviewer dogfood watched the tearing live) and its
	 *  renderer is throughput-weak (typed input lagged seconds behind the
	 *  stream). Where TERM_PROGRAM says Apple_Terminal: the frame wraps
	 *  in ?25l/?25h (cursor hidden during the repaint — the classic
	 *  anti-tearing degrade; every frame re-shows it) instead of the dead
	 *  2026 bytes, and the coalesce window widens 16→40ms (fewer, bigger
	 *  frames: fewer tear opportunities, less renderer pressure). Every
	 *  other terminal keeps today's bytes exactly. Heuristic on purpose —
	 *  a DECRQM round-trip would race the editor for stdin at boot. */
	readonly #conservative: boolean;
	readonly #frameMs: number;
	/** REL-0152-R1: the frame's own writer — the ONE path that does not
	 *  invalidate the held screen, because it is what produced it. */
	readonly #writeFrame: (s: string) => void;
	/** REL-0152-R1: true only while the frame's own bytes are going out. */
	#inFrame = false;
	#unguard: (() => void) | null = null;

	constructor(opts: BodyOptions) {
		this.#opts = opts;
		// REL-0152-R1: every write that is NOT this frame's own goes
		// through here and INVALIDATES the held screen.
		//
		// A banner, a bodyLog line, the terminal gap, the pipe path's
		// prose — all of them paint the terminal directly, and the old
		// renderer survived that because every frame repainted every row.
		// A diff does not: after such a write the held screen describes a
		// terminal that no longer exists, and the next frame skips exactly
		// the rows it should have repaired. That is a stale composer row
		// left standing while the real one moves — which is what the PTY
		// cursor gates saw.
		//
		// Forgetting is cheap and cannot be forgotten to do: one frame
		// repaints, and correctness stops depending on a list of writers
		// staying complete as the file grows.
		const raw = opts.write ?? ((str: string) => process.stdout.write(str));
		this.#writeFrame = raw;
		this.#write = (str: string): void => {
			this.#screen = [];
			raw(str);
		};
		this.#conservative = (opts.termProgram ?? process.env.TERM_PROGRAM) === "Apple_Terminal";
		this.#frameMs = this.#conservative ? 40 : FRAME_MS;
		this.#active = opts.active();
		// v6: the single writer — the compositor IS the dock; the CLI's
		// onDock callback (which used to re-pin the dock after a scroll)
		// is retired with the split.
		// TUI2-R2pre ③: taking the ref SUPERSEDES whatever held it, so the
		// outgoing compositor's resize listener comes off here. It is not
		// only listener hygiene: every Dock call now reaches THIS instance,
		// so a resize heard by the old one would have a compositor that owns
		// no part of the screen paint a full redraw over it.
		// (an explicit null check, not `?.#` — TS18030: an optional chain
		// cannot contain a private identifier, and vitest transpiles without
		// type-checking, so only `npm run typecheck` sees the difference)
		if (compositorRef !== null) compositorRef.#detachResize();
		compositorRef = this;
		// the Dock façade's bindings may arrive BEFORE this construction
		// (the CLI binds the editor state in makeLineInput, then constructs
		// the Body) — the LIVE binding buffer applies here, or the input
		// row would never render the typed line. W21: the buffer is a
		// mutable object the bind methods update in place — order-agnostic
		// (the old snapshot froze `menu` at bindInput time and the menu
		// silently never bound in the real CLI; the e2e gates bind the
		// Body directly and could not see it).
		if (dockBindings.state !== null) this.#inputState = dockBindings.state;
		this.#inputPrompt = dockBindings.prompt;
		if (dockBindings.menu !== null) this.#menuState = dockBindings.menu;
		if (dockBindings.at !== null) this.#atState = dockBindings.at;
		if (dockBindings.pick !== null) this.#pickState = dockBindings.pick;
		this.#panelState = dockBindings.panel;
		this.#sheetState = dockBindings.sheet;
		if (dockBindings.queue !== null) this.#queueState = dockBindings.queue;
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
		// W14: the turn boundary — the record the fold-hold's release
		// state machine reads; the cell carries the record's index. A9:
		// the user's own words ride the record — the fold's leading chip.
		this.#turns.push({ ended: false, hasText: false, begun: false, thoughtSeconds: 0, reads: 0, edits: 0, others: new Map(), seen: new Map(), words: text, folded: false, segments: [] });
		this.#cells.push({ kind: "user", text, done: true, turn: this.#turns.length - 1 });
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
			this.#cells.push({ kind: "thinking", text, done: false, turn: this.#turns.length - 1 });
			// DECLARED SUPERSESSION (R7, owner-ruled 2026-08-31) — THINKING
			// IS WORDS, NOT WORK.
			//
			// R3b made thinking open a segment, on the reading that it is
			// work like a tool call. Four rounds of consequences followed
			// from that one classification: folded away with the calls, it
			// became unreachable, and R4's printed ordinal, R5's viewer,
			// R6's subject index and a look-back viewport were each built
			// to hand it back. The owner's ruling is to stop hiding it —
			// and then none of those mechanisms is answering a question
			// anyone still asks.
			//
			// So thinking CLOSES the open segment, exactly as text does
			// (see textAppend): a segment is what sits between two of
			// these. It must close rather than merely not-open, because
			// `#committed` is a PREFIX count — a thinking cell cannot
			// commit past a held call, so think → call → think would
			// otherwise flush at the segment's close with the second
			// thought printing BELOW the fold that contains the later
			// call.
			//
			// Consequence, and it is wanted: the segment's thinking clock
			// never starts, so `thought Ns` drops off every fold line by
			// R3h's own zero-term rule. The line stops claiming a fact the
			// paragraph above it already states in full.
			const t0 = this.#turns[this.#turns.length - 1];
			closeSegment(t0, Date.now());
			if (t0 !== undefined) t0.begun = true; // R6/D1: the block allocates here
			// R3i: and the beat starts HERE. Law 1.4 says "a running thought
			// twinkles", and `#armSpinner`'s own predicate has always
			// included an open thinking cell — but the only caller was
			// `toolRunning`, so a stretch that thought and did nothing else
			// never moved at all. The line's seconds are a frame-time
			// derivation, so without the beat they also never ticked: the
			// row read `thinking 0s` for as long as the model thought.
			this.#armSpinner();
		}
		this.#mark();
	}

	thinkingEnd(): void {
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "thinking" && !last.done) {
			// R3i: every closer — text, a notice, a terminal label, the next
			// turn — routes through here, so the clock cannot keep running
			// past the thing that ended it.
			stopThinking(this.#turns[this.#turns.length - 1]?.segments.at(-1), Date.now());
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
		// TUI2-R1.5 ① (VD-1): the tool's start CLOSES an open text block —
		// the inactive path above has always done this; the active path
		// forgot, and the consequence was structural. textAppend only ever
		// grows the LAST cell, so a text block with a tool cell after it can
		// never receive another byte: it is finished in fact while its
		// `done` flag says otherwise. The commit loop takes leading DONE
		// cells, so that one stale flag parked the whole rest of the turn
		// behind it — every tool cell then reached the screen through the
		// FORCE-commit path, which by design bypasses the fold-hold. That is
		// why the walkthrough saw nine individual rows: not a fold that
		// declined to form, a fold that was never consulted.
		this.#closeOpenThinking();
		this.#closeOpenText();
		// W12: the cell carries the delegate's child roles from the FULL
		// input — the display summary is sliced at 60 chars (unparseable);
		// the roles are the only running-state data the parent holds (there
		// is no live channel to a running child session).
		const childRoles: string[] = [];
		for (const t of Array.isArray(input.tasks) ? (input.tasks as unknown[]) : []) {
			if (typeof t === "object" && t !== null && typeof (t as { role?: unknown }).role === "string") {
				childRoles.push((t as { role: string }).role);
			}
		}
		this.#toolCells.set(callId, this.#cells.length);
		this.#cells.push({ kind: "tool", name, input: summary, inputFull: JSON.stringify(input, null, 2), childRoles, state: "pending", isError: false, resultText: "", diff: null, added: 0, removed: 0, startedAt: null, doneAt: null, done: false, expanded: false, turn: this.#turns.length - 1, reason: null, verdict: null });
		// W14: the turn record's counts — the folded-turn line's terms
		// (reads = read_file, edits = edit_file, the rest in first-call
		// order). The CLI's recap counts the same way (edit_file).
		const turn = this.#turns[this.#turns.length - 1];
		if (turn !== undefined) {
			// R3h (fable, 2026-08-29): an OBJECT-counting tool counts the
			// distinct thing, not the act. Reading one file twice used to
			// fold as `read 2 files` — a sentence law 1.3 forbids, and one
			// this product shipped. `bump` is false on the second sighting
			// of a target the term has already counted; an ACT-counting
			// tool (a search, a shell command) always bumps, because two
			// searches for the same pattern really are two searches.
			// R3i phase 5 — an ANSWER is words, and words do not fold (law
			// 1.7). `ask_user` closes the open stretch exactly as prose
			// does, and never joins one: absorbed into `1 × ask_user`,
			// what the human said would be gone from the screen — and the
			// one thing a summary must not do is speak for the human.
			if (name === "ask_user") {
				// no stamp: it belongs to NO stretch, so no fold can speak
				// for it — the same standing a block of prose has.
				closeSegment(turn, Date.now());
				this.#mark();
				return;
			}
			const target = foldCountsObjects(name) ? toolTarget(name, input) : null;
			const bump = (rec: { seen: Map<string, Set<string>> }): boolean => {
				if (target === null) return true;
				let set = rec.seen.get(name);
				if (set === undefined) {
					set = new Set();
					rec.seen.set(name, set);
				}
				if (set.has(target)) return false;
				set.add(target);
				return true;
			};
			if (bump(turn)) {
				if (name === "read_file") turn.reads += 1;
				else if (name === "edit_file") turn.edits += 1;
				else turn.others.set(name, (turn.others.get(name) ?? 0) + 1);
			}
			// R3b: and into the SEGMENT, which opens here when this is the
			// first work since the last text block. Its set is its OWN — a
			// file read once per segment is one file in each segment's
			// terms and one file in the turn's.
			const seg = openSegment(turn, Date.now());
			// R3i: a tool call is a NON-thinking event — the clock stops,
			// exactly as the CLI's does at the same boundary.
			stopThinking(seg ?? undefined, Date.now());
			if (seg !== null && bump(seg)) {
				if (name === "read_file") seg.reads += 1;
				else if (name === "edit_file") seg.edits += 1;
				else seg.others.set(name, (seg.others.get(name) ?? 0) + 1);
			}
		}
		this.#stampSegment();
		const t1 = this.#turns[this.#turns.length - 1];
		if (t1 !== undefined) t1.begun = true; // R6/D1: the block allocates here
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

	/** A5: the approval verdict — the permission_decided event binds into
	 *  the cell (the aggregated head row: name + status + decidedBy in
	 *  ONE row; no free-standing `  approved` orphan). The decision lands
	 *  after the panel closes (the streamed event) — the cell is usually
	 *  running by then; the record rides the settled row (`· approved by
	 *  X` on an extension's auto-approval, `· by X` on its denial). A
	 *  verdict with no live cell is dropped — the registry holds only
	 *  in-flight calls, and the committed cells already told their
	 *  outcome. */
	toolVerdict(callId: string, decision: "approved" | "denied", decidedBy?: string, reason?: string): void {
		if (!this.#isActive()) return;
		const cell = this.#toolCell(callId);
		if (cell !== null && cell.kind === "tool") {
			cell.verdict = { decision, ...(decidedBy !== undefined ? { decidedBy } : {}), ...(reason !== undefined ? { reason } : {}) };
			this.#mark();
		}
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

	/**
	 * TUI2-R1 (C) — the RUNNING call's observed output.
	 *
	 * The CLI tails the shell tool's progress sidecar and hands what it
	 * read to the cell. Deliberately narrow: only a cell that is still
	 * RUNNING accepts it, so an observation can never overwrite a real
	 * result, and an unchanged read costs no frame at all (a poller
	 * fires far more often than the output changes).
	 *
	 * This adds no event and no durable state. The text lands in the
	 * cell's live rendering and is replaced wholesale by the tool's own
	 * result at settle — which is the only text anything else ever reads.
	 */
	toolProgress(callId: string, text: string): void {
		if (!this.#isActive()) return; // the pipe path has no live region
		const cell = this.#toolCell(callId);
		if (cell === null || cell.kind !== "tool" || cell.state !== "running" || cell.done) return;
		if (cell.resultText === text) return;
		cell.resultText = text;
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

	toolResult(callId: string, result: { content: string; isError: boolean; reason?: string | null }): void {
		const call = this.#pendingCalls.get(callId);
		if (call !== undefined) {
			call.result = result;
			this.#lastTool = { name: call.name, input: call.input, result };
			this.#pendingCalls.delete(callId);
		}
		if (!this.#isActive()) {
			// W19: the pipe path renders the SAME pinned deny row (the
			// reason in the W4 parentheses idiom), byte-clean — plus the
			// folded [result ✗] body below (never hide information).
			const p = palette();
			this.#write(
				`${renderToolSummary(call?.name ?? "?", call?.input ?? {}, result, result.reason ?? null)}\n` +
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
			cell.reason = result.reason ?? null;
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
		// W14: the text's arrival RELEASES the fold-hold — the turn now
		// has text, its held cells commit individually (with the W13
		// rollups; the fold is only for the QUIET turn).
		const turn = this.#turns[this.#turns.length - 1];
		if (turn !== undefined) turn.hasText = true;
		// R3b: text CLOSES the open segment. This is the boundary design.md
		// §8 names — "folding at every text boundary changes what commits
		// and when" — and it is the whole mechanism: a segment is what sits
		// between two of these.
		closeSegment(turn, Date.now());
		// TUI2-MD ⑤: assistant body text is MARKDOWN, scanned as it
		// streams. The scanner yields CLOSED blocks (final source, final
		// render) and one OPEN tail block; each becomes a cell, and the
		// cell is the commit unit the compositor already had — so
		// block-freeze needs no new commit machinery at all. A closed
		// block is a DONE cell the natural loop freezes; the tail is the
		// one cell left live, repainting in place.
		if (this.#md === null) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			this.#md = new MdStream();
			this.#mdBase = this.#cells.length;
		}
		this.#md.push(text);
		this.#syncMd();
		this.#mark();
	}

	/** TUI2-MD ⑤ — mirror the scanner's blocks onto cells. Append-only by
	 *  construction: a block that has closed never changes, so a cell that
	 *  is done is never touched again (and a committed one could not be).
	 *  Only the trailing tail cell is rewritten per delta. */
	#syncMd(): void {
		if (this.#md === null) return;
		const blocks = this.#md.blocks();
		const closed = this.#md.closed();
		for (let i = 0; i < blocks.length; i += 1) {
			const at = this.#mdBase + i;
			const cell = this.#cells[at];
			if (cell === undefined) {
				this.#cells.push({ kind: "md", block: blocks[i]!, done: i < closed });
				continue;
			}
			if (cell.kind !== "md" || cell.done) continue;
			cell.block = blocks[i]!;
			cell.done = i < closed;
		}
		// the tail can vanish (a lone whitespace delta that turns out to be
		// a blank line). Drop it only where dropping is safe: never below
		// the commit frontier, where the bytes are already the terminal's.
		const want = this.#mdBase + blocks.length;
		while (this.#cells.length > Math.max(want, this.#committed) && this.#cells[this.#cells.length - 1]!.kind === "md") this.#cells.pop();
	}

	/** TUI2-MD ⑤ — the message ends: the tail block closes and every md
	 *  cell of this message is final. */
	#endMd(): void {
		if (this.#md === null) return;
		this.#md.end();
		this.#syncMd();
		for (let i = this.#mdBase; i < this.#cells.length; i += 1) {
			const cell = this.#cells[i]!;
			if (cell.kind === "md") cell.done = true;
		}
		this.#md = null;
	}

	textEnd(): void {
		if (!this.#isActive()) {
			this.#write("\n");
			return;
		}
		this.#endMd();
		this.#mark();
	}

	/** W14 — the turn boundary's END: the CLI calls this at the run's
	 *  terminal event, once per run, BEFORE the recap (so the fold line
	 *  commits before the recap in the cell order). `thoughtSeconds` is
	 *  the CLI's wall-clocked thinking window. The QUIET turn (ended, no
	 *  text) releases its held cells as the ONE fold line; a turn with
	 *  text releases them as individual commits (the W13 rollups). The
	 *  release is LAZY — the held cells commit at the next frame, when
	 *  the fold/rollup decision runs. */
	endTurn(thoughtSeconds: number): void {
		if (!this.#isActive()) return;
		const turn = this.#turns[this.#turns.length - 1];
		if (turn === undefined || turn.ended) return;
		turn.ended = true;
		turn.thoughtSeconds = thoughtSeconds;
		// R3b: the settle closes the last open segment — the turn's end is
		// a boundary exactly as a text block is.
		closeSegment(turn, Date.now());
		// W20: the turn's live task block settles HERE — the ONE recap
		// block for the turn ("`task done · N items · <duration>", the
		// duration clocked compositor-side from the block's first call —
		// the CLI stays unchanged). A turn that never touched the list has
		// no live block — nothing settles. Newest-first: the live block is
		// the newest cell of its turn.
		for (let i = this.#cells.length - 1; i >= 0; i -= 1) {
			const c = this.#cells[i]!;
			if (c.kind === "checklist" && !c.done) {
				c.done = true;
				c.durationSeconds = Math.max(0, Math.round((Date.now() - c.startedAt) / 1000));
				break;
			}
		}
		// R3g (fable D3, 2026-08-28): an INTERRUPTED tool never receives a
		// result, so its cell stays `done: false` — and the commit loop
		// stops at the first cell that is not done. One esc mid-tool
		// therefore parked the commit pointer for the REST of the
		// session: every later turn's rows piled up in the live region
		// and only ever left it through the force-commit cap. The turn's
		// end is the boundary that closes them, exactly as it closes an
		// open thinking cell. `reason` is set so the row keeps its words
		// AND so #segmentHasTrouble holds the turn unfolded — an
		// interruption is trouble, and law 1.3 says trouble is never
		// summarised away.
		for (const c of this.#cells) {
			if (c.kind === "tool" && !c.done) {
				c.state = "done";
				c.reason = "interrupted";
				c.doneAt = Date.now();
				c.done = true;
			}
		}
		// the QUIET turn: an open thinking cell closes at the boundary —
		// its natural closer is the text's arrival (never comes here — the
		// text-less turn), so without this the fold could never commit AT
		// it (the commit loop only takes done cells — the fold would stall
		// forever behind the live thinking).
		for (let i = this.#cells.length - 1; i >= 0; i -= 1) {
			const c = this.#cells[i]!;
			if (c.kind === "thinking" && !c.done) {
				c.done = true;
				this.#lastThinking = c.text;
				break;
			}
		}
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

	/** W20 — the task checklist as STATE, not events: the FIRST call of a
	 *  turn creates the ONE live block (done:false — the commit loop only
	 *  takes done cells, so it stays in the live region); later calls of
	 *  the SAME turn MUTATE that block in place — same position, same
	 *  height, zero committed rows (the W8 fixed-window rule generalised
	 *  to state). An unchanged whole-table replace (the task extension's
	 *  idempotent shape) is a no-op — no mark, no frame. The block commits
	 *  ONCE at the turn's end (endTurn); the next turn's first call starts
	 *  a fresh block — one settled block per turn that touched the list,
	 *  never one per update. The pipe path stays per-call (byte-linear —
	 *  every write is final; there is no in-place redraw in a pipe). */
	checklist(header: string, items: { text: string; status: "pending" | "active" | "done" }[]): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const p = palette();
			this.#write(`${p.bold}✦${p.reset} ${escapeTerminal(header)}\n`);
			const glyphOf = (status: string): string => (status === "pending" ? "□" : status === "active" ? "▖" : "▣");
			for (const item of items) this.#write(`  ${glyphOf(item.status)} ${escapeTerminal(item.text)}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		const turn = this.#turns.length - 1;
		const last = this.#cells[this.#cells.length - 1];
		if (last !== undefined && last.kind === "checklist" && !last.done && last.turn === turn) {
			// TV-1B: the header participates in the change detection — the
			// settle verdict is a header-only update over the same items,
			// and an items-only guard would swallow it silently.
			if (last.header !== header || !sameTask(last.items, items)) {
				Object.assign(last, { header, items });
				this.#mark();
			}
			return;
		}
		this.#cells.push({
			kind: "checklist",
			header,
			items,
			done: false,
			expanded: false,
			startedAt: Date.now(),
			durationSeconds: 0,
			turn,
		});
		this.#mark();
	}

	/** The startup banner (W1): a LIVE cell — the tier re-derives per
	 *  frame (bannerLines with the CURRENT W and H), so a resize re-tiers
	 *  the art instead of re-folding frozen rows (a window below 40 cols
	 *  never paints the logo). W5: the resume metas ride the cell — the
	 *  list re-gates with the tier (BIG only) and re-times with the
	 *  frame. The inactive path keeps the historical bytes (no resume —
	 *  the pipe contract). */
	banner(version: string, extensionsText: string, resume: ResumeMeta[] = [], meta?: BannerMeta | undefined): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			const W = this.#opts.width() || 80; // a 0-size pty falls back
			const H = this.#opts.height();
			const p = palette();
			for (const r of bannerLines(W, H, version, extensionsText, [], Date.now(), meta)) this.#write(`${p.dim}${r}${p.reset}\n`);
			this.#write("\n");
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "banner", version, extensionsText, resume, meta, done: true });
		this.#mark();
	}

	raw(lines: string[], wrap?: "words"): void {
		if (!this.#isActive()) {
			this.#closeOpenThinking();
			this.#closeOpenText();
			for (const line of lines) this.#write(`${line}\n`);
			return;
		}
		this.#closeOpenThinking();
		this.#closeOpenText();
		this.#cells.push({ kind: "raw", lines, done: true, ...(wrap === undefined ? {} : { wrap }) });
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

	/** W15 — the expand key's target (ctrl+o). A cell still in the LIVE
	 *  region (the newest live tool) TOGGLES in place — the compositor
	 *  owns those rows and redraws them (the body flips to the full
	 *  form, no cap). A committed cell can never toggle — history is
	 *  never rewritten (ADR-0046) — so the key APPENDS a fresh expanded
	 *  block at the bottom instead, the /last idiom aimed at a chosen
	 *  cell: the pointer cycles the collapsed history, newest first, and
	 *  the header names the target ("N turns back" — the user cells
	 *  after it), so every press tells the user what they got. */
	/**
	 * TUI2-R2 ⑤ — the cell the next ctrl+o will act on, or -1.
	 *
	 * The rule is expandNext's own first loop, extracted verbatim: the
	 * LAST live cell that can toggle. It is a separate method rather than
	 * a shared constant because the marker and the key must not merely
	 * agree today — the marker is a PROMISE about what the key will do,
	 * and the only way to keep it is to derive it from the same scan.
	 *
	 * The committed fallback (the #collapsed ring) is deliberately NOT
	 * marked: those rows are frozen history, never re-emitted, so a tint
	 * on them could not be moved when the pointer advances. A live target
	 * is the one the marker can tell the truth about.
	 */
	#focusIndex(): number {
		for (let i = this.#cells.length - 1; i >= this.#committed; i -= 1) {
			const cell = this.#cells[i]!;
			if (cell.kind === "tool" && cell.state !== "pending") return i;
			if (cell.kind === "checklist" && !cell.done) return i;
		}
		return -1;
	}

	/**
	 * R4 (C4d) — THE APPEND-ONLY RE-WRAP.
	 *
	 * The owner's report: resize the window and the reference
	 * implementation's text re-wraps to the new width while kiso's does
	 * not. It is true, and it is not a bug to be fixed — it is the price
	 * of ADR-0046, and the price is worth naming precisely.
	 *
	 * A terminal can only reflow a SOFT-wrapped line: one long logical
	 * line the terminal itself wrapped as the cursor flowed past the last
	 * column. Every row kiso commits is either painted by cursor
	 * addressing (#emitDiff) or scrolled out by a bare LF (#emitScroll),
	 * and frames run with autowrap OFF — so no byte kiso commits can ever
	 * carry a continuation flag, and nothing downstream can rejoin rows an
	 * application hard-split. That same LF is what makes the transcript
	 * the TERMINAL's: it survives kiso's death, a pipe, and tmux. A
	 * product whose transcript reflows is a product that repaints its
	 * transcript from its own memory, and that transcript dies with it.
	 *
	 * What kiso can do — and this is all it can do — is APPEND. The
	 * committed cells are still in memory; re-render them at the current
	 * width and put them at the BOTTOM, where writing is allowed. Nothing
	 * above is rewritten, so ADR-0046 holds exactly.
	 *
	 * Scoped to PROSE. Text is what reads badly at the wrong width — a
	 * paragraph folded for 120 columns and read at 60 is the complaint.
	 * Tool rows, folds and chips are short, already carry their own
	 * width ladders, and re-printing them would duplicate work the folds
	 * exist to state once.
	 */
	rewrap(): { lines: string[]; blocks: number; skipped: number } {
		const W = this.#opts.width();
		const H = this.#opts.height();
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: H };
		// two screens is the bound: enough to re-read what a resize just
		// made awkward, short enough that the append is not its own wall
		// of text. A silent cap would read as "this is all of it".
		const budget = Math.max(H, 2 * H);
		const chunks: string[][] = [];
		let rows = 0;
		let blocks = 0;
		let skipped = 0;
		for (let i = this.#committed - 1; i >= 0; i -= 1) {
			const cell = this.#cells[i]!;
			if (cell.kind !== "md") continue;
			blocks += 1;
			if (rows >= budget) {
				skipped += 1;
				continue;
			}
			const lines = cellComponent(cell).render(W, ctx);
			chunks.unshift(lines);
			rows += lines.length;
		}
		return { lines: chunks.flat(), blocks: blocks - skipped, skipped };
	}
	/* R13 — `#foldBody` retired with the segment fold: with nothing
	   folded there is no body a fold stands for. */


	// ─── R5: the transcript viewer ──────────────────────────────────
	//
	// The viewer occupies the LIVE REGION, exactly as the keys sheet
	// does. It is not the alternate buffer and never will be: while an
	// overlay is up the window is frozen, no LF is emitted, nothing
	// enters the scrollback, and the close takes the full-redraw path
	// and restores every displaced row (TUI2-R1.5 7(a), and its gate).

	/** Whether the viewer owns the live region right now. */
	viewerOpen(): boolean {
		return this.#viewer !== null;
	}

	/** ctrl+r — open on the newest fold, or close. */
	viewerToggleMode(): void {
		if (this.#viewer !== null) {
			this.#viewer = null;
		} else {
			const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
			this.#viewer = viewerInit(this.#viewerEntries(this.#opts.width(), ctx));
		}
		this.#mark();
	}

	/** The viewer's keys. Everything the surface can do, a key does —
	 *  there is no pointer, so there is nothing a pointer could reach
	 *  that a keyboard cannot. */
	viewerKey(cmd: "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end"): void {
		if (this.#viewer === null) return;
		const W = this.#opts.width();
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const entries = this.#viewerEntries(W, ctx);
		const rows = this.#viewerBandRows();
		const s = this.#viewer;
		switch (cmd) {
			case "up":
				this.#viewer = viewerMove(entries, s, -1, rows);
				break;
			case "down":
				this.#viewer = viewerMove(entries, s, +1, rows);
				break;
			case "home":
				this.#viewer = viewerMove(entries, s, -entries.length, rows);
				break;
			case "end":
				this.#viewer = viewerMove(entries, s, entries.length, rows);
				break;
			case "pageUp":
				this.#viewer = viewerScroll(entries, s, -rows, rows);
				break;
			case "pageDown":
				this.#viewer = viewerScroll(entries, s, rows, rows);
				break;
			case "toggle":
				this.#viewer = viewerToggle(entries, s, rows);
				break;
			case "all":
				this.#viewer = viewerToggleAll(entries, s, rows);
				break;
		}
		this.#mark();
	}

	/** How many rows the viewer's LIST gets: the content cap, less its
	 *  own title and hint rows. */
	#viewerBandRows(): number {
		const H = this.#opts.height();
		const W = this.#opts.width();
		const queueRows = this.#queueRows(W, H);
		const inputExtra = this.#inputRows(W, H, this.#menuRows(W).length, queueRows.length).rows.length - 1;
		return Math.max(1, H - 4 - inputExtra - queueRows.length - 2);
	}

	/**
	 * The expandable things in the transcript, oldest first.
	 *
	 * The set is `#collapsed` — the SAME ring `ctrl+o` walks — so the two
	 * mechanisms can never disagree about what is reachable. The ring is
	 * newest-first (it is unshifted on commit); reading order is the
	 * other way, so it is reversed here.
	 *
	 * Every entry is rendered at the CURRENT width, which is what makes
	 * this surface the answer to "I resized and want to re-read the
	 * history": the scrollback copy stays the immutable original at its
	 * original widths, and this is where you go to read it at today's.
	 */
	#viewerEntries(W: number, ctx: FrameCtx): ViewerEntry[] {
		const inner = Math.max(1, W - VIEWER_GUTTER);
		const out: ViewerEntry[] = [];
		for (const idx of [...this.#collapsed].reverse()) {
			const cell = this.#cells[idx];
			if (cell === undefined) continue;
			// R13 — the viewer's FOLD entry retired with the fold: every
			// entry is now a card, and a card's entry is its own full body.
			if (cell.kind !== "tool") continue;
			// the tool card's FULL body — the same rows its own ctrl+o
			// opens. The expanded flag is saved and restored inside this
			// synchronous call, the pattern the rollup path has always
			// used for head.rolled; it never outlives the render, so the
			// committed geometry #committedLines derives can never see it.
			const saved = cell.expanded;
			cell.expanded = true;
			const rows = cellComponent(cell).render(inner, ctx);
			cell.expanded = saved;
			out.push({ head: rows[0] ?? "", body: rows.slice(1) });
		}
		return out;
	}

	/** The viewer's band: its title, its list, its keys. */
	#viewerBand(W: number): string[] {
		if (this.#viewer === null) return [];
		const p = palette();
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const entries = this.#viewerEntries(W, ctx);
		const rows = this.#viewerBandRows();
		const title = viewerTitle(entries);
		const shown = viewerRows(entries, this.#viewer, W, rows);
		const flat = viewerFlat(entries, this.#viewer).length;
		const more = flat > rows ? ` · ${this.#viewer.top + 1}-${Math.min(flat, this.#viewer.top + rows)} of ${flat}` : "";
		// the rule is MEASURED, not over-generated and cut — a title row
		// ending in `…` says the title was truncated, which it was not.
		const label = `── ${escapeTerminal(title)}${more} `;
		const fill = "─".repeat(Math.max(0, W - visibleWidth(label)));
		return [
			cutLine(`${p.dim}${label}${fill}${p.reset}`, W),
			...shown,
			cutLine(`${p.dim} ${viewerHint(this.#viewer, entries)}${p.reset}`, W),
		];
	}

	/** DC-35 — the last block this key appended, and the cell count when
	 *  it did. An expansion earns its rows by showing something the
	 *  transcript does not already END with. */
	#lastAppend: { lines: string; atCells: number } | null = null;

	/**
	 * DC-35 — ctrl+o does not print the same expansion twice in a row.
	 *
	 * The ring walks newest-back and restarts its cycle once every entry
	 * has been opened (R4/C1, which is what makes the walk immune to the
	 * ring growing underneath it). With a ring of ONE the restart is
	 * immediate, so holding the key appended the identical block over
	 * and over — the owner got three copies of the same four rows, each
	 * closing with `ctrl+o opens the one before it`, a footer naming
	 * something that does not exist.
	 *
	 * The bar is the BOTTOM of the transcript, not "ever shown": once
	 * other content has arrived the expansion has scrolled up and
	 * re-opening it is the point of the key, so the guard clears itself
	 * the moment a cell is added.
	 */
	expandNext(): { kind: "toggled" } | { kind: "appended"; lines: string[] } | { kind: "none"; why?: "already-last" } {
		const out = this.#expandNextRaw();
		if (out.kind !== "appended") return out;
		const lines = out.lines.join("\n");
		if (this.#lastAppend !== null && this.#lastAppend.lines === lines && this.#lastAppend.atCells === this.#cells.length) {
			// NOT the same answer as "nothing is folded". The caller says
			// which, because a reader who pressed the key deserves to know
			// whether there is nothing to open or whether they are already
			// looking at it.
			return { kind: "none", why: "already-last" };
		}
		this.#lastAppend = { lines, atCells: this.#cells.length };
		return out;
	}

	#expandNextRaw(): { kind: "toggled" } | { kind: "appended"; lines: string[] } | { kind: "none" } {
		for (let i = this.#cells.length - 1; i >= this.#committed; i -= 1) {
			const cell = this.#cells[i]!;
			if (cell.kind === "tool" && cell.state !== "pending") {
				cell.expanded = !cell.expanded;
				this.#mark();
				return { kind: "toggled" };
			}
			// W20: the LIVE task block toggles in place too — the capped
			// form flips to the full list (the "done-collapse expands
			// under ctrl+o" claim). The SETTLED block is already full —
			// no toggle, and its rows carry no affordance, so it never
			// joins #collapsed (the committed /last append is moot).
			if (cell.kind === "checklist" && !cell.done) {
				cell.expanded = !cell.expanded;
				this.#mark();
				return { kind: "toggled" };
			}
		}
		if (this.#collapsed.length === 0) return { kind: "none" };
		// R4 (C1) — the newest entry this cycle has not opened yet. When
		// every entry has been seen the cycle restarts, so the walk is
		// still "newest back" — it is simply immune to the ring growing
		// underneath it.
		if (this.#collapsed.every((i) => this.#opened.has(i))) this.#opened.clear();
		const idx = this.#collapsed.find((i) => !this.#opened.has(i)) ?? this.#collapsed[0]!;
		this.#opened.add(idx);
		const cell = this.#cells[idx]!;
		// R3b — a folded SEGMENT expands to the work it stands for.
		//
		// The fold line collapses a run of thinking and tool cells into
		// one row; without this the run would be unreachable, which is
		// hiding a durable record behind a summary. The rows are APPENDED
		// (ADR-0046 — history is never rewritten), exactly as every other
		// expand in this method does, and they are the cells' OWN renders,
		// so the expansion cannot drift from what was folded.
		// R13 — expandNext's FOLD branch retired with the segment fold.
		// A fold line collapsed a run of cells into one row, so the key had
		// to be able to open the run; with every call standing as its own
		// card there is nothing collapsed for it to open, and `#collapsed`
		// now holds cards alone.
		if (cell.kind !== "tool") return { kind: "none" };
		// R13 — and the ROLLUP branch retired with `rolled`.
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(cell.inputFull) as Record<string, unknown>;
		} catch {
			// the full JSON is always parseable (it was stringified at
			// toolStart) — the empty fallback never fires
		}
		const turnsBack = this.#cells.slice(idx + 1).filter((c) => c.kind === "user").length;
		const p = palette();
		const header = `${p.bold}✦${p.reset} expanded · ${escapeTerminal(`${displayVerb(cell.name)} ${toolTarget(cell.name, input)}`)} · ${turnsBack} ${turnsBack === 1 ? "turn" : "turns"} back`;
		return {
			kind: "appended",
			lines: [
				header,
				// TUI2-R2pre ④: the SECTION HEADERS say the act; the payloads
				// below them (inputFull, resultText) are RAW and byte-identical.
				`--- ${displayVerb(cell.name)} input ---`,
				cell.inputFull,
				`--- ${displayVerb(cell.name)} output${cell.isError ? " (error)" : ""} ---`,
				cell.resultText,
			],
		};
	}

	// ---- the Dock façade (the CLI's chrome API — same shape as the old dock) ----

	/** Docked = the chrome is live (a color TTY with a real size). */
	get active(): boolean {
		return this.#docked && this.#isActive();
	}

	/** TUI2-R2pre ③ — the ONE place a resize listener is installed, and it
	 *  removes the previous one first. `process.stdout` is process-wide and
	 *  its listeners outlive the object that added them, so "add" without
	 *  "remove first" is a leak by construction: the old closure is
	 *  unreachable the moment #resizeHandler is overwritten, and not even
	 *  exit() can take it off. */
	#attachResize(): void {
		this.#detachResize();
		this.#resizeHandler = () => this.onResize();
		process.stdout.on("resize", this.#resizeHandler);
	}

	#detachResize(): void {
		if (this.#resizeHandler === null) return;
		process.stdout.off("resize", this.#resizeHandler);
		this.#resizeHandler = null;
	}

	enter(): void {
		const rows = process.stdout.rows ?? 0;
		if (process.stdout.isTTY !== true || palette().bold === "" || rows < 4) return;
		this.#docked = true;
		this.#guardOutput();
		// REL-0152-D19: RELEASE the terminal we were handed, before the
		// first frame.
		//
		// The dock resets on the way OUT and reset nothing on the way IN,
		// so every session began in whatever state the previous occupant
		// left. For THIS product that is not an edge case: kiso's claim is
		// that it survives kill -9, which makes "the last instance died
		// without running its teardown" a supported and advertised way to
		// arrive here.
		//
		// Both of these confine writes to a SUB-REGION of the screen,
		// which is the only way content can survive at a column the dock
		// paints — every chrome row is exactly W wide and written from
		// column 1, so an erase plus a W-wide write covers the row end to
		// end unless the write cannot reach the ends.
		//
		//   ESC[r     the scroll region back to the whole screen
		//   ESC[?69l  left/right margin mode OFF (DECLRMM) — ESC[r does
		//             NOT release margins, which is why resetting only the
		//             region on exit was never enough
		//
		// And two that a KILLED kiso leaves set, which REL-0152-D14
		// introduced and this is the first thing to defend against it: a
		// frame turns autowrap off and the cursor invisible and restores
		// both at its end, so a process that dies BETWEEN those two points
		// hands the shell — and the next kiso — a terminal with wrapping
		// off and no cursor. `kill -9` cannot be caught, so the entry is
		// the only place this can be repaired, and a product whose claim
		// is that it survives kill -9 has to repair it there.
		//
		//   ESC[?7h   autowrap back to its default
		//   ESC[?25h  the cursor visible again
		//
		// Idempotent, sixteen bytes, once per session, and correct whether
		// or not anything was actually left set.
		this.#needsReset = true;
		this.#attachResize();
		this.#fullRedraw = true;
		this.#dirty = true;
		this.render(); // the FIRST frame — the full-redraw path, no pre-clear
	}

	/** Teardown — CSI r (the "no broken terminal" contract byte), the
	 *  chrome rows cleared, the cursor home at the input line. */
	exit(): void {
		this.#unguard?.();
		// REL-0152-D18: a drag in flight must not repaint into a torn-down
		// dock — the timer outlives the compositor otherwise.
		if (this.#resizeTimer !== null) {
			clearTimeout(this.#resizeTimer);
			this.#resizeTimer = null;
		}
		this.#resizePending = false;
		// TUI2-R3v2 ②: the mouse disable rides the SAME teardown as CSI r,
		// and rides it BEFORE the docked guard — an un-docked compositor is
		// exactly the state a superseded or half-torn-down one is in, and
		// that is when a leak survives. The editor disables it too; this is
		// the second belt on the one contract the round calls blocker-class.
		//
		// TTY-GATED, and the gate is not a nicety. A pipe has no mouse mode
		// to reset, so the bytes would be pure noise there — and the pipe
		// path is byte-identical by ruling. The unguarded version put
		// "[?1000l[?1006l" into piped stdout and four gates caught it
		// (compact-cli, tui-modes, tui-v7-planmode, tui2-r2-resume-picker):
		// the invariant is about terminals, and a pipe is not one.
		// REL-0152-D14: autowrap goes back on with the mouse, and for the
		// same reason — the terminal outlives kiso, and a mode kiso turned
		// off inside a frame must never be what the shell inherits. The
		// frame restores it itself; this is the second belt, on the same
		// TTY gate, because a half-torn-down compositor is exactly where a
		// mode leak survives.
		if (process.stdout.isTTY === true) this.#write(`${MOUSE_OFF}\x1b[?7h`);
		if (!this.#docked) {
			// TUI2-R2pre ③: an un-docked compositor can still hold a listener
			// (it was superseded, or enter() ran and the dock was torn down by
			// another path) — the teardown is unconditional, the CHROME clear
			// below is not.
			this.#detachResize();
			return;
		}
		this.#docked = false;
		this.#detachResize();
		const H = this.#lastH > 0 ? this.#lastH : process.stdout.rows ?? 24;
		const out: string[] = [];
		out.push("\x1b[r");
		// V6-3 + KC1: the chrome rows — the RECORDED composer extent rides
		// the same mechanism the resize clear already uses (N = 1 ⇒ H−3..H)
		for (let row = H - 2 - this.#lastInputRows; row <= H; row += 1) {
			out.push(`\x1b[${row};1H\x1b[0K`); // clear the chrome rows
		}
		out.push(`\x1b[${Math.max(1, H - 1)};1H`);
		this.#write(out.join(""));
	}

	/**
	 * REL-0152-R1 — the compositor is not the only writer, and a diff has
	 * to know.
	 *
	 * The old renderer repainted every row of every frame, so anything
	 * else that printed to the terminal was corrected within one frame
	 * and nobody had to think about it. A diff writes only what changed,
	 * so an outside write leaves the held screen describing a terminal
	 * that no longer exists — and the next frame skips exactly the rows
	 * it should have repaired.
	 *
	 * That is not hypothetical: a bare `console.log` in the CLI's boot
	 * path prints the faux-mode notice with a trailing newline, which
	 * SCROLLS the terminal two rows while the dock is up. The chrome then
	 * sits two rows above where the model puts it, the diff sees no
	 * change, and the cursor parks on the wrong row. Three PTY gates
	 * caught it.
	 *
	 * REL-0152-D17: BOTH descriptors, and the second one is the one that
	 * mattered. The first version of this guard wrapped stdout alone,
	 * while kiso's degradation notices go to stderr through
	 * `console.error` — and several of them BEGIN with `[` and contain
	 * `]`:
	 *
	 *     [extensions] …        [project .kiso] …
	 *     [KISO_FAUX_SCRIPT] …  [run failed] …
	 *
	 * Those land on the tty wherever the cursor is, and a renderer that
	 * does not know they were printed skips exactly the rows that would
	 * repair them. The residue survives on the rows whose desired content
	 * NEVER changes — the composer box's own edges — which is a stray `[`
	 * at the left and `]` at the right for the rest of the session,
	 * clearing only on a resize and returning on the next launch.
	 *
	 * The reasoning that missed it was mine, and it is worth keeping: the
	 * renderer emits no OSC and no bare `]`, so a `]` on screen CANNOT
	 * have come from its stream. I had that fact and concluded "therefore
	 * the terminal invents it" when the only sound conclusion is
	 * "therefore something else wrote it".
	 *
	 * The fix is not a list of writers to remember, and not silencing the
	 * loggers. A compositor cannot hold a belief about a terminal it does
	 * not own: any write it did not make forgets the screen, whichever
	 * descriptor carried it. New callers cannot get it wrong because they
	 * are not asked to get it right.
	 */
	#guardOutput(): void {
		if (this.#unguard !== null || this.#opts.write !== undefined) return;
		const restores: (() => void)[] = [];
		for (const stream of [process.stdout, process.stderr]) {
			const real = stream.write.bind(stream);
			const patched = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
				if (!this.#inFrame) this.#screen = [];
				return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
			}) as typeof stream.write;
			stream.write = patched;
			restores.push((): void => {
				// only restore what we installed — another wrapper may have
				// been layered on top since (the byte trace does exactly that)
				if (stream.write === patched) stream.write = real;
			});
		}
		this.#unguard = (): void => {
			for (const r of restores) r();
			this.#unguard = null;
		};
	}

	/** TUI2-R3v2 ②: the panel's option rows as this frame placed them —
	 *  absolute, 1-based. The click hit-test's single source. */
	panelOptionRows(): { top: number; count: number; first: number } | null {
		return this.#panelRowSpan;
	}

	/** SIGWINCH: clear the OLD live area (recorded geometry, ED only —
	 *  zero LF, zero \x1b[3J — the shell history untouched), then the
	 *  full-redraw path at the NEW geometry (O(height), zero replay).
	 *  The clear starts at the ON-SCREEN live top (the bottom-anchored
	 *  live region's first row) — NEVER at the formula's committed-count
	 *  top: external writes (the CLI's console.error CRLF) can shift the
	 *  committed content down, and a formula-top ED0 would clear it. */
	/**
	 * REL-0152-D18 — a window DRAG is one resize, not forty.
	 *
	 * SIGWINCH fires continuously while a drag is in progress — every few
	 * pixels is another signal — and this used to answer each one at once
	 * with an erase and a full repaint. A real terminal REFLOWS on a width
	 * change and pushes the rows it displaces into its scrollback, so
	 * every one of those repaints deposited another copy of the screen
	 * into the history. The owner's two-second drag left six identical
	 * copies of the same tool block in the transcript.
	 *
	 * Nothing clever can undo that afterwards: the scrollback is not ours
	 * to rewrite. The only fix is to not paint into the middle of a drag.
	 *
	 * The geometry is adopted IMMEDIATELY — every cap and bound is read
	 * from `#opts` at frame time, so the model is already at the new size
	 * and nothing is computed against a stale width. What waits is the
	 * PAINT. When the signals stop, one erase and one repaint.
	 *
	 * The competitor does not have this problem, for a structural reason
	 * worth naming rather than envying: it runs on the alternate screen,
	 * which has no scrollback to accumulate into. kiso is on the primary
	 * screen deliberately — the transcript IS the terminal's own
	 * scrollback, which is the product's whole claim — so it pays for
	 * that choice here, and has to pay carefully.
	 */
	onResize(): void {
		if (!this.#isActive()) return;
		this.#resizePending = true;
		if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
		this.#resizeTimer = setTimeout(() => {
			this.#resizeTimer = null;
			this.#settleResize();
		}, RESIZE_SETTLE_MS);
		if (this.#resizeTimer.unref !== undefined) this.#resizeTimer.unref();
	}

	/**
	 * DC-3 — the ground arrived, so every colour on the held screen is
	 * stale.
	 *
	 * The terminal answers `OSC 11` a few milliseconds after startup, by
	 * which time the first frame is already painted with the no-ground
	 * palette. Rather than delay the opening to wait for an answer that
	 * may never come, the frame is painted at once and repainted when the
	 * answer lands. Invalidating the held screen is exactly what a resize
	 * does, for exactly the same reason — every row's bytes are wrong —
	 * so it rides the settle the resize already owns and costs one
	 * repaint, once per session.
	 */
	onGroundChange(): void {
		this.#screen = [];
		this.onResize();
	}

	/** The one repaint a drag earns, once its signals have stopped. */
	#settleResize(): void {
		if (!this.#resizePending || !this.#isActive()) return;
		this.#resizePending = false;
		const H = this.#opts.height();
		const liveRows = this.#lastLiveRows > 0 ? this.#lastLiveRows : 3;
		const from = Math.max(1, (this.#lastH > 0 ? this.#lastH : H) - liveRows + 1);
		this.#write(`\x1b[${Math.min(from, Math.max(1, H))};1H\x1b[0J`);
		this.#fullRedraw = true;
		this.#resizeFrame = true;
		this.#dirty = true;
		this.render();
	}

	/** W18: the status row's right-aligned hint is part of the status
	 *  state — the compacting row passes "esc to cancel" (the affordance
	 *  must survive repaints). */
	setStatus(text: string, hint: string | null = null): void {
		this.#status = text;
		this.#statusHint = hint;
		this.redraw();
	}

	setTail(tail: string): void {
		this.#tail = tail;
		this.redraw();
	}

	/** The status row's source — W21: while a panel is up, the panel's
	 *  phase status + affordance REPLACE the CLI's painting status (the
	 *  compositor derives both from the bound panel state; the old
	 *  question slot's dim-pending shape is the normal branch's shape
	 *  now). */
	#statusSource(): { status: string; hint: string | undefined } {
		const panel = this.#panelState?.() ?? null;
		// DC-38: the panel's STATUS replaces the CLI's painting status —
		// that half of W21 stands. The HINT does not come with it, because
		// the panel block already ends in its own affordance row and has
		// since TUI2-R1.5 ("the affordance — the phase's key hint, ONE
		// row"). Both sites read `panelAffordance`, neither knew about the
		// other, and an approval at W≥100 printed the same 48-cell sentence
		// twice, six rows apart.
		//
		// The block's copy is the one to keep, on two grounds. It sits next
		// to the options it names. And it never disappears: the status row
		// drops its hint when the left text plus the hint will not fit, so
		// the duplicate was width-dependent — one copy on an ask (long left
		// text), two on an approval (`❯ run paused`, twelve cells) — which
		// is why every fixed-width gate was blind to it. Each flavour's
		// block carries its own row (approval-panel.ts pushes it for the
		// approval and the pick, ask-panel.ts for the ask), so nothing is
		// lost anywhere.
		if (panel !== null) return { status: panelStatusOf(panel), hint: undefined };
		// W22: while turns wait in the queue, the right hint shows the
		// count — the chips below carry the lines themselves.
		const queued = this.#queueState?.().length ?? 0;
		if (queued > 0) return { status: this.#status, hint: `+${queued} queued` };
		return { status: this.#status, hint: this.#statusHint ?? undefined };
	}

	/** Bind the editor's panel state — the PanelSelect slot occupant
	 *  (W21: the panel replaces the live region + the input lead while
	 *  up; the old ApprovalPrompt's question slot retires with it). */
	bindApproval(state: () => PanelState | null): void {
		this.#panelState = state;
	}

	/** Bind the CURRENT input line's state — the focus component reads it. */
	bindInput(state: () => InputState, prompt: string): void {
		this.#inputState = state;
		this.#inputPrompt = prompt;
	}

	/** Bind the editor's slash-command menu state — the MenuSelect slot
	 *  occupant (the menu replaces the editor's view while open). */
	/** TUI2-R1 (D): bind the editor's keys-sheet flag. */
	bindSheet(state: () => boolean): void {
		this.#sheetState = state;
		this.#mark();
	}

	bindMenu(state: () => { items: readonly MenuItem[]; selected: number } | null): void {
		this.#menuState = state;
	}

	/** KC3 §4: bind the editor's @ file picker. It shares the menu's
	 *  band — see #menuRows for why that is a decision and not a
	 *  shortcut. */
	bindAt(state: () => AtPanelState | null): void {
		this.#atState = state;
	}

	/** TUI2-R2 ②: bind the editor's session picker — the band's third
	 *  occupant (see #menuRows for why they share one). */
	bindPick(state: () => SessionPickState | null): void {
		this.#pickState = state;
	}

	/** Bind the pending-turn queue — the CLI's live slots (chat.ts):
	 *  the chips render in the menu-rows family, the live caps shrink
	 *  by their rows, and the +N queued hint rides the status row. */
	bindQueue(state: () => readonly string[]): void {
		this.#queueState = state;
	}

	/** The input line's edit column — the old dock's API. v6: the CURSOR
	 *  derives from the frame's marker; this is the same value computed
	 *  from the bound input state (the CLI's BodyOptions.editCol callback
	 *  reads it — the marker math never desyncs by construction). */
	editCol(): number {
		const st = this.#inputState();
		const panel = this.#panelState?.() ?? null;
		// W23: the frame-derived column — wallL + leadWidth(lead) + cells
		// + 1 — the SAME formula the marker embeds at (the panel lead when
		// the panel owns the row; the old prompt-only math desynced the
		// panel rows' edit column; leadWidth is the ONE authority).
		// R2: wallL is 0 — the box is retired, so the row starts at column
		// one and the frame's marker and this formula share the constant.
		const lead = panel !== null ? panelLeadOf(panel) : this.#inputPrompt;
		return 1 + leadWidth(lead) + st.cursor;
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
		}, this.#frameMs);
		this.#frameTimer.unref();
	}

	/**
	 * The spinner: a ONE-SHOT re-armed ONLY while something is MOVING —
	 * nothing moving → no timer → zero bytes (the #14/#15 contract,
	 * structural).
	 *
	 * R3: "moving" used to mean a running TOOL and nothing else. But the
	 * same counter drives the status row's `working` twinkle, and the
	 * model spends whole stretches thinking with no tool open at all —
	 * so the one indicator whose entire job is "I am still alive" froze
	 * solid exactly when the user most needed it to move. It was
	 * reported as "I thought it had failed", which is precisely the
	 * message a frozen liveness mark sends.
	 *
	 * An OPEN THINKING cell counts as movement now, and so does a tool
	 * parked at an approval — that one is waiting on a human rather than
	 * working, but the mark is still the proof the process is alive.
	 */
	#armSpinner(): void {
		if (this.#spinnerTimer !== null) return;
		this.#spinnerTimer = setTimeout(() => {
			this.#spinnerTimer = null;
			const moving = this.#cells.some(
				(c) =>
					(c.kind === "tool" && (c.state === "running" || c.state === "approval") && !c.done) ||
					(c.kind === "thinking" && !c.done),
			);
			if (moving) {
				this.#spinnerI = (this.#spinnerI + 1) % MOTION_FRAMES;
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

	/**
	 * R3i phase 2 — THE LIVE PROJECTION.
	 *
	 * One definition, called from the natural path and from inside the
	 * force-commit loop, because two copies of "what the live region
	 * looks like" is two answers to one question.
	 *
	 * The change this phase makes, and the ONLY one: the cells of the
	 * OPEN stretch no longer each hold a row. The stretch is one line —
	 * the same line the settle will keep, in the present tense — plus
	 * the calls actually in flight. A completed call renders nothing;
	 * its count rides the line.
	 *
	 * What it fixes: a 28-call turn used to spend 28 rows of a 30-row
	 * live region, so overflow was the NORM on real turns rather than
	 * the edge — and a turn that overflows may not fold (R3f: a line
	 * cannot claim rows already in the scrollback), which is why the
	 * fold missed exactly the turns it exists for. The block's height
	 * no longer depends on the call count at all.
	 *
	 * What it does NOT change: nothing about what commits or when. The
	 * hold is untouched, the force-commit cap is untouched, and the
	 * settle still produces the same fold it did before. That is the
	 * charter's line between this phase and the next.
	 */
	/**
	 * R13 / DC-43 — THE ROOM THE COMMITTED ROWS LEAVE.
	 *
	 * The live region must fit in what is left of the window after the
	 * rows already committed, because that is what keeps the window's top
	 * MONOTONE: `skip` is read off the total height, and if the live part
	 * can push the total over H then a settle that shrinks it pulls the
	 * total back under, the top falls, and every row on screen slides
	 * down by the difference. R4's standing slot bought monotonicity by
	 * never letting the live region shrink at all; R13 retires the slot,
	 * so the same property has to come from the other side — the live
	 * region gives way, and `skip` then depends only on `#committedLines`,
	 * which only ever grows.
	 *
	 * The floor is ONE row: where the committed rows alone fill the
	 * screen there is nothing left to give, and `skip` grows with them —
	 * monotonically, which is all the invariant asks.
	 */
	#liveRoom(H: number, inputExtra: number, queueRows: number): number {
		return Math.max(1, H - CHROME_ROWS - inputExtra - queueRows - this.#committedLines);
	}

	#liveProjection(W: number, ctx: FrameCtx, cap?: number): string[] {
		const rows = this.#project(W, ctx, LIVE_WINDOW);
		if (cap === undefined || rows.length <= cap) return rows;
		// DC-43 / R13 E2 — THE WINDOW SHRINKS TO THE ROOM, one row at a
		// time, before any cell is force-committed. A running card that
		// could overflow the content cap would make the force-commit loop
		// push REAL cells into the scrollback to relieve rows that are, at
		// the bottom of a card's window, blank padding. So the cards give
		// way first, down to a single preview row, and then to their head
		// rows alone — the one form that fits anywhere.
		//
		// Committed cards are never trimmed: this is the LIVE projection,
		// and a row in the scrollback is final (§7.1).
		for (let n = LIVE_WINDOW - 1; n >= 1; n -= 1) {
			const tighter = this.#project(W, ctx, n);
			if (tighter.length <= cap) return tighter;
		}
		return this.#project(W, ctx, 0);
	}

	/**
	 * R13 — ONE PASS, AND EVERY CELL RENDERS ITSELF.
	 *
	 * DECLARED REVERSAL of R3i's stretch line, R4's standing activity
	 * slot and R6/D1's block-stands-for-the-turn, all owner-ruled on
	 * 2026-09-03 and all of them the same idea: the open stretch drew ONE
	 * line plus a fixed slot, and every other cell of the segment drew
	 * nothing, so the live region's height was independent of the call
	 * count. That was the answer to a 28-call turn spending 28 rows of a
	 * 30-row region.
	 *
	 * The card answers it differently, and the ruling prefers this
	 * answer: a running call is its own card at a FIXED height (E2), so
	 * the height is a function of how many calls are IN FLIGHT rather
	 * than of how many have happened — and the window shrinks to the room
	 * before anything is force-committed (above). The live form and the
	 * committed form are now the same form, which is what makes a settle
	 * a change of content and never of position.
	 *
	 * What this keeps from R4: the height never moves ON ITS OWN. What it
	 * gives up: the one-line summary of a stretch, which the owner ruled
	 * costs more than it buys.
	 */
	#project(W: number, ctx: FrameCtx, budget: number): string[] {
		const out: string[] = [];
		const focus = this.#focusIndex();
		const live: FrameCtx = { ...ctx, liveWindow: budget };
		let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
		for (let i = this.#committed; i < this.#cells.length; i += 1) {
			const rows = cellComponent(this.#cells[i]!).render(W, live);
			// the head row carries the affordance; the tint lands on it and
			// nowhere else, which is what makes "exactly one" structural
			if (i === focus && rows.length > 0) rows[0] = focusToken(rows[0]!, W);
			out.push(...this.#space(i, prev, rows));
			prev = rows;
		}
		return out;
	}

	/** R6/D1 — the turn's most recent CLOSED segment: what the block
	 *  shows in the gap between two stretches. */
	#lastClosedSegment(): SegmentRecord | null {
		const turn = this.#turns[this.#turns.length - 1];
		if (turn === undefined) return null;
		for (let i = turn.segments.length - 1; i >= 0; i -= 1) {
			const seg = turn.segments[i]!;
			if (seg.cells.some((j) => j >= this.#committed)) return seg;
		}
		return null;
	}

	/**
	 * R4 — the standing act slot's rows. EXACTLY `budget` rows in every
	 * phase, so the live region's height changes twice per stretch (once
	 * when it opens, once when it folds) instead of twice per call.
	 *
	 * The phases, in the order they are tested:
	 *  - an EXPANDED live cell outranks the slot (W15 — "the user asked
	 *    for it"): it renders in full, variable height. This is also
	 *    DC-28's cure: mid-stretch `ctrl+o` had a target it toggled and
	 *    never drew, so the press did nothing visible now and changed a
	 *    later expansion's shape;
	 *  - CALLS IN FLIGHT: one head row each within the budget, the tail
	 *    of the LAST head shown filling what is left, and the overflow
	 *    row inside the slot. The tail belongs to the last head by
	 *    construction — never call N's output under call N+1's header;
	 *  - the GAP between two calls: the call that just finished keeps its
	 *    settled head and its tail. This is the frame R3i collapsed, and
	 *    collapsing it is most of the jump;
	 *  - THINKING, before any call: the thinking's own tail (R3i ruling
	 *    5, wired at last).
	 */
	#actSlot(seg: SegmentRecord | null, W: number, ctx: FrameCtx, budget: number, focus: number): string[] {
		const tint = (i: number, rows: string[]): string[] => {
			if (i === focus && rows.length > 0) rows[0] = focusToken(rows[0]!, W);
			return rows;
		};
		// R6/D1: with no open stretch (the gap BETWEEN two of them) the
		// slot looks at the turn's last closed segment instead — the call
		// that just finished keeps its head and its tail, which is R4 B's
		// rule extended across the boundary. Cells outlive their commit,
		// so these are live repaints of live rows, never a rewrite of a
		// committed one.
		const src = seg ?? this.#lastClosedSegment();
		if (src === null) return [];
		const live = src.cells.filter((i) => i >= this.#committed);
		const tools: number[] = [];
		for (const i of live) if (this.#cells[i]?.kind === "tool") tools.push(i);
		const toolAt = (i: number): Extract<BodyCell, { kind: "tool" }> => this.#cells[i] as Extract<BodyCell, { kind: "tool" }>;

		// An APPROVAL and an EXPANSION both outrank the slot, for the same
		// reason: their height is the human's business, not the renderer's.
		// W21 gives a pending approval the live region wholesale — its
		// diff is the thing being decided about, and a diff clamped to
		// four rows is a decision made on partial evidence. W15 gives an
		// expanded cell its full body — "the user asked for it". The slot
		// exists to stop the height moving ON ITS OWN; a height a human
		// asked for is not the oscillation it was built against.
		//
		// (The approval half is a regression this round caused and its
		// gate caught: the first draft treated a pending approval as a
		// call in flight, so `❯ edit x.ts` lost its diff tail and the
		// `ctrl+o to expand` note with it.)
		const owned = tools.filter((i) => toolAt(i).expanded || toolAt(i).state === "approval");
		if (owned.length > 0) {
			// In CELL ORDER, so the frame reads the way the work happened:
			// an owned cell in full, every OTHER call still in flight
			// keeping its head row. An approval pausing one call must never
			// hide the others — the v2d parallel-frame gate caught exactly
			// that: with the shell running and asky_read at its panel, the
			// first draft returned the panel alone and the running shell's
			// `● shell sleep 1; echo hi · 1s` row vanished from the screen.
			const shown = tools.filter((i) => owned.includes(i) || !toolAt(i).done);
			const out: string[] = [];
			let heads = 0;
			for (const i of shown) {
				const rows = tint(i, cellComponent(this.#cells[i]!).render(W, ctx));
				if (owned.includes(i)) {
					out.push(...rows);
					continue;
				}
				if (heads >= LIVE_ACT_HEADS) continue;
				heads += 1;
				out.push(rows[0] ?? "");
			}
			const hidden = shown.length - owned.length - heads;
			if (hidden > 0) out.push(moreRunningRow(hidden, W));
			return out;
		}

		// R7a — ONE PATH, whether or not anything is in flight.
		//
		// There used to be two: the in-flight composition, and a
		// "last finished call plus its output" composition for the gap
		// between stretches. The moment the last call of a burst
		// returned, the block re-composed from four head rows to one
		// head and a tail — a row shorter, so on a full screen every
		// row above slid DOWN. The block is supposed to change its
		// CONTENTS, not its shape; the last call returning is not a
		// reason to redraw the stretch differently.
		if (tools.length > 0) {
			// the one-call special case is GONE: the path below draws a
			// lone running call by its own component (the W8 block
			// verbatim, which is what 0.17.0 drew) and a lone finished
			// one as its head plus its output. The special case only
			// differed once the call SETTLED, where it collapsed to the
			// bare head row — a three-row shrink the moment a single
			// call returned.
			// R7a — EVERY call of the stretch keeps its row, not just the
			// ones still in flight.
			//
			// R4 showed the in-flight calls only, so a finished one left
			// the block and its target went with it: a four-file burst
			// ended having shown four names and left none of them, while
			// the rows below shuffled up one at a time. Two complaints in
			// one — "I can't see what it read" and "the rows keep moving".
			//
			// A call now takes a row when it STARTS and changes in place
			// when it finishes: `● read x · 1s` becomes the settled head.
			// Nothing moves, every target stays, and exactly ONE row wears
			// the breathing mark — the running one — which is the mark's
			// whole job (§7.4: only the call still running carries one,
			// because only it is moving).
			//
			// The slot's fixed height is what pays for this: the rows are
			// already allocated, so the names fill blanks rather than
			// pushing anything.
			// TRUNCATION NEVER DROPS A CALL THAT IS STILL RUNNING.
			//
			// Taking the first N is wrong the moment a burst outlives the
			// slot: four reads that finished held every row while the
			// shell still running was cut, so the screen said "4 files"
			// and showed nothing of the work actually in flight. The
			// in-flight set is admitted first, then the most RECENT
			// finished calls fill what is left — newest first, because
			// the oldest is the one the eye has already read.
			const live = tools.filter((i) => !toolAt(i).done);
			const past = tools.filter((i) => toolAt(i).done);
			// WHAT IS HAPPENING NOW OUTRANKS WHAT HAPPENED. In order:
			// the in-flight rows, then that call's output when it is the
			// only one running, then the finished NAMES, newest first.
			//
			// This is the line between R3i P1 and the owner's R7a ruling,
			// which look contradictory and are not. The ruling is about a
			// parallel burst — four reads whose names vanished one at a
			// time, so the turn ended having shown four files and left
			// none of them. P1 is about a burst that is OVER and a new
			// call running: there the finished names have had their time
			// on screen and the work in flight has not. Recency decides
			// both, and neither gate has to give.
			// the lone in-flight call is drawn by its OWN component, head
			// and tail together — that is where the waiting row, VD-4's
			// never-blank-first-row rule and the shell's live window all
			// already live. Reaching past it to slotTail() lost every one
			// of them: a running shell with no output yet drew three
			// blank rows where `└ waiting for output` belongs.
			// `grouped` says "an activity line above wears the mark for
			// us". A stretch of ONE call draws no such line (R7a), so
			// there is nothing above to carry it and the head keeps its
			// own — otherwise a lone running call breathes nowhere.
			const grouped = { ...ctx, grouped: tools.length > 1 };
			const soloRows = live.length === 1 ? tint(live[0]!, cellComponent(this.#cells[live[0]!]!).render(W, grouped)) : [];
			const tailWant = Math.max(0, soloRows.length - 1);
			// the overflow row is itself a row: an in-flight set larger
			// than the slot gives one back so `+N more running` fits.
			const liveRows = live.slice(0, live.length > budget ? Math.max(1, budget - 1) : budget);
			const spare = Math.max(0, budget - liveRows.length - tailWant);
			const nameRoom = past.length > spare ? Math.max(0, spare - 1) : spare;
			const keep = new Set([...liveRows, ...past.slice(past.length - nameRoom)]);
			const shown = tools.filter((i) => keep.has(i));
			// `+N more running` COUNTS ONLY CALLS THAT ARE RUNNING.
			//
			// Counting every dropped call said "+1 more running" over a
			// read that had already returned — a false sentence of the
			// R3h class, and the stretch line above had ALREADY counted
			// that read ("read 1 file"), so the row was both wrong and
			// redundant. A finished name giving way to live work is the
			// recency rule doing its job, not an overflow.
			const hidden = live.length - shown.filter((i) => !toolAt(i).done).length;
			const rows: string[] = [];
			// the mark lives on the ACTIVITY line above, so the members
			// wear a plain gutter — see FrameCtx.grouped.
			for (const i of shown) {
				if (i === live[0] && live.length === 1) rows.push(...soloRows.slice(0, Math.max(1, budget - rows.length)));
				else rows.push(tint(i, cellComponent(this.#cells[i]!).render(W, grouped))[0] ?? "");
			}
			if (hidden > 0) rows.push(moreRunningRow(hidden, W));
			// R3i P3 SURVIVES: the call in flight keeps its row AND its
			// output. R7a gave every call a row, which spent the budget
			// the tail used to hold — but a running shell with no output
			// on screen is the defect R3i named, and the owner's ruling
			// was about the finished calls' NAMES, not about this. The
			// tail takes whatever the head rows leave, so it is full
			// height for a lone call and gives way to the names first.
			// R4 B SURVIVES THE UNIFICATION: between two calls — nothing
			// in flight — the slot still shows the call that just
			// finished AND its output. It is appended UNDER the head
			// rows now instead of replacing them, so the block's shape
			// does not change when the last call of a burst returns.
			const rest = budget - rows.length;
			if (live.length === 0 && rest > 0 && tools.length > 0) rows.push(...slotTail(toolAt(tools[tools.length - 1]!).resultText, W, rest));
			return slotPad(rows, budget);
		}

		const think = [...live].reverse().find((i) => this.#cells[i]?.kind === "thinking");
		// R7a — A SLOT WITH NOTHING TO SHOW TAKES NO ROWS.
		//
		// R7 moved thinking OUT of the slot (it is words, and words do
		// not fold), which left this branch — the pre-tool phase of a
		// stretch — with nothing to put in the rows it was still
		// reserving. It padded them anyway: six blank rows between the
		// thought and the composer, on 653 of a 733-frame dogfood
		// replay. Until today those rows were drawn as `│`, so the
		// blank-run guard never saw them and the owner saw a gutter
		// running down the screen marking nothing; blanking the gutter
		// (law 1.3) revealed the hole the gutter had been covering.
		//
		// Reserving height buys stability only where the content
		// CHANGES under it — a stretch whose calls come and go. Before
		// the first call there is nothing to stabilise, so the rows are
		// pure cost, and both complaints are the same complaint.
		const tail = think === undefined ? [] : slotTail((this.#cells[think] as Extract<BodyCell, { kind: "thinking" }>).text, W, budget);
		return tail.length === 0 ? [] : slotPad(tail, budget);
	}

	/** R4 — the tool names with a call still IN FLIGHT in this segment.
	 *  The stretch line's tense is per term, so a finished shell reads
	 *  `ran 1 shell command` while a read is still running. */
	#liveNames(seg: SegmentRecord): string[] {
		const names = new Set<string>();
		for (const i of seg.cells) {
			const c = this.#cells[i];
			if (c !== undefined && c.kind === "tool" && !c.done) names.add(c.name);
		}
		return [...names];
	}

	/** R3i — the open stretch's phase. It is THINKING while a thinking
	 *  cell of it is still open and no call has started; otherwise it is
	 *  ACTING. The tense follows the phase, and the phase is what the
	 *  human is watching happen. */
	#stretchPhase(seg: SegmentRecord): "thinking" | "acting" {
		return seg.thinkingSince !== null && seg.reads === 0 && seg.edits === 0 && seg.others.size === 0 ? "thinking" : "acting";
	}

	/** R3i — the open stretch's terms, in the shape the line renders. */
	#stretchTerms(seg: SegmentRecord): {
		thoughtSeconds: number;
		calls: [string, number][];
		targets: string[];
		trouble: ["failed" | "denied" | "interrupted", number, string][];
	} {
		const ms = seg.thinkingMs + (seg.thinkingSince === null ? 0 : Math.max(0, Date.now() - seg.thinkingSince));
		// R3i: a call in TROUBLE does not contribute to the work terms.
		// The counts are taken at toolStart, before the outcome is known,
		// so a denied write would otherwise fold as `wrote 1 file` beside
		// the clause admitting it was refused — the line saying, in one
		// breath, that the file was written and that it was not. The
		// trouble clause is where those calls are counted.
		const bad = new Map<string, number>();
		for (const j of seg.cells) {
			const c = this.#cells[j];
			if (c === undefined || c.kind !== "tool" || !this.#cellInTrouble(j)) continue;
			bad.set(c.name, (bad.get(c.name) ?? 0) + 1);
		}
		const net = (name: string, n: number): number => Math.max(0, n - (bad.get(name) ?? 0));
		const calls: [string, number][] = [];
		if (net("read_file", seg.reads) > 0) calls.push(["read_file", net("read_file", seg.reads)]);
		if (net("edit_file", seg.edits) > 0) calls.push(["edit_file", net("edit_file", seg.edits)]);
		for (const [name, n] of seg.others) if (net(name, n) > 0) calls.push([name, net(name, n)]);
		const targets: string[] = [];
		for (const j of seg.cells) {
			const c = this.#cells[j];
			if (c !== undefined && c.kind === "tool") targets.push(toolTarget(c.name, JSON.parse(c.inputFull) as Record<string, unknown>));
		}
		return { thoughtSeconds: Math.round(ms / 1000), calls, targets, trouble: this.#segmentTroubleTerms(seg) };
	}

	/** The live region's scalar — the unit tests assert the cap directly
	 *  (the e2e gate pins the screen consequence). W11: the formula's
	 *  blanks are join artifacts — the count includes them (they are real
	 *  screen rows), threaded against the previous sibling's OWN rows. */
	liveCount(): number {
		const panel = this.#panelState?.() ?? null;
		const sheet = this.#sheetState?.() === true;
		const queueRows = this.#queueRows(this.#opts.width(), this.#opts.height());
		// KC1 §6: the composer's extra rows are chrome too — the scalar
		// counts them exactly like the menu/queue bands (N = 1 ⇒ +0)
		const inputExtra = this.#inputRows(this.#opts.width(), this.#opts.height(), this.#menuRows(this.#opts.width()).length, queueRows.length).rows.length - 1;
		// TUI2-R1 (D): the sheet occupies the live region, exactly like the
		// panel — the scalar must say so, or the cap arithmetic disagrees
		// with the screen.
		// R5 — the viewer occupies the live region exactly like the sheet,
		// so the scalar must say so, or the cap arithmetic disagrees with
		// the screen (the same rule DC-27 was about).
		if (this.#viewer !== null) {
			const capV = Math.max(1, this.#opts.height() - 4 - inputExtra - queueRows.length);
			return this.#viewerBand(this.#opts.width()).slice(0, capV).length + CHROME_ROWS + inputExtra + queueRows.length;
		}
		if (sheet) {
			return (
				keysSheetRows(this.#opts.width()).slice(0, Math.max(1, this.#opts.height() - 4 - inputExtra - queueRows.length)).length +
				CHROME_ROWS +
				inputExtra +
				queueRows.length
			);
		}
		if (panel !== null) {
			// W21: the panel's own rows (the cap is exact — the scalar
			// reflects the screen). W22: the queue chips occupy their
			// own band — the panel's cap shrinks by their rows.
			return (
				panelRowsOf(panel, this.#opts.width(), Math.max(1, this.#opts.height() - 4 - inputExtra - queueRows.length)).length +
				CHROME_ROWS +
				inputExtra +
				queueRows.length
			);
		}
		// DC-27 — the scalar measures the PROJECTION, not a second render
		// of its own. This loop used to walk every live cell and render it
		// in full: no open-segment collapse, no flight rule, no act-slot
		// budget. After R3i that described a screen the compositor had
		// stopped drawing — for an open stretch with five finished calls
		// it counted five four-row blocks that were not there. Nothing
		// broke, because the force-commit loop measures liveLines.length
		// and the over-count is conservative; but the cap and geometry
		// gates were asserting a property of a function nothing paints
		// from, so a real regression in the region's height could not
		// have moved them. The rule this file already states for the
		// sheet ("the scalar must say so, or the cap arithmetic disagrees
		// with the screen") is the same rule here.
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const W = this.#opts.width();
		// the SAME content cap the force-commit loop applies, so the
		// scalar sees the same slot budget the screen gets.
		const rows = this.#liveProjection(W, ctx, Math.min(this.#opts.height() - 4 - inputExtra - queueRows.length, this.#liveRoom(this.#opts.height(), inputExtra, queueRows.length)));
		return rows.length + CHROME_ROWS + inputExtra + this.#menuRows(W).length + queueRows.length;
	}

	/** The lines committed THIS frame — the writes land in the frame's
	 *  committed section (the rows just above the live region). */
	#committedLinesThisFrame: string[] = [];
	// the CELL count when the frame began — the drawFull frozen bound's
	// unit (the cells committed BEFORE this frame; a force-commit frame's
	// placed LINES outnumber its cells)
	#committedAtFrameStart = 0;

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
		// DC-34 — A WIDEN DOES NOT REFOLD WHAT IS ALREADY COMMITTED.
		//
		// Every count here is physical ROWS at the fold width in force
		// when it was computed. Refolding the committed cells at a new W
		// changes what every index MEANS while `#scrolledOff` is carried
		// across untranslated — and no translation exists, because the
		// row the scroll stopped at does not occur in the new fold. On a
		// widen the stale count then points at text the terminal already
		// holds, and the frame paints it a second time.
		//
		// A committed row is ink (ADR-0046): the rows still on screen are
		// the same thing as the rows in the scrollback minus a scroll
		// that has not happened, and no terminal reflows either. Leaving
		// them folded as they were printed keeps every index valid.
		//
		// NARROWING still refolds — an old wide row does not FIT, and
		// `#checked` would throw invariant ①. The comparison is against
		// the CACHE's fold width, not the last render's: after 60 → 100
		// (no refold, the cache is still 60) a narrowing to 80 must NOT
		// refold, because 80 columns hold a 60-column row.
		this.#refolded = false;
		if (this.#fullRedraw) {
			// DC-34 — THE REFOLD IS SCOPED BY THE FRONTIER.
			//
			// `#scrolledOff` is the record of what reached the terminal:
			// rows [0, #scrolledOff) are in its scrollback, immutable, and
			// no path of ours may contradict them. A cell with any row
			// down there keeps the fold it was COMMITTED at, forever — in
			// either direction. A cell entirely above the frontier has
			// never left the screen, so re-folding it is free.
			//
			// Two scalar predicates were tried before this and both
			// failed, in different ways: the last-refold width crashed on
			// 60 → 100 → 80 (a cell committed at 100 emitted into an
			// 80-column screen), and the cache's widest fold fires a FULL
			// refold at the first narrowing, which re-wraps rows the
			// scrollback already holds — the original defect, alive in
			// the other direction. The frontier is not an approximation
			// of them; it is the question they were both approximating.
			// A cell is refolded when EITHER is true:
			//   - it is entirely above the frontier (never left the
			//     screen, so re-wrapping it contradicts nothing), or
			//   - it does not FIT: some cached row is wider than W.
			//
			// The second is not a compromise of the first, it is the
			// answer to a question the first cannot reach. A cell can
			// STRADDLE the frontier — its head in the scrollback, its
			// tail still on screen — and the tail must be painted at the
			// current width. Holding its commit fold there emitted a
			// 100-column row into an 80-column screen and invariant ①
			// threw (60 → 100 → 80, measured). Fitting wins: a crash is
			// worse than a seam, and the seam a narrowing leaves is
			// rider 2's, stated rather than hidden.
			let row = 0;
			const refold: boolean[] = new Array<boolean>(this.#committed).fill(false);
			for (let i = 0; i < this.#committed; i += 1) {
				const lines = this.#lineCache[i];
				if (lines === null || lines === undefined) {
					refold[i] = true;
					continue;
				}
				const above = row >= this.#scrolledOff;
				const fits = lines.every((l) => visibleWidth(l) <= W);
				refold[i] = above || !fits;
				const prev = i > 0 ? this.#lineCache[i - 1] : null;
				row += this.#space(i, prev ?? null, lines).length;
			}
			for (let i = 0; i < this.#committed; i += 1) {
				if (refold[i]) this.#lineCache[i] = cellComponent(this.#cells[i]!).render(W, ctx);
			}
			// #committedLines is re-derived over the WHOLE cache, because
			// the frozen prefix still occupies its own rows.
			this.#committedLines = 0;
			for (let i = 0; i < this.#committed; i += 1) {
				const lines = this.#lineCache[i] ?? cellComponent(this.#cells[i]!).render(W, ctx);
				this.#lineCache[i] = lines;
				this.#committedLines += this.#space(i, i > 0 ? (this.#lineCache[i - 1] ?? []) : null, lines).length;
			}
			this.#refolded = refold.some(Boolean);
		}
		// 1. the natural commits — the leading DONE cells freeze: their
		//    lines leave the live region, the scrolls + the committed
		//    writes below place them (the #17 "freeze as a real line",
		//    short sessions included — the frame coalescing keeps a
		//    cell's first frame its freeze frame, so the frozen bytes
		//    emit exactly once).
		this.#committedAtFrameStart = this.#committed;
		this.#committedLinesThisFrame = [];
		// W14: the natural loop HONORS the fold-hold — a thinking/tool
		// cell of the OPEN quiet turn (no text yet) does not commit: its
		// committed form is decided at the release (the turn's text →
		// individual commits with the W13 rollups; the turn's end → the
		// fold). The FORCE-commit path below bypasses the hold — the
		// screen never sticks, the rollup degrades to individuals.
		while (this.#committed < this.#cells.length && this.#cells[this.#committed]!.done && !this.#held(this.#committed)) {
			this.#commitCell(this.#committed, W, ctx);
		}
		// 2. the live lines — the unfinished cells (the tail) + the chrome.
		//    W11: the formula's blank above the first live cell hangs off
		//    the last COMMITTED sibling (the join spans the boundary).
		const menuRows = this.#menuRows(W);
		// W22: the queue chips are the menu-rows family's other occupant
		// (the band above the box top) — the chrome rows and the live
		// caps account for both.
		const queueRows = this.#queueRows(W, H);
		// KC1 §6: the input is N rows now (N = 1 ⇒ today's chrome exactly)
		// — chromeRows = 3 + N + menu + queue, and the content cap loses
		// the composer's EXTRA rows the same way it loses the bands.
		const editor = this.#inputRows(W, H, menuRows.length, queueRows.length);
		const inputExtra = editor.rows.length - 1;
		const chromeRows = CHROME_ROWS + inputExtra + menuRows.length + queueRows.length;
		let liveLines: string[] = [];
		// TUI2-R3v2 ②: where this frame put the panel's option rows, relative
		// to the live region's top. Resolved to ABSOLUTE screen rows once
		// liveTop is known, below.
		let panelSpan: { offset: number; count: number; first: number } | null = null;
		const panel = this.#panelState?.() ?? null;
		// TUI2-R1.5 ⑦(a) (VD-8): the sheet is an OVERLAY, and the frame it
		// opens on — and the one it closes on — take the full-redraw path.
		// The sheet REPLACES the live region, so on an idle composer (where
		// the live region is empty) opening it GROWS the model by its own
		// height; the frame's skip grows with it and the difference is paid
		// in real LFs — rows scrolled permanently into the terminal's
		// scrollback, which closing cannot undo, because the scrollback is
		// not ours to rewrite. Measured: three rows per open on a full
		// screen. The overlay below displaces content on screen instead.
		const sheetUp = this.#sheetState?.() === true;
		// R5 — the viewer is an overlay of exactly the same kind, so it
		// joins the same flag. That one word is what buys it the whole
		// zero-litter discipline below: the window freezes, #emitScroll
		// is skipped, and the close repaints from #lastSkip.
		const viewerUp = this.#viewer !== null;
		this.#overlayFrame = sheetUp || this.#sheetWasUp || viewerUp || this.#viewerWasUp;
		this.#sheetWasUp = sheetUp;
		this.#viewerWasUp = viewerUp;
		if (viewerUp) {
			// R5: the viewer REPLACES the live region — the same slot the
			// sheet and the panel use, for the same reason (it is what the
			// human is reading right now). It is opened only from an idle
			// composer, so it cannot coexist with a panel.
			liveLines = this.#viewerBand(W).slice(0, Math.max(1, H - 4 - inputExtra - queueRows.length));
		} else if (sheetUp) {
			// TUI2-R1 (D): the sheet REPLACES the live region — the same
			// slot the panel uses, for the same reason (it is what the
			// human is reading right now). It cannot coexist with a panel:
			// the editor only opens it from an idle composer.
			liveLines = keysSheetRows(W).slice(0, Math.max(1, H - 4 - inputExtra - queueRows.length));
		} else if (panel !== null) {
			// W21: the panel REPLACES the running tool's live window — the
			// bounded block, capped at H−4 (the panel IS the live region;
			// the W11 blank would separate it from the frozen content).
			// The cap is exact, so the force-commit loop never fires. W22:
			// the queue band sits below the panel — the cap shrinks by it.
			// TUI2-R3v2 ②: the rows and the CLICKABLE span come from one
			// call, so the hit-test reads the arithmetic that placed the
			// rows rather than a second copy of it.
			const frame = panelFrameOf(panel, W, Math.max(1, H - 4 - inputExtra - queueRows.length));
			liveLines = frame.rows;
			panelSpan = frame.options;
		} else {
			// TUI2-R2 ⑤ (D, candidate 1): the FOCUS — the cell the next ctrl+o
			// will act on brightens its own token. The index is derived from
			// the SAME scan expandNext performs (#focusIndex shares its rule
			// by construction), so the marker can never point at a cell the
			// key would not take — which is the only way a focus marker is
			// worth having.
			liveLines = this.#liveProjection(W, ctx, Math.min(H - 4 - inputExtra - queueRows.length, this.#liveRoom(H, inputExtra, queueRows.length)));
		}
		// 3. the FORCE commits — the live region's hard cap H−1: overflow
		//    commits the oldest live cell UNCONDITIONALLY (the one sharp
		//    edge — the cap scalar is asserted by the gates). W22: the
		//    queue band shrinks the cap by its rows (empty queue → H−4).
		while (liveLines.length > H - 4 - inputExtra - queueRows.length && this.#committed < this.#cells.length) { // V6-3: the content cap H−4 (KC1: −N's extra rows)
			// R3f: the cell about to be force-committed marks its segment
			// SPILLED. The rule was written at R3b — "a segment too big for
			// the screen already has rows in the scrollback that cannot be
			// taken back, so it renders normally and does not collapse" —
			// and then never wired: `spilled` had a declaration, an
			// initializer and a read, and nothing ever set it. The read was
			// therefore vacuously true, so a 43-call turn force-committed
			// thirty expanded rows and STILL printed `✦ thought 103s · 43
			// reads` underneath them, claiming as folded the work standing
			// visible above it.
			this.#markSpilled(this.#committed);
			this.#commitCell(this.#committed, W, ctx);
			// TUI2-R2 ⑤: the focus re-derives after a commit — the cell it
			// pointed at may have just left the live region.
			liveLines = this.#liveProjection(W, ctx, Math.min(H - 4 - inputExtra - queueRows.length, this.#liveRoom(H, inputExtra, queueRows.length)));
		}
		// 4. the geometry — the live region's first row:
		//    liveTop = min(totalCommitted, H - liveRows) + 1 — the screen
		//    shows the bottom H rows; the live region anchors to the bottom.
		const liveRowsTotal = liveLines.length + chromeRows;
		const liveTop = Math.min(this.#committedLines, H - liveRowsTotal) + 1;
		// TUI2-R3v2 ②: the option rows' ABSOLUTE screen rows, recorded per
		// frame. A click is answered against the frame the human was looking
		// at when they clicked, which is this one.
		this.#panelRowSpan =
			panelSpan === null ? null : { top: liveTop + panelSpan.offset, count: panelSpan.count, first: panelSpan.first };
		// 5. the frame bytes.
		const out: string[] = [];
		// REL-0152-D14 — AUTOWRAP OFF for the frame's duration.
		//
		// Found in the owner's own capture: 97 of the rows kiso emitted at
		// 80 columns are EXACTLY 80 cells wide — the box top, the box
		// bottom, the composer row, every gap row the chrome pads out. A
		// character printed into the last column does not move the cursor
		// past it; it sets the terminal's PENDING WRAP flag, and the next
		// printed character goes to column 1 of the following row. What
		// terminals do with that flag when a cursor MOVE arrives instead
		// of a character is not agreed on — some clear it, some keep it —
		// and this frame then makes 65 relative cursor-ups through exactly
		// that state.
		//
		// So the frame's layout depended on a behaviour terminals disagree
		// about, on every frame, at every width where a row happens to
		// fill the screen. That is enough to explain a layout that is
		// correct on one terminal and damaged on another, and damaged only
		// while frames are being painted.
		//
		// With autowrap off, a character in the last column simply stays
		// there: no pending flag, no disagreement, and relative moves mean
		// what they say. kiso can never lose content to it either, because
		// #checked already refuses to emit a row wider than the screen —
		// the invariant that makes turning wrapping off safe was in place
		// long before this.
		//
		// Restored at the end of every frame: prose written OUTSIDE a
		// frame (bodyLog, an error) is ordinary output and must still
		// wrap, and the shell inherits the terminal when kiso exits.
		if (this.#needsReset) {
			// REL-0152-D19: released as the FIRST bytes of the FIRST frame
			// rather than as a write of its own. A separate write would be
			// one more thing between the dock coming up and its first
			// frame, and the PTY gates that wait on the boot stream feel
			// it; inside the frame it is four sequences and no new event.
			this.#needsReset = false;
			// REL-0161: the reset ESTABLISHES the hidden cursor (?25l) —
			// the steady state for the session's whole life. It repairs a
			// killed predecessor straight into the same state. The visible
			// cursor comes back exactly once, in editor.exit().
			// DC-40 — H line feeds BEFORE the reset, from wherever the shell
			// left the cursor. The first frame is the full-redraw path and
			// addresses rows 1..H absolutely; at launch those rows are the
			// shell's (its prompt, the launch command, the tail of whatever
			// ran before), and the frame painted over them — gone, not in
			// the scrollback (REL-0152-D20 established the mechanism; 37/60
			// shell lines survived on Apple Terminal, every line ON SCREEN
			// lost). From cursor row r, H feeds move H−r rows and then
			// scroll exactly r: the shell's rows 1..r enter the scrollback
			// as CONTENT (at most one blank row — the cursor's own line),
			// the screen is blank, and the model's assumption "row 0 is the
			// terminal's row 1" is true by construction. The count does not
			// depend on r, so nothing is asked of the terminal.
			//
			// THE ORDER IS THE FIX. `ESC[r` (DECSTBM) HOMES THE CURSOR to
			// row 1 — VT100 semantics, honoured by Apple Terminal, xterm,
			// xterm.js and tmux alike. Feeds emitted AFTER the reset start
			// from row 1, move H−1 rows and scroll ONE: measured on Apple
			// Terminal, 1/20 shell lines survived with an otherwise
			// byte-identical frame. Feeds BEFORE the reset: 20/20. The house
			// emulators did not model the homing and passed the wrong order;
			// VtScrollback does now, and the DC-40 gate is red on it.
			//
			// The reset still precedes the FRAME (REL-0152-D19: a frame
			// drawn into an inherited sub-region is the defect); only the
			// feeds run under whatever region the shell left. A region a
			// killed foreign program left set makes the feeds scroll that
			// region alone and the frame paint over the rows outside it —
			// which is what every frame did before this fix, never worse.
			out.push("\n".repeat(H));
			out.push("\x1b[r\x1b[?69l\x1b[?7h\x1b[?25l");
		}
		out.push("\x1b[?7l");
		// REL-0161: ?25l is the STEADY state now, not a frame bracket —
		// re-asserted at every frame open as self-healing (a subprocess
		// or stray output that showed the cursor is corrected here), and
		// never paired with a ?25h. Sync (2026) still brackets the frame
		// where the terminal understands it.
		out.push(this.#conservative ? "\x1b[?25l" : "\x1b[?2026h\x1b[?25l");
		// A8: the bottom-anchored window (the model's last H rows) shifts
		// DOWN when the live region SHRINKS — the done-fold, the fold-hold
		// release at the terminal event. The steady path's scroll syncs
		// exactly N committed lines, but the window moves N + liveDelta:
		// a shrink with commits (liveTop grows by LESS than N — the scroll
		// overshoots by liveDelta) slips past the pure-shrink trigger, the
		// stale pass erases the old live rows, and nothing re-paints the
		// band between the committed window and the new liveTop (finding
		// #A8 — the W11-boundary pileup). A GROWTH is safe on the steady
		// path (the new live's bottom-anchored extent covers the old — the
		// erased rows are all re-painted); a shrink takes the full-redraw
		// path: the window re-paints at the model's positions, every row
		// covered (the V6-1 every-row rule).
		// REL-0152-R1: ONE renderer. The steady/full split existed because
		// the steady path moved rows by scrolling and could not handle a
		// window that moved the wrong way, so the frames it could not draw
		// were handed to a full repaint. A diff has no such frames: it
		// emits the rows that differ, and on a frame where everything
		// differs that IS a full repaint. The dispatch, the two geometries
		// and the invariant about which moves each path may use all go
		// with it.
		this.#drawFull(out, W, H, liveTop, liveLines, queueRows, menuRows, editor);
		this.#fullRedraw = false;
		// REL-0161: the frame close no longer shows the cursor — hidden IS
		// the steady state (Terminal.app infers "a prompt line" from
		// bracketed-paste + a visible cursor and decorates it with a Mark;
		// the composer draws its own cursor cell instead — #inputRowBytes).
		if (!this.#conservative) out.push("\x1b[?2026l");
		out.push("\x1b[?7h"); // REL-0152-D14: autowrap back on for everything outside the frame
		this.#inFrame = true;
		try {
			this.#writeFrame(out.join("")); // the frame IS the new screen — it does not invalidate it
		} finally {
			this.#inFrame = false;
		}
		this.#lastLiveTop = liveTop;
		this.#lastLiveRows = liveRowsTotal;
		this.#lastInputRows = editor.rows.length;
		// KC1 §6: the next steady frame's relative moves start where THIS
		// frame's CHA parked the cursor — the marker's row inside the
		// composer (N = 1 ⇒ H−2, the retired hard-coded anchor).
		this.#lastAnchorRow = H - 1 - editor.rows.length + editor.markerRow;
	}

	/** TUI2-MD ⑤ — the join blank between cell i−1 and cell i.
	 *
	 *  W11's formula ("a blank above a row that is itself a block, or
	 *  whose previous sibling was taller than one row") reads ROW COUNTS,
	 *  and markdown's rhythm is not a row count: a heading wants a blank
	 *  above and below it even between two one-row paragraphs, and two
	 *  rows of one fence want none even when a long code line folds to
	 *  two. So between two MARKDOWN cells the formula steps aside and the
	 *  block's own `gap` decides — the renderer owns the rhythm, which is
	 *  the only place that knows it. Every other pair is untouched,
	 *  including the boundary INTO a markdown message (the blank under the
	 *  user chip is still W11's). */
	/** R7a — the live block's spacing is the spacing its COMMITTED form
	 *  will get, never its own.
	 *
	 *  W11 gives a blank when either side is multi-row. The block is
	 *  always multi-row and the fold it commits into is always ONE row,
	 *  so the two sides disagreed by construction and a blank appeared
	 *  or vanished at every settle, shoving the whole transcript by a
	 *  row. Both directions occur: after a two-row thought the settle
	 *  ADDED one (my R6/D1 note saw only this case and removed the
	 *  block's blank, which fixed that direction and broke the other);
	 *  after a one-row thought it REMOVED one.
	 *
	 *  Deciding on a one-row stand-in makes the block spaced exactly as
	 *  its fold will be, so the settle changes the row's CONTENT and
	 *  never its position — which is the whole claim of the standing
	 *  block. */
	/** R7a — is any call of this stretch actually RUNNING?
	 *
	 *  The phase is not the same question. A stretch stays "acting" from
	 *  its first tool to its close, so between two bursts — every call
	 *  returned, the model is composing the next one — the phase still
	 *  said acting and the activity line went on breathing over four
	 *  finished reads. A mark that is lit when nothing moves is the
	 *  spinner-implies-progress error §5.3 forbids, one scale up. */
	#inFlight(seg: SegmentRecord): boolean {
		return seg.cells.some((i) => { const c = this.#cells[i]; return c?.kind === "tool" && !c.done; });
	}

	/** R13 D1 — the same constant as everything else. This used to compute
	 *  the lead from a ONE-ROW STAND-IN so the live block would claim the
	 *  spacing its fold was going to get; with the rhythm constant there
	 *  is nothing to simulate, and R7a's device retires with the formula
	 *  that needed it. */
	#blockSpace(i: number, prev: readonly string[] | null, rows: string[]): string[] {
		return bodySpacing(this.#lastDrawn(i, prev), rows);
	}

	#space(i: number, prev: readonly string[] | null, rows: string[]): string[] {
		if (i > 0 && this.#cells[i]?.kind === "md" && this.#cells[i - 1]?.kind === "md") return rows;
		// R13 D1 retires the tool cell's stand-in: the rhythm is a constant,
		// so a settle changes content and never position by construction.
		return bodySpacing(this.#lastDrawn(i, prev), rows);
	}

	/**
	 * R3i — the previous DRAWN sibling, not the previous cell.
	 *
	 * The spacing formula reads what stood above; a cell that rendered
	 * nothing did not stand above anything. Since R3d whole families of
	 * cells render `[]` — the members a fold speaks for — and the
	 * formula was reading that empty array as "a zero-row sibling", so a
	 * multi-row block following a fold lost the blank that belongs above
	 * it. The defect predates this round (any folded turn followed by a
	 * raw block has it); R3i's projection is what finally put a test on
	 * the path.
	 */
	#lastDrawn(i: number, prev: readonly string[] | null): readonly string[] | null {
		if (prev !== null && prev.length > 0) return prev;
		for (let j = i - 1; j >= 0; j -= 1) {
			const cached = this.#lineCache[j];
			if (cached !== null && cached !== undefined && cached.length > 0) return cached;
		}
		return prev;
	}

	/** Commit the cell at index i: render + cache its lines (immutable —
	 *  the force-committed form freezes at the current render), advance
	 *  the bookkeeping — and collect the lines for this frame's writes.
	 *  Pure accounting + the write list; the BYTES emit in the frame.
	 *  W11: the formula's blank above the cell (when one belongs) rides
	 *  this cell's commit — the cache stays raw, the placed rows count. */
	#commitCell(i: number, W: number, ctx: FrameCtx): void {
		const cell = this.#cells[i]!;
		const lines = this.#foldOrRollup(cell, i, W, ctx);
		// W15: a tool cell whose committed rows carried the "ctrl+o"
		// affordance joins the expand history — the detection is the
		// renderer's OWN output, so the read's "/last"-only cut note never
		// lands here. TUI2-R1 (A/B): the affordance is no longer only the
		// renderer cut's "└ … ctrl+o" — the self-naming head suffix and
		// the exploration row carry it on the HEAD row, and a promise the
		// key does not answer would be the one thing worse than silence.
		// unshift: the cells commit oldest-first, so the NEWEST cut lands
		// at the front — the expand pointer's "newest back" walk starts
		// where the user's last key press would aim.
		// R3b: a fold HEAD joins the ring too. The test used to demand a
		// tool cell, and a segment's fold can be emitted at a thinking
		// cell — which would have left the whole segment unreachable by
		// the very key its own row advertises.
		// R4a — the ring captures by IDENTITY, not by searching our own
		// printed bytes.
		//
		// This used to require the rendered rows to contain the literal
		// "ctrl+o", which made the affordance LOAD-BEARING: retiring the
		// printed key (the owner's ruling) would have silently emptied the
		// ring and taken the expand key with it — not a missing hint, a
		// missing feature. A fold head is a fold head because the segment
		// says so; a tool cell is expandable when it is hiding rows.
		const isFoldHead = this.#segmentOf(i)?.headCell === i;
		const hidesRows = cell.kind === "tool" && lines.some((l) => l.includes("ctrl+o"));
		if (isFoldHead || hidesRows) {
			this.#collapsed.unshift(i);
			// R4a — a new fold resets the walk, so the FIRST press after any
			// new work always opens the most recent one. That is the whole
			// of the owner's "which one does it open": the answer is always
			// "the last one", and repeats walk back from there.
			this.#opened.clear();
		}
		this.#lineCache[i] = lines;
		const placed = this.#space(i, i > 0 ? this.#lineCache[i - 1]! : null, lines);
		this.#committed += 1;
		this.#committedLines += placed.length;
		this.#committedLinesThisFrame.push(...placed);
	}

	/** R3b — record which segment the cell just pushed belongs to. Called
	 *  right after the push, so #cells.length-1 is that cell. */
	#stampSegment(): void {
		const turn = this.#turns[this.#turns.length - 1];
		const idx = turn === undefined ? -1 : turn.segments.length - 1;
		const at = this.#cells.length - 1;
		this.#cellSegment[at] = idx;
		if (turn !== undefined && idx >= 0) turn.segments[idx]!.cells.push(at);
	}

	/**
	 * R3b — does the segment hold a call that FAILED or was DENIED?
	 *
	 * Such a segment does not fold. Routine work is what the fold is for;
	 * a refusal and an error are the opposite of routine, and putting
	 * either behind a key hides the one thing on the screen that most
	 * needs a human's eye. Law 1.3 makes the same call about marks — a
	 * failure keeps its colour AND its words — and this is that rule at
	 * the scale of a run.
	 *
	 * The cost, accepted: a turn that reads twenty files and hits one
	 * denial keeps all twenty rows. The alternative is a screen that says
	 * `✦ thought 3s · 20 reads` while a write was refused inside it.
	 */
	/**
	 * R3i — the trouble the stretch met, as the line's own terms.
	 *
	 * Law 1.3: an outcome is stated in WORDS, "the only form that
	 * survives a pipe". So the kind is a different word, never a
	 * different colour — `2 failed`, `1 denied`, `1 interrupted` — and
	 * the failure's identity rides with it. In this phase the terms are
	 * only DRAWN (the live line names trouble the moment it happens);
	 * whether trouble still blocks the fold is the next phase's ruling.
	 */
	/** R3i — is this cell one the fold must not count as work done? */
	#cellInTrouble(i: number): boolean {
		const c = this.#cells[i];
		if (c === undefined || c.kind !== "tool") return false;
		return c.isError || c.reason !== null || c.verdict?.decision === "denied";
	}

	#segmentTroubleTerms(seg: SegmentRecord): ["failed" | "denied" | "interrupted", number, string][] {
		let failed = 0;
		let denied = 0;
		let interrupted = 0;
		let what = "";
		for (const j of seg.cells) {
			const c = this.#cells[j];
			if (c === undefined || c.kind !== "tool") continue;
			// WHICH call, and WHY. The target alone answers the first and
			// not the second, and for a policy denial the second is the
			// whole point: `sub/out.txt` does not tell a human that plan
			// mode is read-only, and that sentence is the one they act
			// on. Law 1.3's own words — an outcome is stated in words —
			// and the ladder cuts this clause last, so it degrades to the
			// target before it disappears.
			const named = (): string => {
				const t = toolTarget(c.name, JSON.parse(c.inputFull) as Record<string, unknown>);
				const why = c.verdict?.reason ?? c.reason;
				return why === null || why === undefined || why === "" || why === "interrupted" ? t : `${t} (${why})`;
			};
			if (c.verdict?.decision === "denied" || (c.reason !== null && c.reason !== "interrupted" && /denied/i.test(c.reason))) {
				denied += 1;
				if (what === "") what = named();
			} else if (c.reason === "interrupted") {
				interrupted += 1;
			} else if (c.isError || c.reason !== null) {
				failed += 1;
				if (what === "") what = named();
			}
		}
		const out: ["failed" | "denied" | "interrupted", number, string][] = [];
		if (failed > 0) out.push(["failed", failed, what]);
		if (denied > 0) out.push(["denied", denied, what]);
		if (interrupted > 0) out.push(["interrupted", interrupted, ""]);
		return out;
	}

	#segmentHasTrouble(seg: SegmentRecord): boolean {
		// R3g (fable, 2026-08-28): a DENIED call is the case this rule
		// exists for, and it was the one case the predicate could not
		// see — a denial carrying no `reason` string leaves isError
		// false and reason null, so `✦ thought 3s · 20 reads` could
		// stand over a refused write. The verdict is the record of it.
		return this.#segmentTools(seg).some((c) => c.isError || c.reason !== null || c.verdict?.decision === "denied");
	}

	/** R3b — the segment's TOOL cells, in order. */
	#segmentTools(seg: SegmentRecord): Extract<BodyCell, { kind: "tool" }>[] {
		const out: Extract<BodyCell, { kind: "tool" }>[] = [];
		for (const j of seg.cells) {
			const c = this.#cells[j]!;
			if (c.kind === "tool") out.push(c);
		}
		return out;
	}

	/** R3f — the cell is leaving the live region under the screen's hard
	 *  cap, so its segment can no longer be represented by a fold. */
	#markSpilled(i: number): void {
		const seg = this.#segmentOf(i);
		if (seg !== null) seg.spilled = true;
	}

	/** R3f — did ANY of the turn's segments spill? The fold is the
	 *  TURN's, so one spilled segment makes the whole turn unfoldable:
	 *  a line claiming the turn's counts cannot stand under rows that
	 *  already show part of that same work. */
	#turnSpilled(turn: TurnRecord): boolean {
		return turn.segments.some((seg) => seg.spilled);
	}

	/** R3d — the turn's cells and its trouble, across every segment. */
	#turnCells(turn: TurnRecord): number {
		let n = 0;
		for (const seg of turn.segments) n += seg.cells.length;
		return n;
	}

	#turnHasTrouble(turn: TurnRecord): boolean {
		return turn.segments.some((seg) => this.#segmentHasTrouble(seg));
	}

	/** R3b — how many cells the segment holds. The fold's threshold reads
	 *  it; nothing else needs it, so it is counted rather than tracked. */
	#segmentCells(seg: SegmentRecord): number {
		return seg.cells.length;
	}

	/** R3b — the segment a committed cell belongs to, or null when it has
	 *  none (a cell of the pipe path, or a kind that is not work). */
	#segmentOf(i: number): SegmentRecord | null {
		const cell = this.#cells[i]!;
		if (cell.kind !== "thinking" && cell.kind !== "tool") return null;
		const turn = cell.turn >= 0 ? this.#turns[cell.turn] : undefined;
		const si = this.#cellSegment[i];
		if (turn === undefined || si === undefined || si < 0) return null;
		return turn.segments[si] ?? null;
	}

	/** W14 — the fold-hold: a thinking/tool cell of the OPEN quiet turn
	 *  (no text yet) does not commit — its committed form is decided at
	 *  the release. The cell's OWN turn must be the CURRENT one (a cell
	 *  of a released turn commits normally). The force-commit path never
	 *  consults this — the screen's hard cap wins over the hold. */
	#held(i: number): boolean {
		// R13 — NOTHING IS HELD ANY MORE. DECLARED REVERSAL of W14's
		// quiet-turn hold, R3b/R3i's segment hold and TUI2-R1.5 ①'s
		// explore-run hold, all three of them owner-ruled away on
		// 2026-09-03 with the mechanism they served.
		//
		// Every one of them existed for the same reason: a done cell's
		// COMMITTED FORM was undecided while its segment or its run was
		// still open, because a fold line or a rollup row might yet stand
		// for it — and a committed row cannot be taken back (ADR-0046).
		// With no fold and no rollup, a call's committed form is its own
		// card and is settled the instant the call is: there is nothing
		// left to wait for.
		//
		// It is not only dead weight. Holding done cells in the live
		// region made the region carry work that was FINISHED, so a burst
		// of four reads and a shell in flight competed for the same rows
		// and DC-43's shrink took the running call's output away — the
		// one thing on the screen the human is waiting for (R7a D). Let
		// them commit and the room is there.
		void i;
		return false;
	}
	/* R13 — `#growingRun` retired with the rollup's commit hold (#held). */

	/** W14/W13 — the release-time decision at a commit, BEFORE the cell's
	 *  own render: the folded-turn fold first (a QUIET turn — ended, no
	 *  text — becomes the ONE fold line; the rest of its thinking/tool
	 *  cells render [] after the fold), then the W13 rollup (a text
	 *  turn's N > 2 same-tool run: the HEAD renders the group summary,
	 *  the members render [] — the scan is the work order's "group key",
	 *  derived at commit time, never pre-stored). */
	#foldOrRollup(cell: BodyCell, i: number, W: number, ctx: FrameCtx): string[] {
		// R13 — DECLARED REVERSAL, three at once, all of them the same
		// idea and all of them owner-ruled on 2026-09-03:
		//
		//   · the SEGMENT FOLD (R3b–R3i, W14) — a closed stretch of two or
		//     more cells collapsed into one settled line;
		//   · the W13 ROLLUP and the `rolled` cell field — a run of three
		//     or more same-tool calls collapsed into a group summary;
		//   · TUI2-R1 (B)'s EXPLORATION ROW — the mixed read-only variant
		//     of the same collapse.
		//
		// Every one of them answered the same pressure: ungrounded output
		// rows owned the screen, so work was collapsed into sentences
		// ABOUT the work. The card is what changes that arithmetic — a
		// call's rows sit inside a surface that says where it begins and
		// ends, so five of them read as one object rather than five loose
		// lines — and the owner's ruling is that the collapse costs more
		// than it buys: a page where the machine's work is sometimes a
		// card, sometimes a summary line and sometimes nothing at all is
		// a page a reader cannot predict. One rhythm, one surface.
		//
		// So every cell renders itself, and this method is the record of
		// what used to happen here. What the folds bought is bought
		// differently now: the preview cap (five rows a call, E1's read
		// showing none) is what keeps a burst from owning the screen, and
		// it is a CONSTANT per call rather than a decision about runs.
		//
		// What goes with them: `#growingRun`'s commit hold existed only so
		// a run's committed FORM could be decided once the run closed —
		// with no run-level form left to decide, a done cell commits when
		// it is done. `#rolledHeads`, `rolledOf`, `rolledTitle`,
		// `rolledDetail` and the `rolled` field go with the rollup.
		return cellComponent(cell).render(W, ctx);
	}

	/** The slot occupant's extra rows — the slash-command menu (above the
	 *  status, in the rhythm gap + the content's spare rows — the old
	 *  menu's position, slot-shaped). */
	/** W22: the pending-queue chips — the menu-rows family's other
	 *  occupant (the queue is dense, like the menu; each line is its
	 *  own chip with the □ gutter). */
	#queueRows(W: number, H: number): string[] {
		const queued = this.#queueState?.() ?? [];
		if (queued.length === 0) return [];
		// KC1 (adjudication A4): a MULTI-LINE queued message's chip shows
		// its FIRST line + a ⏎×k suffix — k = the additional lines, counted
		// after the SAME §3 normalization the editor applies (a CRLF pair
		// is ONE break), so the chip stays one row per queued turn. The
		// suffix rides INSIDE the chip as plain text: the chip renderer
		// escapes control bytes, so an SGR span would be stripped there —
		// and the cells package stays untouched this round.
		const lines = queued.map((line) => {
			const parts = line.replace(/\r\n?/g, "\n").split("\n");
			return parts.length > 1 ? `${parts[0]} ⏎×${parts.length - 1}` : line;
		});
		// A8b: the band CAPS so the content keeps its rows — an unbounded
		// band (the batch flood pastes the whole queue at once) overflowed
		// the screen: the content cap H−4−queue went negative, the march
		// painted nothing, and the leaving rows were never on the screen to
		// scroll — the scrollback lost the turns entirely (finding #A8b —
		// the queued-flood content loss). The band keeps the first H−9
		// chips + one "…N more" row (≤ H−8 rows — the content keeps ≥ 4);
		// the status hint's "+N queued" already carries the count, so the
		// cap hides nothing the status doesn't show.
		const keep = Math.max(1, H - 9);
		if (lines.length <= keep) return pendingQueueRows(lines, W);
		const p = palette();
		const hidden = lines.length - keep;
		return [...pendingQueueRows(lines.slice(0, keep), W), `${p.dim}□ …${hidden} more queued${p.reset}`];
	}

	/**
	 * The band ABOVE the box top. Two occupants share it — the slash
	 * menu and (KC3 §4) the @ file picker.
	 *
	 * Sharing is the design, not an economy. This band is already
	 * counted in chromeRows, already shrinks the live content cap,
	 * already redraws with the frame, and already clamps the composer's
	 * visible rows; a picker with a band of its own would have to
	 * re-derive every one of those and could disagree with any of them.
	 * The two occupants are mutually exclusive BY CONSTRUCTION — the
	 * editor's precedence gate keeps the picker shut whenever the menu
	 * is open — so one function can own the band without either
	 * occupant knowing the other exists.
	 */
	#menuRows(W: number): string[] {
		// TUI2-R2 ②: the session picker is the band's THIRD occupant and
		// takes it first. It is modal — it opens before a session exists,
		// so neither the menu nor the @ picker can be up beside it — and
		// riding this channel buys it the same geometry every other band
		// occupant already has: counted in chromeRows, clamped with the
		// composer, redrawn with the frame.
		const pick = this.#pickState?.() ?? null;
		if (pick !== null) return sessionPickerRows(pick, W, Date.now());
		const at = this.#atState?.() ?? null;
		if (at !== null) return atPanelRows(at, W);
		const menu = this.#menuState?.();
		if (menu === null || menu === undefined || menu.items.length === 0) return [];
		const p = palette();
		// TUI2-R1.5 ⑦(b) (VD-8): the band NAMES itself, the same way the @
		// picker's does. Both render frameless directly above the composer,
		// so with scrollback behind them there was nothing to say where the
		// surface began — the rows read as more history.
		// R8 — THE BAND IS A WINDOW, and the rows are a table.
		//
		// It used to draw every match and fold each long description over
		// as many rows as it took, which is why a bare `/` could not open
		// it: eleven commands plus wraps is most of a short terminal. A
		// fixed window is what lets the trigger be the `/` the banner
		// advertises (see the editor's #menuFiltered).
		//
		// Three shape rules, all of them §1.3 or §1.2:
		//  - the leading `/` comes off the rows. It is already on the
		//    input line directly below, so printing it eleven more times
		//    is a mark carrying no fact the screen does not have.
		//  - the name column is padded to the longest command in the
		//    WHOLE list, not the visible slice, so the descriptions do
		//    not shift sideways as the window scrolls.
		//  - a description is CUT, never folded — a folded row would
		//    break the window's height, which is the thing being bought.
		const items = menu.items;
		const col = MENU_ITEMS.reduce((n: number, m: MenuItem) => Math.max(n, m.name.length - 1), 0);
		const windowed = items.length > MENU_WINDOW;
		// the window's top is derived from the selection alone (this
		// method is re-entered per frame and keeps no state): centre it,
		// clamped to the ends.
		const top = windowed ? Math.max(0, Math.min(menu.selected - ((MENU_WINDOW - 1) >> 1), items.length - MENU_WINDOW)) : 0;
		const rows: string[] = [bandHeader("commands", W)];
		for (let i = top; i < Math.min(items.length, top + MENU_WINDOW); i += 1) {
			const item = items[i]!;
			const label = `${item.name.slice(1).padEnd(col)} ${item.desc}`;
			rows.push(...(i === menu.selected ? gutterCut(`${p.bold}▸${p.reset} `, `${p.bold}${label}${p.reset}`, W) : gutterCut("  ", `${p.dim}${label}${p.reset}`, W)));
		}
		// the counter earns its row only when the list is CUT — over a
		// list you can see all of, it says nothing the rows do not.
		if (windowed) rows.push(`  ${p.dim}(${menu.selected + 1}/${items.length})${p.reset}`);
		return rows;
	}

	/** ONE input row's bytes — the marker embedded at `embedAt` (the
	 *  cursor's display column within the row) when this row owns the
	 *  cursor, `null` on the composer's other rows. The compositor
	 *  strips the marker and returns the frame-derived CELL — the cursor
	 *  move lands AT the marker (a CHA — the column is absolute, so the
	 *  move's base is irrelevant; the retired afterW CUB's base was the
	 *  LAST write's end column, which the steady frame's gap/stale ELs
	 *  leave at col 1 — the A3 finding).
	 *
	 *  W6: the row lives INSIDE the box — the walls are a prefix/suffix
	 *  width only, composed AFTER the marker embed (the marker math is
	 *  untouched; the marker's row column = the wall + the lead + the
	 *  cursor). The content caps at W−4 (the walls' columns) and the
	 *  pad completes the row to EXACTLY W — invariant ① throws on
	 *  overflow, so the box row is built full-width, never truncated.
	 *  W23: the lead width is the ONE authority — leadWidth (width.ts),
	 *  shared with the editor's selfRender/#reflow and editCol.
	 *  KC1 §6: the walk is UNCHANGED — a one-row composer emits exactly
	 *  today's bytes (the T-C1 identity anchor). */
	#inputRowBytes(row: string, W: number, embedAt: number | null): { stripped: string; markerCell: number } {
		let markerLine = "";
		let markerCell = 0; // the marker's 0-based cell — the walk's w at the embed
		let w = 0;
		let inserted = embedAt === null; // a row without the cursor never embeds
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
			if (!inserted && w >= embedAt!) {
				markerLine += CURSOR_MARKER;
				markerCell = w;
				inserted = true;
			}
			const cw = displayWidth(row[i]!);
			// R2: no walls to pay for — but ONE column stays reserved. When
			// the cursor rests past the content the drawn cell is taken out
			// of the pad, and a walk that filled to exactly W leaves no pad
			// to take it from: the row becomes W+1 and invariant ① throws.
			// The old cap paid for two walls and a space; this pays for the
			// cursor, which is the only thing still owed a cell.
			if (w + cw > W - 1) break;
			markerLine += row[i]!;
			w += cw;
			i += 1;
		}
		if (!inserted) {
			// the walk ended before the cursor cell (the box edge) — the
			// marker rests at the row's end; the move still lands AT it
			// (the min() of the contract)
			markerLine += CURSOR_MARKER;
			markerCell = w;
		}
		if (W < 4) {
			// the degenerate screen: the box cannot hold its walls — the
			// bare row (the pre-W6 bytes; the fold probe's pass-through
			// line still crashes invariant ① downstream, as before)
			return { stripped: markerLine.replace(CURSOR_MARKER, ""), markerCell };
		}
		// REL-0161 — the DRAWN cursor. The hardware cursor is hidden for
		// the session's life (Terminal.app infers "a prompt line" from
		// bracketed-paste + a visible cursor and Marks it), so the cell
		// at the marker renders inverse instead. The hardware cursor
		// still PARKS at the marker — the IME anchor is its position.
		const mi = markerLine.indexOf(CURSOR_MARKER);
		let stripped0: string;
		let cursorPad = 0; // 1 when the drawn cursor consumed a pad cell
		if (mi < 0) {
			stripped0 = markerLine; // a row that does not own the cursor
		} else {
			const before = markerLine.slice(0, mi);
			const after = markerLine.slice(mi + CURSOR_MARKER.length);
			if (after.length === 0) {
				// the cursor rests past the content — an inverse space,
				// taken OUT of the pad (the walk capped content at W, so
				// the pad absorbs it and the row still totals W)
				stripped0 = `${before}\x1b[7m \x1b[27m`;
				cursorPad = 1;
			} else if (after[0] === "\x1b" || (after.codePointAt(0)! >= 0xd800 && after.codePointAt(0)! <= 0xdfff)) {
				// never wrap a sequence, never split a surrogate pair —
				// the cell keeps its bytes, the parked cursor still marks
				// the position for the terminal's own affordances
				stripped0 = before + after;
			} else {
				const glyph = String.fromCodePoint(after.codePointAt(0)!);
				stripped0 = `${before}\x1b[7m${glyph}\x1b[27m${after.slice(glyph.length)}`;
			}
		}
		// R2 — the box is retired (see boxTop): the composer is two dashed
		// rules and the row between them, so there are no walls to pay for
		// and no pad to hold them off. The row is exactly W, as it always
		// was; what changed is that all W columns belong to the input.
		const padW = Math.max(0, W - w - cursorPad);
		return { stripped: `${stripped0}${" ".repeat(padW)}`, markerCell };
	}

	/** KC1 §6 — the focus component's input ROWS (N = 1 today's single
	 *  row, byte for byte). The lead rides the FIRST row and the
	 *  continuations indent by its width, so the cursor's column formula
	 *  is the same on every row; the CURSOR'S row carries the marker and
	 *  the frame derives the cursor from it — row AND column — with no
	 *  editPos side channel.
	 *
	 *  The rows arrive already windowed by the editor's §5 estimate; the
	 *  frame re-applies the SAME clamp against the REAL folded menu and
	 *  queue bands (N_visible's height term), keeping the cursor's row
	 *  in view — so the geometry is legal at every terminal size. */
	#inputRows(W: number, H: number, menuRows: number, queueRows: number): { rows: string[]; markerRow: number; markerCol: number } {
		const st = this.#inputState();
		const panel = this.#panelState?.() ?? null;
		// the lead — the panel's phase lead when the panel owns the row
		// (1-3> / the rule input's "2 Yes, don't ask again for " / the
		// amend "feedback (deny): "), the bound prompt otherwise
		const lead = panel !== null ? panelLeadOf(panel) : this.#inputPrompt;
		const leadW = leadWidth(lead);
		// a LEGACY one-row provider (the old {line, cursor} shape) keeps
		// working: its single line is the composer's single row
		let rows = st.lines !== undefined && st.lines.length > 0 ? [...st.lines] : [st.line];
		let cursorRow = Math.min(st.cursorRow ?? 0, rows.length - 1);
		const cursorCol = st.cursorCol ?? st.cursor;
		// KC1 §5's N_visible, re-applied against the frame's REAL bands:
		// the editor could only estimate the menu/queue heights (they
		// fold at width), so the frame is the authority. The window keeps
		// the CURSOR'S row, so a clamp never hides it.
		const n = Math.max(1, Math.min(rows.length, H - 3 - menuRows - queueRows));
		if (rows.length > n) {
			const first = Math.max(0, Math.min(cursorRow - n + 1, rows.length - n));
			rows = rows.slice(first, first + n);
			cursorRow -= first;
		}
		const out: string[] = [];
		let markerCol = 1; // R2: no wall to skip — the row starts at column 1
		for (let r = 0; r < rows.length; r += 1) {
			const text = `${r === 0 ? lead : " ".repeat(leadW)}${rows[r]!}`;
			const bytes = this.#inputRowBytes(text, W, r === cursorRow ? leadW + cursorCol : null);
			out.push(bytes.stripped);
			// W23: the frame-derived column — wallL (2) + the marker's
			// cell + 1 — the CHA lands the cursor AT the marker from ANY base
			if (r === cursorRow) markerCol = 1 + bytes.markerCell;
		}
		return { rows: out, markerRow: cursorRow, markerCol };
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
	#drawFull(out: string[], W: number, H: number, liveTop: number, liveLines: string[], queueRows: string[], menuRows: string[], editor: { rows: string[]; markerRow: number; markerCol: number }): void {
		const overlay = this.#overlayFrame;
		const inputExtra = editor.rows.length - 1; // KC1: the composer's rows above the retired single input row
		const committed = this.#committedLinesThisFrame;
		// 0. the FROZEN rows — the re-folded committed content (re-flowed
		//    at the new width by the terminal): re-painted at [1..frozen],
		//    so the reflow's shifted copies can never ghost. W11: the
		//    formula's blanks between the cells are re-inserted here — the
		//    cache holds each cell's OWN rows; a missing blank would paint
		//    every row below it one row too high (the V6-1 idempotence
		//    rule: this draw must reproduce the screen, row by row).
		//    The bound is the CELL count at the frame's start — the force
		//    commit's placed LINES can exceed the cell count, and the old
		//    lines-bound went negative, skipping every previously-committed
		//    cell (the V6-1 frozen-loop finding — the banner vanished).
		const frozen: string[] = [];
		for (let i = 0; i < this.#committedAtFrameStart; i += 1) {
			frozen.push(...this.#space(i, i > 0 ? this.#lineCache[i - 1]! : null, this.#lineCache[i]!));
		}
		// A8: the march is the WINDOW — the model's last H rows. When the
		// model total (committed + live + chrome) exceeds H, the window's
		// first row is the model's (total − H + 1)-th line: the lines
		// above the window belong in the scrollback, and painting them at
		// rows 1.. would shift every row below by the same (total − H) —
		// the live region lands past its model position and the box eats
		// its tail. The bound skips them: the march covers exactly the
		// window (the committed share + the live + the chrome), r
		// monotone, every row 1..H re-painted (the V6-1 every-row rule).
		const all = [...frozen, ...committed, ...liveLines];
		// TUI2-R1.5 7(a) (VD-8): while the sheet is up the window does NOT
		// move. skip is frozen at its pre-open value and #lastSkip is left
		// alone, so no LF is emitted and nothing enters the scrollback; the
		// march below is clamped to the window instead, which makes the
		// sheet displace content ON SCREEN. Closing takes the full-redraw
		// path with the same #lastSkip and every displaced row comes back.
		// R7a — a monotone skip was TRIED HERE AND REJECTED, measured.
		//
		// The seam it aimed at is real: the turn boundary releases the
		// block into a one-row fold, so a full screen's computed skip
		// drops and every row above slides down one. Holding skip at its
		// high-water mark removes that motion exactly.
		//
		// It also holds the window BELOW the content, and the a7 dogfood
		// replay prices that at 40x24: the frame from which the screen
		// durably fills (no blank run over 2) goes 65 -> 692 of 733 —
		// a three-row hole above the composer through most of a real
		// session. One row of motion once per turn, at the moment the
		// answer lands and the eye is on it, is the cheaper of the two.
		// The A8b guard is written against a real session; this is what
		// it exists to catch.
		const fresh = Math.max(0, all.length + CHROME_ROWS + inputExtra + queueRows.length + menuRows.length - H);
		// R13 — THE WINDOW'S TOP NEVER FALLS. `fresh` is read off the
		// CURRENT model height, so it drops the moment the live region
		// shrinks — and rows [0, #scrolledOff) are already in the
		// terminal's scrollback, immutable (ADR-0046). Painting them again
		// is a window that un-scrolls, which a terminal cannot do: the
		// rows come back on screen while their originals stay in the
		// history above, and the transcript gains a duplicate.
		//
		// R4's standing slot made the live region monotone WITHIN a turn,
		// so this could not arise and the clamp was never needed. R13
		// retires the slot — a card shrinks when its call settles (E2) —
		// which is what put the fall on the table. The clamp is the same
		// rule `#emitScroll`'s floor already keeps for the scroll; it now
		// also governs the paint.
		//
		// A RESIZE is exempt, and must be: the terminal reflows and
		// scrolls on its own before we are called, so the fresh count is
		// the truth there and a high-water mark is DC-34's own defect.
		const skip = overlay ? this.#lastSkip : this.#resizeFrame ? fresh : Math.max(this.#scrolledOff, fresh);
		// A8b (the shrink-trigger's completion): the rows that LEAVE the
		// window scroll into the terminal's scrollback — the LF mechanism
		// (the steady path's own). Only the rows the paint re-covers (the
		// overlap with the new window) are EL'd first — the A7 single-copy
		// discipline; the purely-leaving rows scroll WITH their content
		// (they are never re-painted — the scrollback is their record).
		// Without the scroll the shrink frames overwrite the leaving rows
		// in place — a batch-fed session (the queue drains every turn — a
		// shrink EVERY frame) loses the scrolled-away turns from the
		// terminal's scrollback entirely (finding #A8b — the queued-flood
		// content loss).
		// REL-0152-R1: the scroll is the frame's only irreversible act and
		// lives in one place now. The FLOOR is where the window's top would
		// sit with the live band empty and the chrome at its minimum — the
		// one-way part of a movement that otherwise goes both ways.
		if (this.#resizeFrame) {
			// REL-0152-R1: a resize scrolls NOTHING of ours. Shrinking the
			// window is the terminal's own scroll — it reflows the old
			// content and pushes the overflow into its scrollback before we
			// are called — so emitting our own LFs on top put the same rows
			// in twice (TT-1B: twelve rows of a forty-line burst). The
			// counter adopts the terminal's work, and the held screen is
			// discarded because a reflow invalidates every row of it: the
			// next diff repaints the whole screen, which is exactly what a
			// resize needs.
			// DC-34 — NO HIGH-WATER MARK ON A RESIZE.
			//
			// This was `max(#scrolledOff, …)`, which held a stale count
			// whenever a widen made the fresh one smaller; `leaving` then
			// stayed <= 0 and the text that marched past in the meantime
			// never entered the scrollback at all — the hole, the other
			// half of the same off-by-a-refold.
			//
			// The other implementation in this space reached the same
			// conclusion independently and says so in its own source: a
			// historical high-water mark "caused self-reinforcing
			// inflation that pushed content into scrollback on terminal
			// widen". Dropping it alone brings the DUPLICATE back — it is
			// the pair with the no-refold rule above, not a substitute
			// for it.
			// PROBE 3: a widen leaves it ALONE; a narrow keeps REL-0152-R1.
			if (this.#refolded) this.#scrolledOff = Math.max(this.#scrolledOff, Math.max(0, Math.min(skip, all.length)));
			this.#refolded = false;
			this.#screen = new Array(H).fill(NOT_PAINTED);
			this.#resizeFrame = false;
		} else if (!overlay) {
			const floor = Math.max(0, this.#committedLines + CHROME_ROWS - H);
			this.#emitScroll(out, W, H, all, floor);
		}
		if (!overlay) this.#lastSkip = skip;
		// REL-0152-R1: the rows this frame WANTS on the screen — the same
		// placement the full redraw has always computed, lifted out of the
		// emission so it can be compared against what is there.
		const desired: string[] = new Array(H).fill("");
		let r = 1;
		// the window's content rows: everything above the chrome. With the
		// overlay up `all` can exceed it, and the rows that give way are the
		// OLDEST on screen — they are still in the model and come back on
		// the close.
		const contentRows = Math.max(0, H - CHROME_ROWS - inputExtra - queueRows.length - menuRows.length);
		// DC-34 — THE MARCH NEVER REACHES BELOW THE FRONTIER.
		//
		// Rows [0, #scrolledOff) are in the terminal's scrollback and are
		// immutable; painting one puts the same prose on screen twice,
		// which is the owner's report. `skip` can drop below it whenever
		// the model shrinks under a fixed screen — a widen refolding the
		// cells above the frontier, or the live band collapsing — and
		// nothing stopped it (rider 3's ungated reach-back).
		//
		// Clamping costs a gap under short content for one frame, which
		// the next commit fills. Reaching back costs a duplicate that
		// stands in the transcript forever.
		// ...but only when the WIDTH moved. A height change re-indexes
		// nothing — the folds are untouched, every row means what it
		// meant — so reaching back there is the pre-existing behaviour a
		// gate already covers (the A8 windowing case: grow the screen and
		// the banner returns). The duplication measured in this round is
		// width-driven, and so is the guard.
		const march = all.slice(this.#lastW !== 0 && this.#lastW !== W ? Math.max(skip, this.#scrolledOff) : skip);
		this.#lastW = W;
		for (const line of march.length > contentRows ? march.slice(march.length - contentRows) : march) {
			desired[r - 1] = this.#checked(line, W);
			r += 1;
		}
		// 3. the GAP rows (between the live content and the chrome) — blank.
		for (let rr = r; rr <= H - 4 - inputExtra; rr += 1) desired[rr - 1] = "";
		// W22: the queue chips sit directly above the box top (the
		// "pre-render ABOVE the input row"), the menu above the queue.
		const queueTop = H - 3 - inputExtra - queueRows.length;
		const menuTop = queueTop - menuRows.length;
		for (let i = 0; i < queueRows.length; i += 1) desired[queueTop + i - 1] = this.#checked(queueRows[i]!, W);
		for (let i = 0; i < menuRows.length; i += 1) desired[menuTop + i - 1] = this.#checked(menuRows[i]!, W);
		// V6-3 + W6 + KC1 §6: the design §03 chrome — box top (H−2−N),
		// the composer's N input rows (H−1−N .. H−2), box bottom (H−1),
		// status (H). N = 1 is the retired four-row chrome exactly.
		desired[H - 3 - inputExtra - 1] = boxTop(W);
		for (let i = 0; i < editor.rows.length; i += 1) desired[H - 2 - inputExtra + i - 1] = this.#checked(editor.rows[i]!, W);
		desired[H - 1 - 1] = boxBottom(W);
		const statusRow = this.#statusSource();
		desired[H - 1] = this.#checked(statusLine(statusRow.status, this.#tail, W, statusRow.hint), W);
		this.#emitDiff(out, W, H, desired);
		// REL-0152-R1: park from where the cursor ACTUALLY is — see
		// #cursorRow. It used to be parked from H, which the bottom-up
		// march guaranteed and a diff does not.
		this.#parkCursor(out, this.#cursorRow, H - 2 - inputExtra + editor.markerRow, editor.markerCol);
		this.#cursorRow = H - 2 - inputExtra + editor.markerRow;
	}

	/**
	 * REL-0152-R1 — emit the difference between the screen that is up and
	 * the screen this frame wants, and adopt the new one.
	 *
	 * One CUP + erase + content per CHANGED row and nothing for the rest.
	 * A streaming delta moves the live band and leaves the status row,
	 * the box, the composer and the queue exactly as they were — 13 rows
	 * were being erased per keystroke for a change that touches one, and
	 * those twelve are the tear's whole surface (REL-0152-D1).
	 *
	 * Correctness does not depend on the diff being clever. It depends on
	 * #screen being what the terminal shows, which is why every path that
	 * moves rows updates it: a wrong row is repaired by the next frame,
	 * because the difference includes it.
	 */
	#emitDiff(out: string[], W: number, H: number, desired: readonly string[]): void {
		if (this.#screen.length !== H) this.#screen = new Array(H).fill(NOT_PAINTED);
		for (let i = 0; i < H; i += 1) {
			const want = desired[i] ?? "";
			if (this.#screen[i] === want) continue;
			out.push(want === "" ? `\x1b[${i + 1};1H\x1b[0K` : `\x1b[${i + 1};1H\x1b[0K${want}`);
			this.#cursorRow = i + 1; // a CUP write leaves the cursor on that row
		}
		this.#screen = [...desired];
	}

	/**
	 * REL-0152-R1 — the scroll, and the only irreversible thing a frame
	 * does.
	 *
	 * `leaving` rows go into the terminal's scrollback, which cannot be
	 * rewritten, so two things have to be right BEFORE the LFs: the count,
	 * and what is standing in rows 1..leaving.
	 *
	 * The count is bounded by the FLOOR — where the window's top would sit
	 * with the live band empty and the chrome at its minimum. That is the
	 * one-way part of the window's movement; the rest of it follows a band
	 * whose height goes up and down, and scrolling on that pushed rows
	 * away that the next shrink brought back (the A7 replay's frame 106).
	 *
	 * What is standing there is STAGED from the model rather than assumed.
	 * The old renderer assumed the leaving rows were already correct on
	 * screen and was right until a growing live band painted over one of
	 * them; then the LFs carried the live band's leftover into the
	 * scrollback and the committed row it had displaced was in no
	 * scrollback and on no screen. That is the owner's swallowed message
	 * (REL-0152-D7), and staging is what makes it structurally impossible.
	 */
	#emitScroll(out: string[], W: number, H: number, all: readonly string[], floor: number): number {
		const target = Math.max(0, Math.min(floor, all.length));
		const leaving = Math.max(0, target - this.#scrolledOff);
		if (leaving === 0) return 0;
		if (this.#screen.length !== H) this.#screen = new Array(H).fill(NOT_PAINTED);
		// a transit taller than the screen cannot be staged in one pass —
		// rows placed past H are clamped by the terminal itself and the
		// pile keeps only its last member (finding TUI2-MD-1). Chunked, at
		// most H rows at a time, every row on screen when its slot comes up.
		let p = this.#scrolledOff;
		while (p < target) {
			const chunk = Math.min(target - p, H);
			for (let k = 0; k < chunk; k += 1) {
				const row = all[p + k];
				out.push(row === undefined || row === "" ? `\x1b[${k + 1};1H\x1b[0K` : `\x1b[${k + 1};1H\x1b[0K${this.#checked(row, W)}`);
			}
			if (chunk < H) out.push(`\x1b[${chunk + 1};1H\x1b[0J`);
			out.push(`\x1b[${H};1H`);
			for (let k = 0; k < chunk; k += 1) out.push("\n");
			this.#cursorRow = H; // the LFs at the last row leave it there
			p += chunk;
		}
		this.#scrolledOff = target;
		// The screen after a scroll is not worth modelling row by row: the
		// staging painted rows 1..chunk, the ED blanked everything below
		// them, and the LFs then shifted all of it up — per chunk. An
		// earlier version modelled only the shift, forgot the ED, and the
		// diff below then skipped rows the terminal had already blanked:
		// a 19-row blank band on a 24-row screen, which is most of it.
		//
		// So a scrolled frame forgets the screen and repaints. That costs
		// nothing worth having: a scroll happens only when the COMMITTED
		// height crosses the floor, and a commit frame changes most rows
		// anyway. The frames the diff exists for — a streaming delta, a
		// keystroke — commit nothing, scroll nothing, and repaint only
		// what moved.
		this.#screen = new Array(H).fill(NOT_PAINTED);
		return leaving;
	}


	/**
	 * TUI2-R2 ⑤ (the R1.5 parked ⑩) — CURSOR AUTHORITY: the ONE frame-tail
	 * positioning sequence, and the compositor's alone.
	 *
	 * Both draw paths ended with their own hand-rolled park — the full
	 * path counting rows up from the status line, the steady path counting
	 * down from a six-branch re-derivation of which write happened to be
	 * last. Two implementations of one contract, each re-deriving byte
	 * order the drawing code already knew, and the walkthrough found the
	 * consequence three times over (the cursor resting in the status
	 * line's "de▮ault", at the end of streamed text, inside an approval
	 * panel's rule row). A terminal cursor is the product's claim about
	 * where the next keystroke lands; a claim made in two places is a
	 * claim that will eventually disagree with itself.
	 *
	 * One owner, one sequence: a single vertical move to the marker's row
	 * — in EITHER direction, which the steady path could not do (its move
	 * was `if (down > 0)`, so a cursor left BELOW the composer simply
	 * stayed there) — then the CHA to the frame-derived column.
	 *
	 * Relative, not a CUP, and deliberately: invariant ② reserves absolute
	 * addressing for the content area, and the composer is chrome. The
	 * CHA is absolute in the COLUMN only, which is what makes the park
	 * independent of wherever the last write ended (the A3 finding: the
	 * retired CUB's base was the gap EL's column 1, left of the lead).
	 */
	/**
	 * REL-0152-R1 — park ABSOLUTELY.
	 *
	 * This was a relative move, and it could be: the old bottom-up march
	 * always ended on the status row, so the base was H by construction.
	 * A diff ends on whatever row changed last, and on a streaming frame
	 * that is the live band. Tracking the base is possible but it makes
	 * the cursor's correctness depend on every writer in this file
	 * remembering to update a counter — and the PTY gates that assert
	 * "every frame ends with the cursor on an input row" caught exactly
	 * that going wrong.
	 *
	 * A CUP to the row needs no base at all. The CHA for the column
	 * stays: it was already absolute (the A3 finding retired the CUB
	 * whose base was the last write's end column), and the frame-derived
	 * column contract is asserted on it.
	 */
	#parkCursor(out: string[], _fromRow: number, toRow: number, col: number): void {
		out.push(`\x1b[${toRow};1H`);
		out.push(`\x1b[${col}G`);
	}

	/** Invariant ①: every emitted line fits the width — a violation is a
	 *  CRASH with the diagnostic, never a silent truncate. */
	#checked(line: string, W: number): string {
		// Invariant ①b (R3f): a ROW IS ONE PHYSICAL ROW.
		//
		// The defect this catches shipped in 0.16.6 and smashed the
		// composer. `escapeTerminal` keeps `\n` (it strips C0 except tab
		// and newline), and `charWidth(0x0A)` is 1 — so a newline counts as
		// ONE CELL in `visibleWidth`, and every width check in the product,
		// invariant ① included, waves a multi-line string through as a
		// single row of legal width. `#emitDiff` then paints it as
		// `CUP(row,1) + EL + content`, the terminal's ONLCR moves the
		// cursor down at the newline, and the tail lands on whatever
		// physical row is there — the box rail, the input row. The diff
		// then adopts `desired` as the screen's truth, so the corruption
		// SURVIVES: the self-healing property this renderer is built on
		// ("a wrong row is repaired by the next frame, because the
		// difference includes it") is exactly what a lying `#screen`
		// breaks.
		//
		// Width was never the whole invariant — it was the half we
		// noticed. A row that occupies two physical rows violates the
		// geometry as surely as one that overruns the width, and it does
		// so INVISIBLY to a width check. `\r` is here for the same reason
		// (it moves the cursor to column 1).
		const bad = /[\n\r]/.exec(line);
		if (bad !== null) {
			throw new Error(
				`kiso-tui invariant ①b violated: a row containing ${JSON.stringify(bad[0])} was about to be emitted — a row must be ONE physical row, and the width check cannot see this (charWidth counts a newline as one cell) — ${JSON.stringify(line.slice(0, 80))}`,
			);
		}
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
	 *  runtime emits no text_end; the next cell is the close signal).
	 *  TUI2-MD ⑤: that same signal ends the markdown message — the open
	 *  tail block closes and its cell becomes commit-eligible. */
	#closeOpenText(): void {
		this.#endMd();
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
	/** DC-3 — the terminal answered what its background is; repaint. */
	onGroundChange(): void {
		compositorRef?.onGroundChange();
	}
	/** TUI2-R3v2 ②: where the last frame put the panel's clickable option
	 *  rows (absolute screen rows). The editor binds this and does no row
	 *  arithmetic of its own. */
	panelOptionRows(): { top: number; count: number; first: number } | null {
		return compositorRef?.panelOptionRows() ?? null;
	}
	setStatus(text: string, hint?: string | null): void {
		compositorRef?.setStatus(text, hint ?? null);
	}
	setTail(tail: string): void {
		compositorRef?.setTail(tail);
	}
	/** W21: bind the editor's panel state — the PanelSelect slot
	 *  occupant (the panel replaces the live region + the input lead
	 *  while up; the old ApprovalPrompt's question slot retires). */
	bindApproval(state: () => PanelState | null): void {
		if (compositorRef === null) {
			dockBindings.panel = state; // the live buffer — order-agnostic
			return;
		}
		compositorRef.bindApproval(state);
	}
	/** TUI2-R1 (D): bind the editor's keys-sheet flag — the slot read for
	 *  the ? overlay (the menu/picker binding pattern). */
	bindSheet(state: () => boolean): void {
		if (compositorRef === null) {
			dockBindings.sheet = state;
			return;
		}
		compositorRef.bindSheet(state);
	}
	/** R5 — the transcript viewer's three doors, forwarded to the live
	 *  compositor. Unlike the other bindings there is no buffer: the
	 *  viewer cannot be open before a compositor exists, so a call with
	 *  no compositor is a no-op rather than a queued intent. */
	viewerOpen(): boolean {
		return compositorRef !== null && compositorRef.viewerOpen();
	}
	viewerToggleMode(): void {
		compositorRef?.viewerToggleMode();
	}
	viewerKey(cmd: "up" | "down" | "toggle" | "all" | "pageUp" | "pageDown" | "home" | "end"): void {
		compositorRef?.viewerKey(cmd);
	}
	bindInput(state: () => InputState, prompt: string): void {
		if (compositorRef === null) {
			dockBindings.state = state; // the live buffer — order-agnostic
			dockBindings.prompt = prompt;
			return;
		}
		compositorRef.bindInput(state, prompt);
	}
	bindMenu(state: () => { items: readonly MenuItem[]; selected: number } | null): void {
		if (compositorRef === null) {
			dockBindings.menu = state;
			return;
		}
		compositorRef.bindMenu(state);
	}
	/** KC3 §4: bind the editor's @ picker — the SAME band as the slash
	 *  menu (see Body#menuRows). Unbound, the picker cannot render, and
	 *  every frame is byte-identical to before the round. */
	bindAt(state: () => AtPanelState | null): void {
		if (compositorRef === null) {
			dockBindings.at = state;
			return;
		}
		compositorRef.bindAt(state);
	}
	/** TUI2-R2 ②: bind the editor's session picker — the band's third
	 *  occupant. Unbound (every path but bare `kiso resume`), the picker
	 *  cannot render and every frame is byte-identical to before. */
	bindPick(state: () => SessionPickState | null): void {
		if (compositorRef === null) {
			dockBindings.pick = state;
			return;
		}
		compositorRef.bindPick(state);
	}
	/** W22: bind the pending-turn queue — the chips + the +N queued
	 *  hint (the CLI binds it from chat(); the editor's pop keys ride
	 *  the LineInput's own bindQueue). */
	bindQueue(state: () => readonly string[]): void {
		if (compositorRef === null) {
			dockBindings.queue = state;
			return;
		}
		compositorRef.bindQueue(state);
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

/** The Dock's pre-compositor bindings — a LIVE object the bind methods
 *  mutate (the CLI binds the editor state before the Body exists; the
 *  Body's constructor applies it). W21: order-agnostic by construction
 *  — the old snapshot froze `menu` at bindInput time and the slash-
 *  command menu silently never bound in the real CLI (the e2e gates
 *  bind the Body directly and could not see it). */
const dockBindings: {
	state: (() => InputState) | null;
	prompt: string;
	menu: (() => { items: readonly MenuItem[]; selected: number } | null) | null;
	at: (() => AtPanelState | null) | null;
	pick: (() => SessionPickState | null) | null;
	panel: (() => PanelState | null) | null;
	sheet: (() => boolean) | null;
	queue: (() => readonly string[]) | null;
} = { state: null, prompt: "", menu: null, at: null, pick: null, panel: null, sheet: null, queue: null };
