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
import { panelAffordanceOf, panelLeadOf, panelRowsOf, panelStatusOf } from "./ask-panel.js";
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
	bodySpacing,
	boxBottom,
	boxTop,
	cellComponent,
	exploreCounts,
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

	constructor(opts: BodyOptions) {
		this.#opts = opts;
		this.#write = opts.write ?? ((s) => process.stdout.write(s));
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
			if (!sameTask(last.items, items)) {
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
		this.#attachResize();
		this.#fullRedraw = true;
		this.#dirty = true;
		this.render(); // the FIRST frame — the full-redraw path, no pre-clear
	}

	/** Teardown — CSI r (the "no broken terminal" contract byte), the
	 *  chrome rows cleared, the cursor home at the input line. */
	exit(): void {
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
		const live = this.#cells.slice(this.#committed);
		const ctx: FrameCtx = { spinnerI: this.#spinnerI, now: Date.now(), height: this.#opts.height() };
		const W = this.#opts.width();
		let lines = 0;
		let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
		for (const cell of live) {
			const rows = cellComponent(cell).render(W, ctx);
			lines += bodySpacing(prev, rows).length;
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
				this.#committedLines += bodySpacing(i > 0 ? this.#lineCache[i - 1]! : null, lines).length;
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
			liveLines = panelRowsOf(panel, W, Math.max(1, H - 4 - inputExtra - queueRows.length));
		} else {
			let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
			for (const cell of this.#cells.slice(this.#committed)) {
				const rows = cellComponent(cell).render(W, ctx);
				liveLines.push(...bodySpacing(prev, rows));
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
				let prev: string[] | null = this.#committed > 0 ? this.#lineCache[this.#committed - 1]! : null;
				for (const cell of this.#cells.slice(this.#committed)) {
					const rows = cellComponent(cell).render(W, ctx);
					liveLines.push(...bodySpacing(prev, rows));
					prev = rows;
				}
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
		if (this.#fullRedraw || liveTop > this.#lastLiveTop + this.#committedLinesThisFrame.length || liveRowsTotal < this.#lastLiveRows) {
			this.#drawFull(out, W, H, liveTop, liveLines, queueRows, menuRows, editor);
			this.#fullRedraw = false;
		} else {
			this.#drawSteady(out, W, H, liveTop, liveLines, queueRows, menuRows, editor);
		}
		out.push("\x1b[?2026l");
		this.#write(out.join(""));
		this.#lastLiveTop = liveTop;
		this.#lastLiveRows = liveRowsTotal;
		this.#lastInputRows = editor.rows.length;
		// KC1 §6: the next steady frame's relative moves start where THIS
		// frame's CHA parked the cursor — the marker's row inside the
		// composer (N = 1 ⇒ H−2, the retired hard-coded anchor).
		this.#lastAnchorRow = H - 1 - editor.rows.length + editor.markerRow;
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
		const placed = bodySpacing(i > 0 ? this.#lineCache[i - 1]! : null, lines);
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
			frozen.push(...bodySpacing(i > 0 ? this.#lineCache[i - 1]! : null, this.#lineCache[i]!));
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
		if (skip > 0 && !overlay) {
			const leaving = Math.max(0, skip - this.#lastSkip);
			// A8b (the fresh leaving share): a leaving row whose old-screen
			// copy is stale — the committed-this-frame lines (their old rows
			// held the previous live/chrome) — is pre-painted at its OLD row
			// so the LF scroll carries it into the scrollback; the frozen
			// leaving rows are already on screen and scroll as-is. The first
			// overflow frame of a batch: the window's top row is the freshly
			// committed line, NEVER on the old screen — without the
			// pre-paint the scroll pushes a blank and the line's only paint
			// (the clamped march at row 1) is overwritten by its neighbor.
			if (skip > frozen.length) {
				const fromIdx = Math.max(0, this.#lastSkip - frozen.length);
				const top = Math.min(skip - frozen.length, all.length - frozen.length);
				for (let i = fromIdx; i < top; i += 1) {
					out.push(`\x1b[${Math.max(1, frozen.length + i - this.#lastSkip + 1)};1H\x1b[0K${this.#checked(all[frozen.length + i]!, W)}`);
				}
			}
			if (leaving < skip) out.push(`\x1b[${leaving + 1};1H\x1b[0J`);
			out.push(`\x1b[${H};1H`);
			// TUI2-R2pre ② — scroll the rows that LEFT THE WINDOW SINCE THE
			// LAST FRAME (`leaving`), never `skip`, which is the window's
			// ABSOLUTE top. Scrolling the absolute top re-pushed the whole
			// history's worth of rows on EVERY full redraw — and a live-region
			// shrink takes this path, so that was most frames of a real
			// session. The ED above had just blanked everything below row
			// `leaving`, so what those surplus LFs carried into the terminal's
			// scrollback was blank rows: the large blank bands mid-history of
			// the owner's field report. The SCREEN never showed it because the
			// repaint below covers every row 1..H (the V6-1 rule), and the
			// house emulator drops scrolled rows on the floor — so no gate
			// could see it either. Measured on the 5-turn 80x24 repro: the
			// scrollback went from 162 blank rows of 168 to 14 of 52.
			for (let i = 0; i < leaving; i += 1) out.push("\n");
		}
		if (!overlay) this.#lastSkip = skip;
		let r = 1;
		// the window's content rows: everything above the chrome. With the
		// overlay up `all` can exceed it, and the rows that give way are the
		// OLDEST on screen — they are still in the model and come back on
		// the close.
		const contentRows = Math.max(0, H - CHROME_ROWS - inputExtra - queueRows.length - menuRows.length);
		const march = all.slice(skip);
		for (const line of march.length > contentRows ? march.slice(march.length - contentRows) : march) {
			out.push(`\x1b[${r};1H\x1b[0K${this.#checked(line, W)}`);
			r += 1;
		}
		// 3. the GAP rows (between the live content and the chrome) — EL.
		for (let rr = r; rr <= H - 4 - inputExtra; rr += 1) {
			out.push(`\x1b[${rr};1H\x1b[0K`);
		}
		// W22: the queue chips sit directly above the box top (the
		// "pre-render ABOVE the input row"), the menu above the queue.
		const queueTop = H - 3 - inputExtra - queueRows.length;
		const menuTop = queueTop - menuRows.length;
		for (let i = 0; i < queueRows.length; i += 1) {
			out.push(`\x1b[${queueTop + i};1H\x1b[0K${this.#checked(queueRows[i]!, W)}`);
		}
		for (let i = 0; i < menuRows.length; i += 1) {
			out.push(`\x1b[${menuTop + i};1H\x1b[0K${this.#checked(menuRows[i]!, W)}`);
		}
		// V6-3 + W6 + KC1 §6: the design §03 chrome — box top (H−2−N),
		// the composer's N input rows (H−1−N .. H−2), box bottom (H−1),
		// status (H). N = 1 is the retired four-row chrome exactly.
		out.push(`\x1b[${H - 3 - inputExtra};1H\x1b[0K${boxTop(W)}`);
		for (let i = 0; i < editor.rows.length; i += 1) {
			out.push(`\x1b[${H - 2 - inputExtra + i};1H\x1b[0K${this.#checked(editor.rows[i]!, W)}`);
		}
		out.push(`\x1b[${H - 1};1H\x1b[0K${boxBottom(W)}`);
		const statusRow = this.#statusSource();
		out.push(`\x1b[${H};1H\x1b[0K${this.#checked(statusLine(statusRow.status, this.#tail, W, statusRow.hint), W)}`);
		// the cursor: up from the status row to the MARKER'S row inside
		// the composer (N = 1, markerRow 0 ⇒ the retired \x1b[2A) + the
		// CHA to the marker's frame-derived column — W23: the afterW CUB
		// retired (the CHA is absolute — the base is irrelevant; the
		// CUB's base was the LAST write's end column, which the steady
		// frame's ELs leave at col 1 — the A3 finding)
		out.push(`\x1b[${1 + editor.rows.length - editor.markerRow}A`);
		out.push(`\x1b[${editor.markerCol}G`);
	}

	/** The steady-state frame — RELATIVE moves only (invariant ②); the
	 *  commits scroll via the CUP-free real LF at the last row, and the
	 *  committed lines write in the march's top section (rows
	 *  [liveTop−N .. liveTop−1] — the frozen area's bottom). */
	#drawSteady(out: string[], W: number, H: number, liveTop: number, liveLines: string[], queueRows: string[], menuRows: string[], editor: { rows: string[]; markerRow: number; markerCol: number }): void {
		const inputExtra = editor.rows.length - 1; // KC1: the composer's rows above the retired single input row
		const committed = this.#committedLinesThisFrame;
		// A8b: the steady path's window geometry — the same skip as the full
		// path's (#lastSkip's formula): the model rows above the window
		// belong in the scrollback. frozenCount = the committed lines BEFORE
		// this frame — the lines this frame commits start at model row
		// frozenCount, so the lines at [frozenCount..skip−1] are the fresh
		// leaving share (their old-screen copies are stale).
		const frozenCount = this.#committedLines - committed.length;
		// TUI2-R1.5 7(a): an overlay frame never moves the window (see
		// #drawFull) — the sheet's rows displace content on screen instead
		// of pushing it into the scrollback.
		const overlay = this.#overlayFrame;
		const skip = overlay ? this.#lastSkip : Math.max(0, this.#committedLines + liveLines.length + CHROME_ROWS + inputExtra + queueRows.length + menuRows.length - H);
		const leaving = overlay ? 0 : Math.max(0, skip - this.#lastSkip);
		// the jump to the bottom row H, then N real LFs scroll the screen
		// exactly N rows — ONE per committed line (the bookkeeping; the
		// stale 1B anchor jumped to H−1 and the N LFs scrolled only N−1 —
		// the committed section sat one row short in the scrollback). The
		// bottom-up repaint below overwrites the scrolled-in rows (the
		// scroll count is screen-neutral — proven by the emulator probe).
		// A7: the scrolled rows carry the PRE-FRAME live copies (the
		// streamed rendering of the just-committed cells) into the
		// scrollback — a real terminal keeps them forever, and the
		// repaint's fresh copy below makes the two copies the reviewer
		// saw. The old live band is EL'd BEFORE the scroll: the rows that
		// scroll away are blank, the repaint is the only copy (the old
		// band's rows are all re-drawn this frame — live CUP, gap ELs,
		// chrome march — so the erase is invisible).
		if (committed.length > 0) {
			// A8b (the steady path's own leaving scroll): the fresh leaving
			// lines — the committed-this-frame/live lines at model rows
			// [frozenCount..skip−1], whose old-screen copies are stale (the
			// previous live/chrome) — are pre-painted at their OLD rows so
			// the LF scroll carries them into the scrollback. The queued
			// flood's first frame: the window's top row is the user chip,
			// never on the old screen — without the pre-paint the scroll
			// pushes a blank and the chip's ONLY paint (the clamped band at
			// row 1) is overwritten by its neighbor in the same frame
			// (finding #A8b — the user chips 1..8 lost from the terminal
			// state).
			if (leaving > 0 && skip > frozenCount) {
				const seq = [...committed, ...liveLines];
				const top = Math.min(skip - frozenCount, seq.length);
				for (let i = Math.max(0, this.#lastSkip - frozenCount); i < top; i += 1) {
					out.push(`\x1b[${Math.max(1, frozenCount + i - this.#lastSkip + 1)};1H\x1b[0K${this.#checked(seq[i]!, W)}`);
				}
			}
			const oldBottom = Math.min(H, this.#lastLiveTop + this.#lastLiveRows);
			// A8b: the EL covers the OVERLAP only — the old live band's rows
			// the repaint re-draws (the A7 single-copy discipline). The
			// leaving rows below the overlap scroll WITH their content —
			// they are never re-painted, the scrollback is their record (the
			// old code erased them and the scrolled-away rows came up blank —
			// the A8b content loss).
			const overlapFrom = Math.max(1, this.#lastLiveTop, leaving + 1);
			for (let r = overlapFrom; r <= oldBottom; r += 1) {
				out.push(`\x1b[${r};1H\x1b[0K`);
			}
			out.push(`\x1b[${H};1H`); // CUP to the bottom — the absolute scroll base (the ELs moved the cursor)
		} else {
			// KC1 §6: the anchor is where the LAST frame's CHA parked the
			// cursor — the marker's row inside the composer (N = 1 ⇒ H−2,
			// the retired \x1b[2B)
			const anchorRow = this.#lastAnchorRow > 0 ? this.#lastAnchorRow : H - 2;
			if (H > anchorRow) out.push(`\x1b[${H - anchorRow}B`);
		}
		// TUI2-R2pre ②: this count is the COMMIT count on purpose, and it
		// stays. It reads like the same mistake the full path made, but the
		// two paths are doing different jobs: the full path REPAINTS every
		// row, so anything it scrolls is a duplicate of what it is about to
		// draw; the steady path does not repaint the frozen band, and the
		// rows it scrolls carry the PRE-FRAME live copies of the cells that
		// just committed — the A7 single-copy discipline (the old live band
		// is EL'd first, so the repaint below is the only copy left). Making
		// this `leaving` was measured: the A7 gate fails at 40x24 frame 106
		// with the greeting duplicated in the terminal.
		for (let i = 0; i < committed.length; i += 1) out.push("\n");
		// the bottom-up repaint, from the last row up — V6-3 + W6 + KC1:
		// the design §03 chrome: status (H), box bottom (H−1), the
		// composer's N input rows (H−2 up to H−1−N), box top (H−2−N)
		const statusRow = this.#statusSource();
		out.push(`\x1b[1G\x1b[0K${this.#checked(statusLine(statusRow.status, this.#tail, W, statusRow.hint), W)}`); // H — the status
		out.push(`\x1b[1A\x1b[1G\x1b[0K${boxBottom(W)}`); // H−1 — the box bottom
		for (let i = editor.rows.length - 1; i >= 0; i -= 1) {
			out.push(`\x1b[1A\x1b[1G\x1b[0K${this.#checked(editor.rows[i]!, W)}`); // the input rows, bottom-up
		}
		out.push(`\x1b[1A\x1b[1G\x1b[0K${boxTop(W)}`); // H−2−N — the box top
		// W22: the queue chips sit directly above the box top (the
		// "pre-render ABOVE the input row"), the menu above the queue —
		// the bottom-up order mirrors the row order.
		for (let i = queueRows.length - 1; i >= 0; i -= 1) {
			out.push(`\x1b[1A\x1b[1G\x1b[0K${this.#checked(queueRows[i]!, W)}`);
		}
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
		//    the queue + menu bands (their rows at [H−3−queue−menu..H−4]
		//    are marched and must survive — the unclamped geometry erased
		//    them).
		for (let r = liveTop + liveLines.length; r <= H - 4 - inputExtra - queueRows.length - menuRows.length; r += 1) {
			out.push(`\x1b[${r};1H\x1b[0K`);
		}
		// 2. the STALE rows above the committed section — the scrolled old
		//    live copies (a live-drawn cell's pre-commit position): EL.
		//    TUI2-R2pre ②: the old band's POST-SCROLL origin shifted up by
		//    the rows that actually left — `leaving`. It read the commit
		//    count only because the scroll above used to BE the commit
		//    count; with the two decoupled, the old expression erases rows
		//    of frozen content that never moved.
		const staleFrom = Math.max(1, this.#lastLiveTop - committed.length);
		for (let r = staleFrom; r < liveTop - committed.length; r += 1) {
			out.push(`\x1b[${r};1H\x1b[0K`);
		}
		// 3. the committed lines at [liveTop−N .. liveTop−1] — the rows
		//    CLAMP at 1: a super-tall force-commit's early lines have no
		//    on-screen row (they would need a negative CUP — terminal
		//    undefined behavior); their content stays in the scrollback.
		//    A8b: the first (skip − frozenCount) lines are ABOVE the new
		//    window — they were pre-painted and scrolled; re-painting them
		//    would re-clamp them into row 1 and the band's second line
		//    overwrites the first in the same frame (the row-1 clamp pile —
		//    the queued flood lost the user chips 1..8 that way). The
		//    window's share starts at the line whose model row is the
		//    window's top (skip).
		for (let i = Math.max(0, skip - frozenCount); i < committed.length; i += 1) {
			out.push(`\x1b[${Math.max(1, liveTop - committed.length + i)};1H\x1b[0K${this.#checked(committed[i]!, W)}`);
		}
		// the cursor: down to the anchor (H−2, the input row) + left to the marker —
		// the down-distance from the LAST written row, in byte order: the
		// committed band's bottom, then the stale ELs' bottom, then the gap
		// ELs' bottom, then the live lines' bottom, then the menu's top
		// (its last marched row), else the chrome's box top.
		const lastRow =
			committed.length > 0
				? Math.max(1, liveTop - 1)
				: staleFrom < liveTop
					? liveTop - 1
					: liveTop + liveLines.length <= H - 4 - inputExtra - queueRows.length - menuRows.length
						? H - 4 - inputExtra - queueRows.length - menuRows.length
						: liveLines.length > 0
							? liveTop + liveLines.length - 1
							: menuRows.length > 0
								? H - 3 - inputExtra - menuRows.length - queueRows.length
								: H - 3 - inputExtra;
		// the anchor: the MARKER'S row inside the composer (N = 1,
		// markerRow 0 ⇒ the retired H−2)
		const down = H - 2 - inputExtra + editor.markerRow - lastRow;
		if (down > 0) out.push(`\x1b[${down}B`);
		// W23: the CHA to the frame-derived column — the cursor rests AT
		// the marker from ANY base (the retired afterW CUB clamped at col
		// 1 — the steady frame's LAST write is the gap/stale EL: the A3
		// finding; the A5/A8 live lines end mid-row, the ELs at col 1 —
		// the CHA ignores the base by construction)
		out.push(`\x1b[${editor.markerCol}G`);
		// A8b: the steady path moves the window too (the scroll + the
		// repaint) — record its top so the next full-redraw's leaving count
		// is the rows the window dropped since the last frame, whatever the
		// path of the frames between (same formula as `skip` above).
		this.#lastSkip = skip;
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
