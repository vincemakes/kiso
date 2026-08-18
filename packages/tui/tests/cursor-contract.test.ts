/**
 * W23 (the v8 work order §W23) — the cursor contract: the input-row
 * cursor DERIVES from the frame — wallL + leadWidth(lead) + cells + 1 —
 * the ONE formula shared by the editor (selfRender, #reflow) and the
 * compositor (#inputRow, editCol). The afterW assumption (the CUB's
 * base = the input row's end) is retired: the steady frame's LAST
 * write is the gap/stale EL (the cursor at col 1), so the relative CUB
 * clamps at the left margin — the A3 finding (the cursor parked before
 * the ›, the text after).
 *
 * The probe drives REAL tuples (the five leads × ASCII/CJK × cursor
 * 0/mid/end × narrow/normal W) through BOTH math paths — the editor's
 * dockState/selfRender/#reflow AND the compositor's #inputRow/editCol —
 * and asserts they land at the SAME column: the frame ends with the
 * CHA to the frame-derived column, the editor's self-render parks at
 * the same cell (wallL = 0), and editCol reports the same value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor, PROMPT } from "../src/editor.js";
import { panelLead, type PanelView } from "../src/approval-panel.js";
import { charWidth, leadWidth } from "../src/width.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** The panel view the probe drives (the real panelLead derives the
 *  leads — the styled strings ride the width authority). */
const PANEL_VIEW: PanelView = {
	flavor: "approval",
	name: "edit_file",
	title: "edit examples/foo.ts",
	speaker: "mode:default",
	hint: "/mode accept-edits auto-approves edits",
	statusText: "▸ run paused",
	args: { kind: "text", lines: ["old", "new"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
	});
	return {
		body,
		writes,
		tick: () => vi.advanceTimersByTime(16),
		setSize: (w: number, h: number) => {
			W = w;
			H = h;
		},
	};
}

/** The frame's final cursor move — the LAST G-move with a column > 1
 *  (the chrome's relative repaints are all `\x1b[1G`; the only other
 *  G>1 move in the steady frame is the cursor's CHA). The retired
 *  afterW CUB is a D-move — a pre-fix frame yields undefined. */
