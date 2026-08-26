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
import { displayWidth, type MenuItem } from "./editor.js";
import { leadWidth } from "./width.js"; // W23: the ONE width authority (the editor, #inputRow, and editCol share it)
// KC3.5: the panel-slot reads come from the DISPATCHERS — one source
// for four reads, so an ask can never render half as an approval.
import { panelAffordanceOf, panelFrameOf, panelLeadOf, panelRowsOf, panelStatusOf } from "./ask-panel.js";
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
	Container,
	ROLLUP_NOUN,
	SPINNER,
	MdStream,
	bodySpacing,
	boxBottom,
	boxTop,
	cellComponent,
	exploreCounts,
	focusToken,
	exploreRows,
	foldLine,
	isExploreTool,
	pendingQueueRows,
	statusLine,
	turnFold,
	visibleWidth,
	type BodyCell,
	type FrameCtx,
} from "./components.js";
import { bannerLines, escapeTerminal, foldResult, foldThinking, palette, renderTerminalGap, renderToolSummary, toolTarget, type ResumeMeta } from "./render.js";
import { displayVerb, keysSheetRows } from "./strings.js";

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

/**
 * SPIKE (alt-screen) — measured, not shipped.
 *
 * `KISO_ALT_SCREEN=1` runs the dock on the terminal's ALTERNATE screen.
 * The question the spike answers is what that would buy and what it
 * would cost, with numbers instead of argument. Off by default: nothing
 * about the product changes unless the variable is set.
 */
const ALT_SCREEN = process.env.KISO_ALT_SCREEN === "1";