function finalCursorMove(bytes: string): number | undefined {
	const moves = [...bytes.matchAll(/\x1b\[(\d+)G/g)].map((m) => Number(m[1]));
	const cursorMoves = moves.filter((n) => n > 1);
	return cursorMoves[cursorMoves.length - 1];
}

/** The test-side replay of the compositor's marker walk — the marker's
 *  0-based cell: the first w ≥ leadW + cells the walk reaches, else the
 *  LAST writable cell (the W−4 cap — a wide char cannot straddle the
 *  boundary, so the CJK tail rests one cell earlier than an ASCII
 *  tail). The ANSI-SGR sequences consume zero cells and the marker
 *  never embeds inside one. */
function markerCell(lead: string, line: string, cells: number, W: number): number {
	const leadW = leadWidth(lead);
	const row = [...(lead + line)];
	let w = 0;
	let marker = 0;
	let inserted = false;
	let i = 0;
	while (i < row.length) {
		const ch = row[i]!;
		if (ch === "\x1b") {
			i += 1;
			while (i < row.length && row[i] !== "m") i += 1;
			i += 1;
			continue;
		}
		if (!inserted && w >= leadW + cells) {
			marker = w;
			inserted = true;
		}
		const cw = charWidth(ch.codePointAt(0)!);
		if (w + cw > W - 4) break;
		w += cw;
		i += 1;
	}
	if (!inserted) marker = w;
	return marker;
}

/** The probe — one real tuple through both math paths. */
class CursorProbe {
	constructor(
		readonly label: string,
		readonly W: number,
		/** the raw lead (the brick / the question) — null when the panel
		 *  owns the row (the lead derives from the live panel state) */
		readonly lead: string | null,
		/** the keys to reach the panel phase ("", "2", "3\t") */
		readonly panelKeys: string | null,
		readonly text: string,
		readonly cursorIndex: number,
	) {}

	run(): void {
		Object.defineProperty(process.stdout, "columns", { value: this.W, configurable: true });

		// ---- the EDITOR path: the real editor, the real dockState ----
		const editor = new Editor(() => {});
		if (this.panelKeys !== null) {
			editor.beginPanel(PANEL_VIEW, () => {});
			editor.feed(enc(this.panelKeys)); // the phase keys (2 → rule, 3\t → amend)
		}
		editor.feed(enc(this.text));
		for (let k = [...this.text].length - this.cursorIndex; k > 0; k -= 1) {
			editor.feed(enc("\x1b[D"));
		}
		const st = editor.dockState();
		const panelState = editor.panelState();
		const lead = panelState !== null ? panelLead(panelState.view, panelState.phase, panelState.cursor) : this.lead!;
		const leadW = leadWidth(lead);
		// the contract: wallL + leadWidth(lead) + cells + 1 — the cursor's
		// TRUE column in the line (the editor's own math; unclamped)
		const formula = 3 + leadW + st.cursor;
		// the FRAME's marker: the walk's cell (the in-reach case IS the
		// formula; when the editor's slice overflows the frame's budget the
		// walk stops at the W−4 cap and the marker rests at the box edge)
		const expectedMove = 3 + markerCell(lead, st.line, st.cursor, this.W);

		// ---- the COMPOSITOR path: the same dockState bound to the frame ----
		const { body, writes, tick } = makeBody({ W: this.W });
		body.bindInput(() => editor.dockState(), this.lead ?? "");
		if (panelState !== null) body.bindApproval(() => editor.panelState());
		body.enter();
		writes.length = 0; // the first frame is the full-redraw (CUP allowed there)
		body.raw(["x"]); // an open cell → the steady frame
		tick();
		const bytes = writes.join("");
		// the frame's final move is the CHA to the marker — the cursor and
		// the marker at the SAME column (the retired afterW CUB's base —
		// the last write's end column — clamped at col 1: the A3 finding)
		expect(finalCursorMove(bytes), `${this.label}: the frame parks the cursor at the marker (the retired afterW CUB clamps at col 1)`).toBe(
			expectedMove,
		);
		expect(bytes).not.toContain("kiso-cur"); // the APC marker never reaches the stream
		expect(bytes).toContain(`\x1b[2m│ \x1b[0m${lead}`); // the lead rides inside the box's left wall
		// the A3 guards: the cursor never parks BEFORE the lead's end (the
		// pre-fix CUB clamped at col 1 — left of the ›), and never past
		// the cursor's TRUE column (the marker rides at or left of it)
		expect(expectedMove).toBeGreaterThanOrEqual(3 + leadW);
		expect(expectedMove).toBeLessThanOrEqual(formula);
		// the row is exactly W — invariant ① holds (the frame would have
		// THROWN on an overflow; the pad completes the box row)
		expect(expectedMove).toBeLessThanOrEqual(this.W);

		// editCol — the FORMULA, unclamped (the editor's own math wants the
		// cursor's true column in the line; the marker's edge-clamp is a
		// frame-visibility limit, never a cursor-bookkeeping change)
		expect(body.editCol(), `${this.label}: editCol shares the frame-derived formula`).toBe(formula);

		// ---- the editor's own SELF-RENDER path (wallL = 0): the editor
		// renders ITS row — the panel lead when the panel owns the keys,
		// the brick otherwise (the dock-bound question never reaches the
		// editor's own row) ----
		const selfLead = panelState !== null ? panelLead(panelState.view, panelState.phase, panelState.cursor) : PROMPT;
		const selfWrites: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			selfWrites.push(String(chunk));
			return true;
		});
		editor.selfRender();
		spy.mockRestore();
		const selfMove = [...selfWrites.join("").matchAll(/\x1b\[(\d+)G/g)].map((m) => Number(m[1])).at(-1);
		expect(selfMove, `${this.label}: the editor's self-render parks at the same cell (wallL = 0)`).toBe(
			Math.min(1 + leadWidth(selfLead) + st.cursor, this.W),
		);
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** The leads the CLI/panel bind: the brick "› ", the question (the trust
 *  fallback), and — MOVED, the TUI2-R3v2 panel-selection supersession
 *  class — the panel's two. "1-3> " and "2 Yes, don't ask again for "
 *  are retired with the input-box model that needed them: the list phase
 *  leads with the quiet chevron because it is asking for no input, and
 *  the ONE typed phase leads "amend› ". The contract under test (marker
 *  == editor cursor == editCol, at the frame-derived column) is
 *  unchanged; only which leads exist to test it against moved. */
/** The panel leads' narrow width must hold the panel BLOCK's option row
 *  (≥ 47 cells — the A6 widthCut-family rendering, tracked separately);
 *  the frame leads (brick/question) narrow to 44. */
const LEADS: { label: string; lead: string | null; panelKeys: string | null; narrowW: number }[] = [
	{ label: "brick", lead: "› ", panelKeys: null, narrowW: 44 },
	{ label: "question", lead: "trust this project's .kiso? (y/n) ", panelKeys: null, narrowW: 44 },
	{ label: "panel-choice", lead: null, panelKeys: "", narrowW: 48 },
	{ label: "panel-amend", lead: null, panelKeys: "4", narrowW: 48 },
	{ label: "panel-amend-tab", lead: null, panelKeys: "\t", narrowW: 48 },
];

const LINES: { text: string; cursors: number[] }[] = [
	{ text: "abc", cursors: [0, 2, 3] },
	// the CJK line — escaped literals (the tree's CJK-free gate counts
	// code points, not runtime strings; the escapes parse to the same
	// charWidth=2 code points the editor measures)
	{ text: "\u4e2da\u4e2d", cursors: [0, 2, 3] },
];

const WIDTHS = (narrowW: number) => [narrowW, 100];

describe("W23 — the cursor contract: the frame-derived column (wallL + leadWidth(lead) + cells + 1)", () => {
	for (const t of LEADS) {
		for (const line of LINES) {
			for (const idx of line.cursors) {
				for (const W of WIDTHS(t.narrowW)) {
					const label = `${t.label} × ${line.text} cursor ${idx} @ ${W}`;
					it(`${label}: the marker, the editor's cursor, and editCol share the frame-derived column`, () => {
						new CursorProbe(label, W, t.lead, t.panelKeys, line.text, idx).run();
					});
				}
			}
		}
	}

	it("the long answer under the question lead: the frame never trips invariant ① — the walk caps at W−4 and the cursor rests at the marker (the box's inner edge)", () => {
		new CursorProbe("question × long-ASCII", 44, "trust this project's .kiso? (y/n) ", null, "x".repeat(40), 40).run();
	});

	it("the long CJK answer under the question lead: the same cap — the wide chars scroll, the marker still lands at the frame-derived column", () => {
		new CursorProbe("question × long-CJK", 44, "trust this project's .kiso? (y/n) ", null, "\u4e2d".repeat(20), 20).run();
	});

	it("the long answer under the panel-amend lead: the cap FOLLOWS the lead in the editor too (the reflow knows the panel lead) — the slice fits W − leadW − 4, the marker at the formula", () => {
		new CursorProbe("panel-amend × long", 48, null, "4", "x".repeat(40), 40).run();
	});
});