const CHROME_ROWS = 4; // box top + input + box bottom + status — the design §03 chrome (V6-3; the box is W6)

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
	thoughtSeconds: number;
	reads: number;
	edits: number;
	others: Map<string, number>;
	words: string;
	/** the fold was emitted at the first held cell's commit — the rest of
	 *  the turn's thinking/tool cells render [] (never a second fold). */
	folded: boolean;
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
	#altRestored = false;
	#resizeTimer: ReturnType<typeof setTimeout> | null = null;
	#lastH = 0;
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
	#pipeBuf = ""; // the passthrough's thinking buffer
	/** TUI2-MD ⑤ — the markdown scanner of the message currently
	 *  streaming, and the cell index its first block landed at. Null
	 *  between messages: the scanner's life is one assistant message. */
	#md: MdStream | null = null;
	#mdBase = 0;
	#toolCells = new Map<string, number>(); // callId → cell index (parallel tools)
	// W15: the collapsed (cut) tool cells — committed cells whose last
	// rendered row carried the "ctrl+r" affordance; the expand key's
	// cycling pointer walks this list from the newest back.
	#collapsed: number[] = [];
	#expandPtr = 0;
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
		this.#turns.push({ ended: false, hasText: false, thoughtSeconds: 0, reads: 0, edits: 0, others: new Map(), words: text, folded: false });
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
		this.#cells.push({ kind: "tool", name, input: summary, inputFull: JSON.stringify(input, null, 2), childRoles, state: "pending", isError: false, resultText: "", diff: null, added: 0, removed: 0, startedAt: null, doneAt: null, done: false, expanded: false, turn: this.#turns.length - 1, rolled: null, reason: null, verdict: null });
		// W14: the turn record's counts — the folded-turn line's terms
		// (reads = read_file, edits = edit_file, the rest in first-call
		// order). The CLI's recap counts the same way (edit_file).
		const turn = this.#turns[this.#turns.length - 1];
		if (turn !== undefined) {
			if (name === "read_file") turn.reads += 1;
			else if (name === "edit_file") turn.edits += 1;
			else turn.others.set(name, (turn.others.get(name) ?? 0) + 1);
		}
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
			this.#write(`${p.bold}▞${p.reset} ${escapeTerminal(header)}\n`);
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
	banner(version: string, extensionsText: string, resume: ResumeMeta[] = []): void {
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
		this.#cells.push({ kind: "banner", version, extensionsText, resume, done: true });
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

	/** W15 — the expand key's target (ctrl+r). A cell still in the LIVE
	 *  region (the newest live tool) TOGGLES in place — the compositor
	 *  owns those rows and redraws them (the body flips to the full
	 *  form, no cap). A committed cell can never toggle — history is
	 *  never rewritten (ADR-0046) — so the key APPENDS a fresh expanded
	 *  block at the bottom instead, the /last idiom aimed at a chosen
	 *  cell: the pointer cycles the collapsed history, newest first, and
	 *  the header names the target ("N turns back" — the user cells
	 *  after it), so every press tells the user what they got. */
	/**
	 * TUI2-R2 ⑤ — the cell the next ctrl+r will act on, or -1.
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

	expandNext(): { kind: "toggled" } | { kind: "appended"; lines: string[] } | { kind: "none" } {
		for (let i = this.#cells.length - 1; i >= this.#committed; i -= 1) {
			const cell = this.#cells[i]!;
			if (cell.kind === "tool" && cell.state !== "pending") {
				cell.expanded = !cell.expanded;
				this.#mark();
				return { kind: "toggled" };
			}
			// W20: the LIVE task block toggles in place too — the capped
			// form flips to the full list (the "done-collapse expands
			// under ctrl+r" claim). The SETTLED block is already full —
			// no toggle, and its rows carry no affordance, so it never
			// joins #collapsed (the committed /last append is moot).
			if (cell.kind === "checklist" && !cell.done) {
				cell.expanded = !cell.expanded;
				this.#mark();
				return { kind: "toggled" };
			}
		}
		if (this.#collapsed.length === 0) return { kind: "none" };
		const idx = this.#collapsed[this.#expandPtr % this.#collapsed.length]!;
		this.#expandPtr += 1;
		const cell = this.#cells[idx]!;
		if (cell.kind !== "tool") return { kind: "none" };
		if (cell.rolled !== null) {
			// W13: a rolled-up head expands to the FULL per-call children —
			// the rollup showed the first 3 + the overflow; the expand shows
			// every target, one └ row each (the /last idiom — the children
			// land as NEW content, history is never rewritten, ADR-0046).
			const turnsBack = this.#cells.slice(idx + 1).filter((c) => c.kind === "user").length;
			const p = palette();
			const back = `${turnsBack} ${turnsBack === 1 ? "turn" : "turns"} back`;
			// TUI2-R1 (B): an EXPLORATION head lists per TOOL — the counts
			// the row showed, then one row per tool with its subjects. The
			// header keeps W15's shape; only the subject changes.
			if (cell.rolled.parts !== undefined) {
				const header = `${p.bold}▞${p.reset} expanded · ${escapeTerminal(`explored ${exploreCounts(cell.rolled.parts)}`)} · ${back}`;
				return { kind: "appended", lines: [header, ...exploreRows(cell.rolled.parts, this.#opts.width())] };
			}
			const noun = ROLLUP_NOUN[cell.name] ?? "calls";
			const header = `${p.bold}▞${p.reset} expanded · ${escapeTerminal(`${displayVerb(cell.name)} ${cell.rolled.count} ${noun}`)} · ${back}`;
			return {
				kind: "appended",
				lines: [header, ...cell.rolled.targets.map((t) => `  ${p.dim}└ ${escapeTerminal(t)}${p.reset}`)],
			};
		}
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(cell.inputFull) as Record<string, unknown>;
		} catch {
			// the full JSON is always parseable (it was stringified at
			// toolStart) — the empty fallback never fires
		}
		const turnsBack = this.#cells.slice(idx + 1).filter((c) => c.kind === "user").length;
		const p = palette();
		const header = `${p.bold}▞${p.reset} expanded · ${escapeTerminal(`${displayVerb(cell.name)} ${toolTarget(cell.name, input)}`)} · ${turnsBack} ${turnsBack === 1 ? "turn" : "turns"} back`;
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
		// SPIKE: 1049 saves the primary screen, gives a blank buffer with
		// NO scrollback, and restores the primary untouched on exit.
		if (ALT_SCREEN) this.#write("\x1b[?1049h");
		this.#attachResize();
		this.#fullRedraw = true;
		this.#dirty = true;
		this.render(); // the FIRST frame — the full-redraw path, no pre-clear
	}

	/** Teardown — CSI r (the "no broken terminal" contract byte), the
	 *  chrome rows cleared, the cursor home at the input line. */
	exit(): void {
		// SPIKE: the transcript is printed to the PRIMARY screen on the way
		// out, so the history survives the session the way it does today —
		// the third option the round proposed, measured here rather than
		// argued about.
		if (ALT_SCREEN && this.#docked) {
			const lines: string[] = [];
			for (let i = 0; i < this.#committed; i += 1) {
				lines.push(...this.#space(i, i > 0 ? this.#lineCache[i - 1]! : null, this.#lineCache[i]!));
			}
			this.#write("\x1b[?1049l");
			if (lines.length > 0) this.#write(`${lines.join("\n")}\n`);
			this.#altRestored = true;
		}
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
		if (ALT_SCREEN && !this.#altRestored) out.push("\x1b[?1049l");
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
		if (panel !== null) return { status: panelStatusOf(panel), hint: panelAffordanceOf(panel) };
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
		// panel rows' edit column; leadWidth is the ONE authority)
		const lead = panel !== null ? panelLeadOf(panel) : this.#inputPrompt;
		return 3 + leadWidth(lead) + st.cursor;
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
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const W = this.#opts.width();
		let lines = 0;
		let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
		for (let i = this.#committed; i < this.#cells.length; i += 1) {
			const rows = cellComponent(this.#cells[i]!).render(W, ctx);
			lines += this.#space(i, prev, rows).length;
			prev = rows;
		}
		return lines + CHROME_ROWS + inputExtra + this.#menuRows(W).length + queueRows.length;
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
		if (this.#fullRedraw) {
			this.#lineCache = this.#lineCache.map(() => null);
			this.#committedLines = 0;
			for (let i = 0; i < this.#committed; i += 1) {
				const cell = this.#cells[i]!;
				const lines = cellComponent(cell).render(W, ctx);
				this.#lineCache[i] = lines; // the cell's OWN rows — the cache stays raw
				this.#committedLines += this.#space(i, i > 0 ? this.#lineCache[i - 1]! : null, lines).length;
			}
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
		this.#overlayFrame = sheetUp || this.#sheetWasUp;
		this.#sheetWasUp = sheetUp;
		if (sheetUp) {
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
			// TUI2-R2 ⑤ (D, candidate 1): the FOCUS — the cell the next ctrl+r
			// will act on brightens its own token. The index is derived from
			// the SAME scan expandNext performs (#focusIndex shares its rule
			// by construction), so the marker can never point at a cell the
			// key would not take — which is the only way a focus marker is
			// worth having.
			const focus = this.#focusIndex();
			let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
			for (let i = this.#committed; i < this.#cells.length; i += 1) {
				const cell = this.#cells[i]!;
				const rows = cellComponent(cell).render(W, ctx);
				// the head row carries the affordance; the tint lands on it and
				// nowhere else, which is what makes "exactly one" structural
				if (i === focus && rows.length > 0) rows[0] = focusToken(rows[0]!, W);
				liveLines.push(...this.#space(i, prev, rows));
				prev = rows;
			}
		}
		// 3. the FORCE commits — the live region's hard cap H−1: overflow
		//    commits the oldest live cell UNCONDITIONALLY (the one sharp
		//    edge — the cap scalar is asserted by the gates). W22: the
		//    queue band shrinks the cap by its rows (empty queue → H−4).
		while (liveLines.length > H - 4 - inputExtra - queueRows.length && this.#committed < this.#cells.length) { // V6-3: the content cap H−4 (KC1: −N's extra rows)
			this.#commitCell(this.#committed, W, ctx);
			liveLines = [];
			{
				// TUI2-R2 ⑤: the focus re-derives after a commit — the cell it
				// pointed at may have just left the live region
				const focus = this.#focusIndex();
				let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
				for (let i = this.#committed; i < this.#cells.length; i += 1) {
					const cell = this.#cells[i]!;
					const rows = cellComponent(cell).render(W, ctx);
					if (i === focus && rows.length > 0) rows[0] = focusToken(rows[0]!, W);
					liveLines.push(...this.#space(i, prev, rows));
					prev = rows;
				}
			}
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
			out.push("\x1b[r\x1b[?69l\x1b[?7h\x1b[?25h");
			// REL-0152-D20 — the mechanism is understood and the obvious fix
			// is NOT taken here. See the finding.
			//
			// The first frame addresses rows 1..H absolutely and draws over
			// whatever the terminal was showing. Scrolling a screenful away
			// first would fix that, and it was built and measured: it pushes
			// up to H BLANK rows into the scrollback, and TUI2-R2pre's
			// blank-share gate went from 14/43 to 29/43 — past the "a
			// healthy session's scrollback is mostly content" invariant that
			// gate exists to hold. Trading a symptom with a five-second
			// user-side setting for a broken invariant is a worse deal.
			//
			// The correct version scrolls only as far as the terminal's
			// content actually reaches, which needs a cursor-position query
			// at boot — its own round, with its own risk (this file already
			// declined a boot-time round-trip once, for racing the editor
			// for stdin).

		}
		out.push("\x1b[?7l");
		out.push(this.#conservative ? "\x1b[?25l" : "\x1b[?2026h"); // D1: sync ON, or cursor-hide where 2026 is dead bytes
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
		out.push(this.#conservative ? "\x1b[?25h" : "\x1b[?2026l");
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
	#space(i: number, prev: readonly string[] | null, rows: string[]): string[] {
		if (i > 0 && this.#cells[i]?.kind === "md" && this.#cells[i - 1]?.kind === "md") return rows;
		return bodySpacing(prev, rows);
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
		// W15: a tool cell whose committed rows carried the "ctrl+r"
		// affordance joins the expand history — the detection is the
		// renderer's OWN output, so the read's "/last"-only cut note never
		// lands here. TUI2-R1 (A/B): the affordance is no longer only the
		// renderer cut's "└ … ctrl+r" — the self-naming head suffix and
		// the exploration row carry it on the HEAD row, and a promise the
		// key does not answer would be the one thing worse than silence.
		// unshift: the cells commit oldest-first, so the NEWEST cut lands
		// at the front — the expand pointer's "newest back" walk starts
		// where the user's last key press would aim.
		if (cell.kind === "tool" && lines.some((l) => l.includes("ctrl+r"))) this.#collapsed.unshift(i);
		this.#lineCache[i] = lines;
		const placed = this.#space(i, i > 0 ? this.#lineCache[i - 1]! : null, lines);
		this.#committed += 1;
		this.#committedLines += placed.length;
		this.#committedLinesThisFrame.push(...placed);
	}

	/** W14 — the fold-hold: a thinking/tool cell of the OPEN quiet turn
	 *  (no text yet) does not commit — its committed form is decided at
	 *  the release. The cell's OWN turn must be the CURRENT one (a cell
	 *  of a released turn commits normally). The force-commit path never
	 *  consults this — the screen's hard cap wins over the hold. */
	#held(i: number): boolean {
		const cell = this.#cells[i]!;
		if (cell.kind !== "thinking" && cell.kind !== "tool") return false;
		const turn = cell.turn >= 0 ? this.#turns[cell.turn] : undefined;
		if (turn === undefined || turn !== this.#turns[this.#turns.length - 1]) return false;
		if (!turn.ended && !turn.hasText) return true;
		// the turn's END releases every hold — the settle is where the run
		// is decided, and a held cell at settle would never commit at all.
		if (turn.ended) return false;
		return this.#growingRun(i);
	}

	/** TUI2-R1.5 ① (VD-1) — the explore-run hold. W14's hold covers the
	 *  QUIET turn only, and the model's own narration ("let me look at the
	 *  parser area") sets hasText before the first read even starts: from
	 *  there each completion committed in its OWN frame, the head committed
	 *  alone, and `members.every(done)` — the fold's gate — could never be
	 *  true again. Every real session therefore degraded to one row per
	 *  call while the unit suite, which feeds the burst synchronously,
	 *  stayed green (the walkthrough's frame s1-06).
	 *
	 *  The hold is the smallest honest fix: a DONE explore cell whose run
	 *  can still GROW does not commit yet — its committed form is not
	 *  decided until the run is closed. The run closes at the first
	 *  non-explore cell (the model's next word, an edit, a shell) or at the
	 *  turn's end, and the whole run then commits in ONE frame, which is
	 *  exactly the shape the fold was written for.
	 *
	 *  The force-commit path never consults this (see #held's callers): the
	 *  screen's hard cap still wins, so the screen never sticks — a run
	 *  under real screen pressure degrades mid-turn, and the rows it
	 *  already froze stay frozen (history is never rewritten, ADR-0046). */
	#growingRun(i: number): boolean {
		const cell = this.#cells[i]!;
		if (cell.kind !== "tool" || !isExploreTool(cell.name)) return false;
		// the run is still growing while NOTHING but explore cells follow —
		// the turn-less noise cells (permission raws, ⚠ notices) are
		// transparent here for the same reason the run scan sees through
		// them: the streaming execution interleaves them between the calls.
		for (let j = i + 1; j < this.#cells.length; j += 1) {
			const next = this.#cells[j]!;
			if (next.kind === "raw" || next.kind === "notice") continue;
			if (next.kind === "tool" && isExploreTool(next.name)) continue;
			return false; // a non-explore cell closed the run — commit now
		}
		return true;
	}

	/** W14/W13 — the release-time decision at a commit, BEFORE the cell's
	 *  own render: the folded-turn fold first (a QUIET turn — ended, no
	 *  text — becomes the ONE fold line; the rest of its thinking/tool
	 *  cells render [] after the fold), then the W13 rollup (a text
	 *  turn's N > 2 same-tool run: the HEAD renders the group summary,
	 *  the members render [] — the scan is the work order's "group key",
	 *  derived at commit time, never pre-stored). */
	#foldOrRollup(cell: BodyCell, i: number, W: number, ctx: FrameCtx): string[] {
		if (cell.kind === "thinking" || cell.kind === "tool") {
			const turn = cell.turn >= 0 ? this.#turns[cell.turn] : undefined;
			if (turn !== undefined && turn.ended && !turn.hasText) {
				if (!turn.folded) {
					turn.folded = true;
					// A9 (ruling R2, mock A): the user chip rides the fold —
					// the words take the fold's width budget (turnFold is
					// W-aware — the ONE row never trips invariant ①).
					return turnFold(
						{
							words: turn.words,
							thoughtSeconds: turn.thoughtSeconds,
							reads: turn.reads,
							edits: turn.edits,
							others: [...turn.others],
						},
						W,
					);
				}
				return [];
			}
		}
		if (cell.kind !== "tool" || !isExploreTool(cell.name)) return cellComponent(cell).render(W, ctx);
		// TUI2-R1 (B): the run is over the READ-ONLY SET, not one name —
		// a model exploring mixes read/list/search, and the same-name scan
		// split every real burst into fragments. Writes, edits, shells and
		// extension tools still break the run at the first one.
		// the maximal read-only run around i — forward/backward scans over
		// the cells. The turn-less noise cells (the permission raws, the ⚠
		// notices) are TRANSPARENT: the streaming execution (loop.ts launch)
		// interleaves them BETWEEN the calls of one burst, so the run must
		// see through them. It never crosses a user/text/thinking cell —
		// those separate turns and contexts.
		// TUI2-R1.5 ① (VD-1): the backward scan stops at the cells this
		// FRAME is committing. A cell committed in an earlier frame is
		// frozen — its rows are on the screen and in the scrollback — so it
		// can never become the head of a rollup now, and a run that
		// force-committed its first rows mid-turn must not have the rest
		// silently absorbed into a summary that was computed without them.
		// The degraded head keeps its individual row; the rest of the run
		// rolls on its own.
		let s = i;
		let head = i;
		while (s > this.#committedAtFrameStart) {
			const prev = this.#cells[s - 1]!;
			if (prev.kind === "raw" || prev.kind === "notice") {
				s -= 1;
				continue;
			}
			if (prev.kind !== "tool" || !isExploreTool(prev.name)) break;
			s -= 1;
			head = s; // a read-only tool precedes — it is the group's head
		}
		let e = i;
		while (e + 1 < this.#cells.length) {
			const next = this.#cells[e + 1]!;
			if (next.kind === "raw" || next.kind === "notice") {
				e += 1;
				continue;
			}
			if (next.kind !== "tool" || !isExploreTool(next.name)) break;
			e += 1;
		}
		// the run counts the TOOL cells only — the span's raws are noise.
		const members = this.#cells.slice(s, e + 1).filter((c): c is Extract<BodyCell, { kind: "tool" }> => c.kind === "tool");
		if (members.length <= 2) return cellComponent(cell).render(W, ctx);
		if (head === i) {
			// the HEAD — the rollup only when EVERY member is done (at the
			// text's release they are — the natural loop commits the run in
			// one frame; the force-commit's early commits degrade to the
			// individual rows, the members render normally after).
			if (!members.every((c) => c.done)) return cellComponent(cell).render(W, ctx);
			this.#rolledHeads.add(head);
			let total = 0;
			const targets: string[] = [];
			// TUI2-R1 (B): the per-tool parts, in first-call order — the
			// exploration row's counts and its expanded list both read them.
			// A search's subject is the PATTERN it looked for (quoted); a
			// read's or a list's is the path it named.
			const parts: { name: string; subjects: string[] }[] = [];
			for (const m of members) {
				// the lines count, excluding the tool's OWN truncation note
				// (read_file's "… N more lines") — the per-cell meta's rule
				const noteAt = m.resultText.lastIndexOf("\n… ");
				const shown = noteAt >= 0 ? m.resultText.slice(0, noteAt) : m.resultText;
				const rows = shown.split("\n");
				total += rows[rows.length - 1] === "" ? rows.length - 1 : rows.length;
				let input: Record<string, unknown> = {};
				try {
					input = JSON.parse(m.inputFull) as Record<string, unknown>;
				} catch {
					// the full JSON is always parseable (stringified at
					// toolStart) — the empty fallback never fires
				}
				const target = toolTarget(m.name, input);
				targets.push(target.split("/").pop() ?? target);
				const subject = m.name === "search_text" ? `"${String(input.pattern ?? "")}"` : target;
				const part = parts.find((x) => x.name === m.name);
				if (part === undefined) parts.push({ name: m.name, subjects: [subject] });
				else part.subjects.push(subject);
			}
			const first = members[0]!;
			const last = members[members.length - 1]!;
			const elapsed = first.startedAt !== null && last.doneAt !== null ? ((last.doneAt - first.startedAt) / 1000).toFixed(1) : "?";
			// TUI2-R1 (B): `parts` rides ONLY a mixed run — a single-name
			// run keeps W13's row, byte for byte (the generalization adds).
			cell.rolled = { count: members.length, lines: total, elapsed, targets, ...(parts.length > 1 ? { parts } : {}) };
			return cellComponent(cell).render(W, ctx);
		}
		// a MEMBER of an already-rolled run → [] (its rows live in the
		// head's summary). A member of a run whose head committed
		// INDIVIDUALLY (the force-commit's degradation) renders normally —
		// the head is not in #rolledHeads, the run never rolls after the
		// head's individual commit.
		if (this.#rolledHeads.has(head)) return [];
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
		const rows: string[] = [bandHeader("commands", W)];
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
			if (w + cw > W - 4) break; // the cap — the two walls' columns
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
		const stripped0 = markerLine.replace(CURSOR_MARKER, "");
		if (W < 4) {
			// the degenerate screen: the box cannot hold its walls — the
			// bare row (the pre-W6 bytes; the fold probe's pass-through
			// line still crashes invariant ① downstream, as before)
			return { stripped: stripped0, markerCell };
		}
		// the pad completes the row to W — the content stopped at W−4,
		// so the pad is ≥ 1
		const padW = W - 3 - w;
		return { stripped: `\x1b[2m│ \x1b[0m${stripped0}\x1b[2m${" ".repeat(padW)}│\x1b[0m`, markerCell };
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
		let markerCol = 3;
		for (let r = 0; r < rows.length; r += 1) {
			const text = `${r === 0 ? lead : " ".repeat(leadW)}${rows[r]!}`;
			const bytes = this.#inputRowBytes(text, W, r === cursorRow ? leadW + cursorCol : null);
			out.push(bytes.stripped);
			// W23: the frame-derived column — wallL (2) + the marker's
			// cell + 1 — the CHA lands the cursor AT the marker from ANY base
			if (r === cursorRow) markerCol = 3 + bytes.markerCell;
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
		const skip = overlay
			? this.#lastSkip
			: Math.max(0, all.length + CHROME_ROWS + inputExtra + queueRows.length + menuRows.length - H);
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
			this.#scrolledOff = Math.max(this.#scrolledOff, Math.max(0, Math.min(skip, all.length)));
			this.#screen = new Array(H).fill(NOT_PAINTED);
			this.#resizeFrame = false;
		} else if (ALT_SCREEN) {
			// SPIKE — THE WHOLE POINT. There is no scrollback on the
			// alternate screen, so nothing a frame does is irreversible and
			// no row ever has to be "sent somewhere it can never come back
			// from". The floor, the monotonic counter, the staging, the
			// chunked transit and the question REL-0152-D7 spent six failed
			// fixes on all become unreachable: the window is simply the
			// model's last rows, and the diff paints it.
			this.#scrolledOff = 0;
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
		const march = all.slice(skip);
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
