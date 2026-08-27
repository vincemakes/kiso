/**
 * TUI v6 (ADR-0046) — the compositor unit tests: the two crash
 * invariants, the commit bookkeeping (exactly once), the live-region
 * cap scalar (the one sharp edge), the frame-derived cursor marker,
 * the resize full redraw, the zero-timer idle, and the slot occupants
 * (approval / menu). The e2e gates pin the SCREEN consequences (the
 * VT emulator); these pin the BYTES and the scalar directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";
import { CAP_TASK_LIVE, cellComponent, formatDuration, type FrameCtx, visibleWidth } from "../src/components.js";
import type { PanelView } from "../src/approval-panel.js";

/** The BODY region's left-wall rows ("│ ") — W6: the box's chrome wall
 *  is dim-wrapped (`\x1b[2m│ \x1b[0m`), so the lookbehind excludes it and
 *  the count keeps its old meaning (no left-wall rows in the body). */
function matchBodyWalls(stream: string): string[] {
	return stream.match(/(?<!\x1b\[2m)│ /g) ?? [];
}

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

/**
 * REL-0152-R1 — the SCREEN a stream of frames produces.
 *
 * A diffing renderer writes only the rows that changed, so a case that
 * reads one frame's bytes and expects the whole screen is asking the
 * wrong question. Several cases below were written that way against the
 * old renderer, which repainted every row; each has been converted to
 * assert on what is ON THE SCREEN, which is both what they meant and a
 * stronger claim than what any single write happened to contain.
 */
function screenOf(writes: readonly string[], W = 80, H = 24): string[] {
	const screen = new Screen(W, H);
	screen.feed(writes.join(""));
	return screen.rows.map((r) => r.join("").replace(/\s+$/, ""));
}

beforeEach(() => {
	vi.useFakeTimers();
	// the vitest stdout has none of the TTY shape — define the geometry
	// the compositor's enter gate reads
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

describe("TUI v6 — the one compositor", () => {
	it("the first frame is the full-redraw path: sequential CUP rows, NO pre-clear, the chrome at H−2/H−1/H", () => {
		const { body, writes } = makeBody();
		body.enter();
		const bytes = writes.join("");
		// no pre-clear anywhere — the lab's first-frame scenario
		expect(bytes).not.toContain("\x1b[2J");
		expect(bytes).not.toContain("\x1b[3J");
		// the chrome rows drawn at their rows (24-row screen)
		expect(bytes).toContain("\x1b[22;1H\x1b[0K"); // the status
		expect(bytes).toContain("\x1b[23;1H\x1b[0K"); // the editor
		expect(bytes).toContain("\x1b[24;1H\x1b[0K"); // the footer
		// W6: the box — the rounded corners close the rail
		// R2: both rails are the same dashed rule — two of them, not a
		// top and a bottom that differ.
		expect(bytes.match(/\u254c{4,}/g) ?? []).toHaveLength(2);
		// the synchronized-output wrap is present
		expect(bytes).toContain("\x1b[?2026h");
		expect(bytes).toContain("\x1b[?2026l");
	});

	it("invariant ①: a line that cannot fold crashes with the diagnostic — never a silent truncate", () => {
		const { body, tick } = makeBody({ W: 0 }); // the foldLine's degenerate guard — the line passes through whole
		body.enter();
		body.raw(["x".repeat(50)]);
		expect(() => tick()).toThrow(/kiso-tui invariant ①/);
	});

	it("a frame positions every row it writes ABSOLUTELY — no relative march to misplace", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0; // drop the boot frame
		body.raw(["line one"]);
		tick();
		const bytes = writes.join("");
		// DECLARED SUPERSESSION (REL-0152-R1): invariant ② is RETIRED with
		// the steady path it constrained. It said the live region must be
		// reached by relative moves only, and CUP only in the frozen area
		// — a rule that existed because the steady path could not afford a
		// CUP budget and had to march. What it was protecting is that the
		// live region never lands somewhere other than its model row, and
		// the A7 and unclamped-geometry findings are both cases of a march
		// doing exactly that.
		//
		// Absolute positioning gives that unconditionally: a row written
		// at its model row cannot be misplaced by a base the writer got
		// wrong, because there is no base. So the assertion inverts — what
		// used to be forbidden is now required — and it is the stronger
		// statement of the same property.
		const cups = [...bytes.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
		expect(cups.length, "the frame positioned nothing absolutely").toBeGreaterThan(0);
		expect(cups.every((r) => r >= 1 && r <= 24), "a CUP landed outside the screen").toBe(true);
		// no relative row march survives: the frame never moves by A/B
		expect(bytes, "a relative row move is left in the frame").not.toMatch(/\x1b\[\d*[AB]/);
		expect(bytes).toContain("line one");
	});

	it("an idle no-commit frame leaves the chrome on H−3/H−2/H−1/H — the input-shift regression", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "\u4f60", cursor: 1 }), "\u203a ");
		body.textAppend("live"); // an OPEN cell — no commit
		tick();
		// DECLARED SUPERSESSION (REL-0152-R1). This used to assert the
		// frame's exact opening bytes — a 2B relative jump from the
		// recorded anchor — because the renderer reached the chrome by
		// marching there. It does not march any more; it writes the rows
		// that changed, at absolute positions. What the case is FOR is
		// unchanged and is now asserted where it is true: the real-machine
		// report was that the input box SHIFTED, the buggy frame put the
		// status at H−1 and the input at H−3, and the screen says whether
		// that happened.
		const rows = screenOf(writes);
		expect(rows[20], "the top rail is not on H−3").toMatch(/\u254c/);
		expect(rows[21], "the input row is not on H−2").toContain("›");
		expect(rows[22], "the bottom rail is not on H−1").toMatch(/\u254c/);
		expect(rows[0], "the live text is not at its model row").toContain("live");
	});

	it("a CJK /think fold never trips invariant ① — the fold cuts by DISPLAY width (the 0.1.33 real-machine crash)", () => {
		const { body, tick } = makeBody();
		body.enter();
		body.thinkingAppend("\u4f60".repeat(101)); // 202 cells at 2 per char — the char slice overflowed
		body.thinkingEnd();
		expect(() => tick()).not.toThrow(); // the widthCut line fits W; the old slice THREW
	});

	it("a SHORT /think fold at a narrow width never trips invariant ① — the ≤100 short-circuit must respect W (the crash still live on npm)", () => {
		const { body, tick } = makeBody({ W: 20 });
		body.enter();
		body.thinkingAppend("T".repeat(100)); // ≤100 chars — the SHORT-CIRCUIT branch, W-blind
		body.thinkingEnd();
		expect(() => tick()).not.toThrow(); // the fold now width-cuts; the raw 100-char line THREW at W=20
	});

	it("a committed line reaches the terminal's scrollback exactly once", () => {
		const { body, writes, tick } = makeBody({ W: 40, H: 8 });
		body.enter();
		for (let i = 0; i < 12; i += 1) {
			body.raw([`committed ${i}`]);
			tick();
		}
		// DECLARED SUPERSESSION (REL-0152-R1). This used to assert the
		// commit frame's exact scroll bytes: pre-scroll ELs, a CUP to H,
		// then exactly N real LFs, one per committed line. The scroll is
		// no longer keyed to the commit count — it is keyed to the FLOOR,
		// the one-way part of the window's movement — and a case that
		// names the retired arithmetic can only ever fail.
		//
		// The property that arithmetic existed to protect is the one
		// asserted here, and it is the stronger claim: the scrollback is
		// the transcript, so a committed line must arrive there, and
		// exactly once. The old shape could be satisfied by a frame that
		// scrolled the right NUMBER of wrong rows — which is precisely the
		// defect REL-0152-D7 turned out to be.
		const screen = new Screen(40, 8);
		screen.feed(writes.join(""));
		// matched as WHOLE lines: "committed 1" is a substring of
		// "committed 10" and "committed 11", and counting substrings
		// reported a threefold duplication that was not there
		const lines = screen.allLines().map((l) => l.replace(/\s+$/, ""));
		for (let i = 0; i < 12; i += 1) {
			const n = lines.filter((l) => l === `committed ${i}`).length;
			expect(n, `committed ${i} appears ${n} times in scrollback+screen`).toBe(1);
		}
	});

	it("the steady frame draws the LIVE lines at their MODEL rows — CUP, never the relative march (the unclamped geometry: liveTop=1)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0;
		body.textAppend("streaming line");
		tick();
		// REL-0152-R1: asserted on the SCREEN. The property is that the
		// streamed text is VISIBLE at its model row — the defect was a
		// relative march drawing it at row 20 where the gap erased it —
		// and the screen is where that is true or false.
		const rows = screenOf(writes);
		expect(rows[0], "the streamed text is not at its model row").toContain("streaming line");
		expect(rows[1], "the row below the live bottom is not clear").toBe("");
	});

	it("the gap ELs stop above the menu — the menu rows survive the unclamped geometry", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0; // the first frame is the full-redraw — its gap may EL the menu row before the menu CUP
		body.bindMenu(() => ({
			items: [{ name: "/mode", desc: "switch the approval tier" }],
			selected: 0,
		}));
		body.raw(["x"]);
		tick();
		// REL-0152-R1: the property is that the menu row SURVIVES on the
		// screen — the defect erased it with a gap EL. Reading the screen
		// says that directly, where the old byte-shape assertion said it
		// by naming the one write that would have destroyed it.
		const rows = screenOf(writes);
		expect(rows[19], "the menu row was erased by the gap").toContain("/mode");
	});

	it("a done cell's lines emit EXACTLY once — the freeze frame writes them, later frames never re-emit", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.raw(["frozen line"]);
		tick(); // the freeze frame
		expect(writes.join("").split("frozen line").length - 1).toBe(1);
		body.notice("another line");
		tick();
		expect(writes.join("").split("frozen line").length - 1).toBe(1); // still once
	});

	it("the live region's hard cap H−1: a super-tall output force-commits the oldest live cell; liveCount() ≤ H−1", () => {
		const { body, tick } = makeBody(); // H = 24 → the cap binds at 20 content lines
		body.enter();
		const tall = Array.from({ length: 30 }, (_, i) => `tall line ${String(i).padStart(2, "0")}`).join("\n");
		body.textAppend(tall); // one open text cell of 30 lines
		tick();
		expect(body.liveCount()).toBeLessThanOrEqual(24 - 1);
	});

	it("the cursor derives from the frame: the CHA lands at the marker's frame-derived column; the marker never reaches the stream", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "abc", cursor: 1 }), "\u203a ");
		body.raw(["x"]);
		tick();
		const bytes = writes.join("");
		expect(bytes).not.toContain("kiso-cur"); // the APC marker is stripped
		// REL-0161: the drawn cursor wraps the cell at the marker — read through it
		expect(bytes.replace(/\x1b\[(?:7|27)m/g, "")).toContain("› abc"); // the prompt + the line, marker stripped
		// W23: the cursor move is the CHA to the frame-derived column —
		// wallL (2) + the lead "/ commands · \u2191 history" (2) + the cursor (1) + 1 = 6 — the
		// absolute column lands at the marker from ANY base (the retired
		// afterW CUB's base — the last write's end column — clamped at
		// col 1 in the steady frame: the A3 finding)
		expect(bytes).toContain("\x1b[4G"); // R2: wallL is 0
	});

	it("W21: the panel slot — the block displaces the live region, the input lead swaps, the status derives from the phase; clearing restores the prompt", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "", cursor: 0 }), "\u203a ");
		const panelView: PanelView = {
			flavor: "approval",
			name: "edit_file",
			title: "edit examples/foo.ts",
			speaker: "mode:default",
			hint: "/mode accept-edits auto-approves edits",
			statusText: "⏸ run paused", // R2 (design §4): the pending mark
			args: { kind: "text", lines: ["old", "new"] },
			fallbackQuestion: "approve edit_file? (y/n) ",
		};
		body.bindApproval(() => ({ view: panelView, phase: "options", cursor: 0 }));
		body.raw(["x"]);
		tick();
		const bytes = writes.join("");
		const plain = bytes.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the panel header names the act; view.name stays raw for the
		// option-2 rule prefill and the dock-less fallbackQuestion.
		expect(plain).toContain("edit needs approval"); // the rule line
		// MOVED (the TUI2-R3v2 panel-selection supersession class): "1-3> "
		// was a prompt for input the panel no longer asks for, and the
		// affordance is the v4 hint line. The slot swap is proven by what
		// the row SAYS rather than by the absence of a chevron: the options
		// phase leads with the DIM chevron where the composer's is bold, so
		// the bytes differ even though the glyph does not.
		// DECLARED SUPERSESSION (R2): the panel's idle lead is EMPTY. The
		// composer dropped its chevron this round, so a panel that kept one
		// would be the one surface reintroducing it. The slot swap is
		// proven by what the row SAYS, which is what the note above already
		// argued it should be — the chevron was never the evidence.
		expect(bytes).not.toContain("\x1b[2m› \x1b[0m");
		expect(plain).toContain("⏸ run paused"); // the phase status (the CLI's painting status is out)
		expect(plain).toContain("↑↓ move · ⏎ or click confirms · 1-4 instant · esc"); // the phase affordance
		body.bindApproval(() => null);
		body.raw(["y"]);
		tick();
		// R2: clearing the panel restores the COMPOSER's row, which has no
		// lead glyph at all — so what proves the restore is the composer's
		// own rails and the idle hint, not a chevron.
		expect(writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).toContain("/ commands · ↑ history");
	});

	it("the MenuSelect slot: the menu rows render above the status while open, none over the editor", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindMenu(() => ({
			items: [
				{ name: "/mode", desc: "switch the approval tier" },
				{ name: "/model", desc: "list model profiles" },
			],
			selected: 0,
		}));
		body.raw(["x"]);
		tick();
		const bytes = writes.join("");
		const rows = screenOf(writes); // REL-0152-R1: the screen, not one frame
		expect(rows.join("\n")).toContain("/mode");
		expect(rows.join("\n")).toContain("/model");
		// DECLARED SUPERSESSION (REL-0152-R1): this used to assert the
		// EMISSION ORDER — status first, then the menu rows last-first,
		// then the content — because the renderer reached them by marching
		// upward from the bottom. A diff emits by row number, top down, so
		// the order is reversed and asserting it can only fail.
		//
		// What the order was protecting is a PLACEMENT: the menu sits
		// above the box top and never over the editor row. That is a fact
		// about the screen, it is what the case is named for, and it is
		// true or false regardless of the order the rows were written in.
		// R2: the BAND names itself with a dashed rule too, so the box top
		// is the UNBROKEN rule — a rule with a word in it is a band header.
		const boxTopAt = rows.findIndex((r) => /^\u254c+\s*$/.test(r.replace(/\x1b\[[0-9;]*m/g, "")));
		const modeAt = rows.findIndex((r) => r.includes("switch the approval tier"));
		const modelAt = rows.findIndex((r) => r.includes("list model profiles"));
		expect(boxTopAt, "no box top on the screen").toBeGreaterThan(0);
		expect(modeAt, "the /mode row is not above the box top").toBeLessThan(boxTopAt);
		expect(modelAt, "the /model row is not above the box top").toBeLessThan(boxTopAt);
		expect(modeAt, "the menu rows are out of order").toBeLessThan(modelAt);
		expect(rows[21], "the menu overlays the editor row").not.toContain("/mode");
		expect(bytes.length).toBeGreaterThan(0);
	});

	it("the resize: ED0 from the recorded live top + the full CUP redraw — zero LF, zero 3J, idempotent", () => {
		const { body, writes } = makeBody();
		body.enter();
		body.raw(["frozen"]);
		writes.length = 0;
		body.onResize();
		vi.advanceTimersByTime(100); // REL-0152-D18: the drag settles, then it repaints
		const bytes = writes.join("");
		expect(bytes).toContain("\x1b[0J"); // the ED0 clear of the old live area
		expect(bytes).not.toContain("\x1b[3J");
		expect(bytes).not.toContain("\n"); // zero LF
		expect(bytes).toMatch(/\x1b\[\d+;\d+H/); // the CUP full redraw
		expect(bytes).toContain("frozen"); // the committed line drawn at the resize
		// idempotent: a second resize has the same shape — and V6-1's
		// every-row rule re-paints the committed content (the screen-state
		// == frame-state), so the "frozen" IS re-emitted — the SCREEN is
		// the invariant, never the byte count.
		writes.length = 0;
		body.onResize();
		vi.advanceTimersByTime(100); // REL-0152-D18: the drag settles, then it repaints
		expect(writes.join("")).toContain("\x1b[0J");
		expect(writes.join("")).toContain("frozen");
	});

	it("the resize with a force commit: the frozen bound counts the cells committed BEFORE the frame — the committed content re-paints on the winch (the V6-1 frozen-loop bug), and the A8 march bound WINDOWS the model", () => {
		const { body, writes, tick, setSize } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.raw(["frozen banner"]); // the committed content — one line
		// a tall OPEN cell: 15 placed lines at 24 rows (the content cap
		// binds at 20) — stays LIVE at 80×24, and the winch to 18 rows (the
		// cap binds at 14) force-commits it AT the resize frame
		// MOVED ASSERTION, the markdown-render class (TUI2-MD ⑤): the fixture
		// gains its list markers. Assistant body text is markdown now, and N
		// consecutive PROSE lines are ONE paragraph that REFLOWS — so the old
		// fixture no longer produces N rows, which is what this test needs. A
		// list is the same shape in the new model: one open block, one row per
		// item, no reflow. The assertions themselves are unchanged.
		body.textAppend(Array.from({ length: 15 }, (_, i) => `- tall line ${String(i).padStart(2, "0")}`).join("\n"));
		tick();
		writes.length = 0;
		setSize(40, 18);
		body.onResize();
		vi.advanceTimersByTime(100); // REL-0152-D18: the drag settles, then it repaints
		const bytes = writes.join("");
		// the buggy bound — `#committed − committed.length` (cells minus
		// LINES): the force commit's 15 lines made it negative, the frozen
		// loop skipped every previously-committed cell — the banner vanished
		// from the repaint, and a second resize would re-paint it (not
		// idempotent). The A8 march bound then WINDOWS the model: 17
		// committed + 4 chrome = 21 lines at 18 rows → the window shows the
		// last 18 (tall 01..14 + the chrome); the banner and tall 00 sit
		// ABOVE the window. A8b: the fresh leaving share (tall 00 — its old
		// row held the live cell) is pre-painted at its OLD row so the LF
		// scroll carries it into the scrollback; the banner (the frozen
		// share — already on the old screen) scrolls as the old screen's
		// copy, never a re-paint. The march never re-paints them — the
		// window's first line is tall 01.
		// DECLARED SUPERSESSION (REL-0152-R1): the A8b PRE-PAINT is gone.
		// It staged a leaving row at its old position so the LF scroll
		// would carry it into the scrollback; a resize now emits no scroll
		// of ours at all, because shrinking the window is the terminal's
		// own scroll — it reflows and pushes the overflow before we are
		// called, and adding LFs on top put the same rows in twice.
		//
		// What the case is FOR is the A8 windowing rule, and that is
		// asserted on the screen: the model is windowed to its last H
		// rows, so the banner and tall 00 are ABOVE the window and the
		// window's first line is tall 01. The V6-1 frozen-loop bug it also
		// guards — the committed content vanishing from the repaint — is
		// the same assertion read the other way.
		const rows = screenOf(writes, 40, 18);
		expect(rows[0], "the window's first line is not tall 01").toContain("tall line 01");
		expect(rows.join("\n"), "the banner is inside the window").not.toContain("frozen banner");
		expect(rows.join("\n")).toContain("tall line 14");
		expect(rows[14], "the top rail is not at H−3").toMatch(/\u254c/);
		expect(rows[17], "the status is not at H").not.toBe("");
		// idempotent: a second resize (CLAMPED — the window is the whole
		// model, skip 0) re-paints the SAME committed content, banner
		// included — the windowing rule is exactly skip = total − H. The
		// model total counts the W11 spacing blank between the two cells:
		// banner + blank + 15 tall lines + 4 chrome = 21 → the clamped
		// bound is H = 21 (at 20 the banner is a line above the window).
		writes.length = 0;
		setSize(40, 21);
		body.onResize();
		vi.advanceTimersByTime(100); // REL-0152-D18: the drag settles, then it repaints
		expect(screenOf(writes, 40, 21).join("\n")).toContain("frozen banner");
	});

	it("zero timers: no mutation → no bytes, even after 10 seconds", () => {
		const { body, writes } = makeBody();
		body.enter();
		writes.length = 0;
		vi.advanceTimersByTime(10_000);
		expect(writes.join("")).toBe("");
	});

	it("the spinner is an on-demand one-shot: bytes only while a running tool exists, and they stop with it", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("read_file", "c1", {});
		body.toolRunning("c1");
		tick();
		// W2: the frame coalesces straight to running — the spinner IS the
		// gutter (the old assertion matched the running row's "→ " prefix)
		expect(writes.join("").replace(/\x1b\[[0-9;]*m/g, "")).toContain("▖ read");
		expect(writes.join("")).toContain("▖"); // the spinner glyph rides the running line
		body.toolResult("c1", { content: "ok", isError: false });
		vi.advanceTimersByTime(16); // the toolResult's coalesced frame lands
		expect(writes.join("").replace(/\x1b\[[0-9;]*m/g, "")).toContain("  read");
		writes.length = 0;
		vi.advanceTimersByTime(2_000);
		// the tool ended — no timer re-arms — the idle emits nothing
		expect(writes.join("")).toBe("");
	});

	// ---- TUI v7 — the flow contract (W7, W8, W10; the work order §4) ----

	// MOVED (R1.5 slice ④, the settled-shell-body class — DECLARED THIS
	// ROUND): W7's five-row cap on the SETTLED shell tail is retired
	// because the settled tail is. VD-5: a completed shell kept its last
	// rows plus "+N earlier rows · ctrl+r" for the rest of the session, so
	// three shells owned a screen. The cap's real subject — a settled
	// shell must never own more than a bounded number of rows — is now
	// pinned at its limit: ONE row, at every width. The whole output is
	// behind ctrl+r, and the head row says how much.
	it("R1.5 ④: the settled shell owns exactly ONE row at every width — the tail is behind the key", () => {
		const output = Array.from({ length: 30 }, (_, i) => `shell line ${String(i).padStart(2, "0")} ` + "x".repeat(52)).join("\n");
		for (const W of [120, 60]) {
			const { body, writes, tick } = makeBody({ W });
			body.enter();
			body.toolStart("shell", "c1", { command: "run" });
			body.toolRunning("c1");
			body.toolResult("c1", { content: output, isError: false });
			tick();
			const frame = writes.join("");
			expect(frame, `W=${W}`).not.toContain("earlier rows");
			expect(matchBodyWalls(frame), `W=${W}`).toHaveLength(0);
			// the head row names what it is holding, and the key that shows it
			expect(frame, `W=${W}`).toContain("ctrl+r");
			expect(frame, `W=${W}`).not.toContain("shell line 29");
		}
	});

	it("W7: the approval diff caps at 12 folded rows — head + the named middle + tail (the R1 measured bug)", () => {
		// the work order §6 reproduction: 60 entries of ~80 chars — the old
		// renderer folded them to 73 SCREEN rows at W=60 (a 44-row terminal's
		// content cap is H−4 = 40 — the approval force-committed a third of
		// the screen into scrollback inside one frame)
		const diff = Array.from({ length: 60 }, (_, i) => ({
			kind: (i % 2 ? "+" : "-") as "-" | "+",
			text: "\t\tconst someReasonablyLongIdentifier" + i + " = await doTheThing(argumentOne, argumentTwo, { option: true });",
		}));
		for (const W of [120, 80, 60]) {
			const { body, writes, tick } = makeBody({ W });
			body.enter();
			body.toolStart("edit_file", "c1", { path: "x" });
			body.toolApproval("c1", { lines: diff, added: 30, removed: 30 });
			tick();
			const frame = writes.join("");
			const cut = frame.match(/└ \+(\d+) rows · ctrl\+r to expand/);
			expect(cut).not.toBeNull();
			// the head + the named middle + the tail = 12 rows total
			expect(matchBodyWalls(frame).length + 1).toBeLessThanOrEqual(12);
			// the head AND the tail survive (the truncated middle is named)
			expect(frame).toContain("Identifier0");
			expect(frame).toContain("Identifier59");
		}
	});

	it("W17: the cap is a ROW budget at every width — at W=24 the └ cut is ONE truncated line (a folded cut pushed the total past 12), never a fold", () => {
		// The same W7 diff at W=24: each ~96-char line folds to ~5 rows;
		// the pair still shows 3 source lines (1 head + 2 tail — AT the
		// floor), so the pair form survives — but the OLD cut row folded
		// too (~48 chars → 3 rows → 5+3+6 = 14 > 12). W17: the cut is
		// oneLineRow — truncated, never folded — the budget holds.
		const diff = Array.from({ length: 60 }, (_, i) => ({
			kind: (i % 2 ? "+" : "-") as "-" | "+",
			text: "\t\tconst someReasonablyLongIdentifier" + i + " = await doTheThing(argumentOne, argumentTwo, { option: true });",
		}));
		const { body, writes, tick } = makeBody({ W: 24 });
		body.enter();
		body.toolStart("edit_file", "c1", { path: "x" });
		body.toolApproval("c1", { lines: diff, added: 30, removed: 30 });
		tick();
		const frame = writes.join("");
		// the row budget holds at 12: 5 head + 1 cut + 6 tail
		expect(matchBodyWalls(frame).length + 1).toBeLessThanOrEqual(12);
		// the cut is ONE row: the truncated head of the text survives, the
		// foldable tail is GONE (a folded cut would contain the full text)
		const cut = frame.match(/└ \+(\d+) rows · ctrl\+r/);
		expect(cut).not.toBeNull();
		expect(frame).not.toContain("/last for the full diff");
		// the pair survives at the floor: head AND tail both present
		expect(frame).toContain("Identifier0");
		expect(frame).toContain("Identifier59");
	});

	it("W17: below a floor of 3 source lines visible, the head/tail pair collapses to the head only — the └ row carries the rest", () => {
		// 200-char lines at W=24 fold to ~10 rows each: the pair would show
		// 1 head + 1 tail source line — two slivers of long lines, noise.
		// W17: drop to the head only — the head takes the whole budget
		// (11 rows), the └ row names the rest; the tail is GONE.
		const diff = Array.from({ length: 60 }, (_, i) => ({
			kind: (i % 2 ? "+" : "-") as "-" | "+",
			text: `line${String(i).padStart(2, "0")} ` + "x".repeat(190),
		}));
		const { body, writes, tick } = makeBody({ W: 24 });
		body.enter();
		body.toolStart("edit_file", "c1", { path: "x" });
		body.toolApproval("c1", { lines: diff, added: 30, removed: 30 });
		tick();
		const frame = writes.join("");
		// the row budget: 11 head rows + the one-line └ cut = 12
		expect(matchBodyWalls(frame).length + 1).toBeLessThanOrEqual(12);
		expect(frame).toContain("line00"); // the head survives
		expect(frame).not.toContain("line59"); // the tail is dropped — no pair
		const cut = frame.match(/└ \+(\d+) rows · ctrl\+r/);
		expect(cut).not.toBeNull(); // the └ row carries the rest
		expect(frame).not.toContain("/last for the full diff"); // one row, never a fold
	});

	it("W7: the error text caps at 3 head rows (the header already shows line 1 — the body starts at line 2); a read result renders NO body", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("shell", "c1", { command: "lint" });
		body.toolRunning("c1");
		const err = Array.from({ length: 6 }, (_, i) => `lint error ${i + 1}: something went wrong here`).join("\n");
		body.toolResult("c1", { content: err, isError: true });
		tick();
		const frame = writes.join("");
		// the head (the answer is at the start): the body starts at line 2,
		// capped at 3 rows — the tail is cut, the cut names "+3 more"
		expect(frame).toContain("lint error 2");
		expect(frame).toContain("└ +3 more · ctrl+r");
		expect(frame).not.toContain("lint error 6");
		expect(matchBodyWalls(frame).length).toBeLessThanOrEqual(3);
		// a read result: the settled row carries the count — zero body rows
		const b2 = makeBody();
		b2.body.enter();
		b2.body.toolStart("read_file", "c1", { path: "x" });
		b2.body.toolRunning("c1");
		b2.body.toolResult("c1", { content: "some file content", isError: false });
		b2.tick();
		expect(b2.writes.join("")).not.toContain("some file content");
	});

	it("W10: the TOOL's own cut is named — a truncated read surfaces the continuation note the model sees", () => {
		// read_file caps at DEFAULT_READ_LINES=200 and appends the offset note
		// (tools-node) — the note reaches the model, never the human; the
		// settled row must surface it (a DIFFERENT fact from the renderer cut)
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("read_file", "c1", { path: "x" });
		body.toolRunning("c1");
		const content = Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n") + "\n… 50 more lines (call again with offset=201)";
		body.toolResult("c1", { content, isError: false });
		tick();
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the advisory is addressed to the human, so it names the act; the
		// actionable half (offset=201) is untouched.
		expect(writes.join("")).toContain("└ capped by read · offset=201 for the rest");
	});

	it("W8: the running tool's window is a FIXED 3 rows from the first frame — the height never changes while running", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("shell", "c1", { command: "sleep" });
		body.toolRunning("c1");
		tick();
		// the window: 2 blank-padded rows + the waiting row — 3 total.
		// W6: the box's chrome wall is the SAME bytes as a blank window
		// row (`\x1b[2m│ \x1b[0m`), so the 2-blank probe is the ADJACENT
		// pair — the two blanks are the only dim walls that are neighbors
		// at the row level (the row prefix — a CUP/relative move + a 0K —
		// sits between them); the box's single wall never pairs.
		// DECLARED SUPERSESSION (REL-0152-R1): asserted on the SCREEN. The
		// old shape counted adjacent dim-wall pairs in one frame's bytes,
		// which only works while every frame repaints every row. The
		// property — a running tool owns a FIXED three rows, and the
		// height never changes while it runs — is about the screen, and
		// the second frame's job is to prove it did not move.
		const before = screenOf(writes);
		expect(before.join("\n")).toContain("└ waiting for output");
		const windowTop = before.findIndex((r) => r.includes("shell"));
		expect(windowTop, "the tool window is not on the screen").toBeGreaterThanOrEqual(0);
		const waitingAt = before.findIndex((r) => r.includes("└ waiting for output"));
		// the head row, then the two blank-padded rows, then the waiting
		// row: the waiting row sits three below the head
		expect(waitingAt - windowTop, "the running window is not 3 rows").toBe(3);
		// a SECOND frame (the spinner tick): the window has NOT moved
		vi.advanceTimersByTime(200);
		const after = screenOf(writes);
		expect(after.findIndex((r) => r.includes("shell"))).toBe(windowTop);
		expect(after.findIndex((r) => r.includes("└ waiting for output"))).toBe(waitingAt);
	});

	it("W18: the compacting status row — the indeterminate form with the right-aligned cancel hint (the #16g hint cut first at a narrow width, then the status with the … — never a fold)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.setStatus("▘ compacting · 12 rounds · ~48.2k tokens · 6s", "esc to cancel");
		tick();
		// the LAST frame is what the terminal shows — the setStatus frame is
		// the steady path: a [2B jump from the anchor, then the bottom-up
		// repaint whose FIRST 1G write is the status at H (the full-redraw
		// path writes an absolute [24;1H instead — the enter frame's IDLE
		// status must never win the parse)
		const sgrStripped = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
		const frame = sgrStripped.slice(sgrStripped.lastIndexOf("\x1b[?2026h"));
		const m = frame.match(/\x1b\[24;1H\x1b\[0K([^\x1b]*)/) ?? frame.match(/\x1b\[2B\x1b\[1G\x1b\[0K([^\x1b]*)/);
		const row = m?.[1] ?? "";
		// the status row at H (24): the text with the hint right-aligned
		expect(row.startsWith("▘ compacting · 12 rounds · ~48.2k tokens · 6s")).toBe(true);
		expect(row.endsWith("esc to cancel")).toBe(true);
		// the idle state's hint returns when the status is set WITHOUT one
		writes.length = 0;
		body.setStatus("▸ default · /mode to switch · faux · ctx left ~100%");
		tick();
		const idleRow = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
		expect(idleRow).toContain(" / commands · ↑ history");
	});

	it("W12: the delegate's child sessions collapse to ONE body row — running (the input's roles — the only live data the parent holds) and settled (the extension's summary marker) replace in place, so the height never changes", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("delegate", "c1", {
			tasks: [
				{ role: "explorer", task: "map the surface" },
				{ role: "implementer", task: "land the change" },
				{ role: "reviewer", task: "check the diff" },
			],
		});
		body.toolRunning("c1");
		tick();
		// the running frame: ONE body row, derived from the input — no
		// live channel to a running child exists, so the spec's "<child's
		// current tool>" has no event source; the roles are the honest data
		expect(writes.join("")).toContain("└ 3 children · explorer · implementer · reviewer");
		expect(matchBodyWalls(writes.join("")).length).toBe(0); // no live window, no fold
		writes.length = 0;
		// the settled frame: the SAME single row slot, now the summary
		// marker from the delegate's blob
		body.toolResult("c1", {
			content:
				"summary: 12 tool calls · 3 roles · 0 failed\n" +
				"[subagent] explorer: map the surface\n  outcome: completed\n  tools: 5\n" +
				"[subagent] implementer: land the change\n  outcome: completed\n  tools: 4\n" +
				"[subagent] reviewer: check the diff\n  outcome: completed\n  tools: 3",
			isError: false,
		});
		tick();
		const settled = writes.join("");
		expect(settled).toContain("└ 12 tool calls · 3 roles · 0 failed · /last for the report");
		expect(matchBodyWalls(settled).length).toBe(0);
		// an old extension's result (no marker) falls back to no body —
		// the height contract never grows the block
		body.toolStart("delegate", "c2", { tasks: [{ role: "explorer", task: "x" }] });
		body.toolRunning("c2");
		body.toolResult("c2", { content: "[subagent] explorer: x\n  outcome: completed\n  tools: 1", isError: false });
		tick();
		expect(writes.join("")).not.toContain("└ 1 child");
	});

	it("W11: spacing is a formula — one-row siblings pack tight, multi-row blocks breathe on both sides, the first cell never gets the blank above", () => {
		// The final screen's rows, replayed from the writes (each row's LAST
		// write wins — the CUP writes + the gap/stale ELs reproduce the
		// screen, the way the VT emulator sees it).
		const { body, writes, tick } = makeBody();
		body.enter();
		// R2: a banner with no extensions and no bound model is now ONE row
		// (`kiso 0.1.37`), and a one-row cell packs tight by W11's own
		// formula — which would make this test assert the opposite of its
		// subject. It is given the shape the CLI actually builds, so the
		// cell is multi-row and "breathes on both sides" is still what is
		// under test.
		body.banner("0.1.37", "[1 extension: asky]");
		body.userLine("go");
		body.toolStart("read_file", "c1", { path: "x" });
		body.toolRunning("c1");
		body.toolResult("c1", { content: "1 line", isError: false });
		body.toolStart("list_dir", "c2", { path: "." });
		body.toolRunning("c2");
		body.toolResult("c2", { content: "2 entries", isError: false });
		tick();
		let rows: string[] = [];
		{
			const screen = new Map<number, string>();
			const stripped = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
			for (const m of stripped.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*)/g)) {
				screen.set(Number(m[1]!), m[2]!);
			}
			rows = Array.from({ length: 21 }, (_, i) => screen.get(i + 1) ?? "");
		}
		// the first cell (the banner): NO blank above — the body starts at
		// row 1 (the banner is multi-row, so the blank comes AFTER it)
		expect(rows[0]).not.toBe("");
		const userAt = rows.findIndex((l) => l.trim() === "go"); // the chip strips to " go " (the 2026-08-09 ruling retired the rail)
		expect(rows[userAt - 1]).toBe(""); // the banner (multi-row) breathes below
		const readAt = rows.findIndex((l) => l.includes("  read"));
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the card head says the ACT. The tool is still list_dir on the wire.
		const listAt = rows.findIndex((l) => l.includes("  list "));
		expect(readAt).toBe(userAt + 1); // one-row user → one-row read: pack tight
		expect(listAt).toBe(readAt + 1); // two one-row tools: pack tight
		// a multi-row block (the 2-line raw recap) breathes on BOTH sides
		body.raw(["first", "second"]);
		body.userLine("again");
		tick();
		rows = [];
		{
			const screen = new Map<number, string>();
			const stripped = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
			for (const m of stripped.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*)/g)) {
				screen.set(Number(m[1]!), m[2]!);
			}
			rows = Array.from({ length: 21 }, (_, i) => screen.get(i + 1) ?? "");
		}
		const rawAt = rows.findIndex((l) => l === "first");
		const againAt = rows.findIndex((l) => l.includes("again"));
		expect(rows[rawAt - 1]).toBe(""); // the blank ABOVE the multi-row block
		expect(rows[rawAt + 2]).toBe(""); // the blank BELOW it (the "second" row + the blank)
		expect(againAt).toBe(rawAt + 3); // the user packs after the blank
	});

	it("W5: the live banner cell carries the resume — the header, the title, the aligned meta, relative now; COMPACT drops the list", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.banner("0.1.37", "", [
			{ title: "fix the resize repaint storm", events: 41, runs: 3, updatedAt: Date.now() },
		]);
		body.userLine("go");
		tick();
		// the screen-map replay: each row's LAST write wins, the way the VT
		// emulator sees the screen
		const screen = new Map<number, string>();
		const sgrStripped = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
		for (const m of sgrStripped.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*)/g)) {
			screen.set(Number(m[1]!), m[2]!);
		}
		// R2 supersession: the banner lost its two wordmark rows and its
		// version row folded into the name row, so the whole cell is three
		// rows shorter and everything below it moves up by three. The
		// SUBJECT — that the resume list sits one blank under the banner and
		// its columns land at exactly W — is untouched and is asserted
		// below exactly as it was.
		// name + blank + "  ✦ resume" + 1 session row = 4 rows
		expect(screen.get(3)).toBe("  ✦ resume");
		// metaW = 18 (the single meta); titleW = 80 - 13 - 18 = 49; pad 21
		expect(screen.get(4)).toBe(
			"    now     fix the resize repaint storm" + " ".repeat(21) + " " + "41 events · 3 runs",
		);
		// the done-when: the row is exactly W wide, the meta at its column
		// (R2: the session row moved from 7 to 4 with the banner's height)
		expect(screen.get(4)!.length).toBe(80);
		expect(screen.get(4)!.indexOf("41 events")).toBe(62);
		// the tier gate is per frame — a COMPACT screen drops the list entirely
		const compact = makeBody({ H: 15 });
		compact.body.enter();
		compact.body.banner("0.1.37", "", [
			{ title: "fix the resize repaint storm", events: 41, runs: 3, updatedAt: Date.now() },
		]);
		compact.tick();
		expect(compact.writes.join("")).not.toContain("✦ resume");
	});

	it("W15: the expand key on a LIVE tool toggles in place — the full approval diff replaces the cut, the second press cuts it back", () => {
		// The live region's toggle window is the non-done cell — an
		// approval diff (its "ctrl+r to expand" affordance is exactly the
		// invite): 15 one-row lines, short enough that the EXPANDED form
		// fits the screen (1 + 15 + chrome ≤ H), tall enough that the
		// 12-row cap cuts it.
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("first");
		body.toolStart("edit_file", "c1", { path: "x.ts" });
		const diff = Array.from({ length: 15 }, (_, i) => ({
			kind: (i % 2 ? "+" : "-") as "-" | "+",
			text: `\t\tconst id${String(i).padStart(2, "0")} = value;`,
		}));
		body.toolApproval("c1", { lines: diff, added: 8, removed: 7 });
		tick();
		// the cut: the head window (id00–id04) and the tail window
		// (id09–id14) show, the middle (id05–id08) is cut behind the └
		const pre = writes.join("");
		expect(pre).toContain("ctrl+r to expand");
		expect(pre).toContain("id00");
		expect(pre).toContain("id14");
		expect(pre).not.toContain("id07");
		// THE TOGGLE: in place, no append, the cut note gone, the whole
		// diff there — the middle rows the cut hid
		expect(body.expandNext()).toEqual({ kind: "toggled" });
		writes.length = 0;
		tick();
		const frame = writes.join("");
		expect(frame).toContain("id07");
		// SUPERSESSION (TUI2-R1, the tool-cell suffix class): the expanded
		// block is no longer silent about the way back — the cut note is
		// still gone (nothing is cut), and the block's last row is the
		// collapse footer. "no ctrl+r at all" becomes "no ctrl+r CUT".
		expect(frame).not.toContain("ctrl+r to expand");
		expect(frame).toContain("└ ctrl+r collapses");
		// THE SECOND PRESS: the cut returns — the toggle flips both ways
		expect(body.expandNext()).toEqual({ kind: "toggled" });
		writes.length = 0;
		tick();
		expect(writes.join("")).toContain("ctrl+r");
	});

	it("W15: the expand key on a COMMITTED tool appends the expanded block — the /last shape, the N-turns-back header, the full input", () => {
		const { body, tick } = makeBody({ W: 60 });
		body.enter();
		body.userLine("turn one");
		body.toolStart("shell", "c1", { command: "make build" });
		body.toolRunning("c1");
		const big = Array.from({ length: 30 }, (_, i) => `row ${String(i).padStart(2, "0")} of a long build log`).join("\n");
		body.toolResult("c1", { content: big, isError: false });
		// the natural turn shape: the text releases the fold-hold (W14) —
		// the held tool commits at the next frame; its cut note (its last
		// rendered row at commit) carries the affordance → #collapsed.
		body.textAppend("first turn built.");
		tick();
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = (r as { lines: string[] }).lines;
		// the header: the /last idiom aimed at the chosen cell
		expect(lines[0]).toContain("expanded · shell make build · 0 turns back");
		// the /last shape: input and output sections with the FULL input
		expect(lines).toContain("--- shell input ---");
		expect(lines.some((l) => l.includes('"command": "make build"'))).toBe(true); // the full input, pretty-printed
		expect(lines).toContain("--- shell output ---");
		expect(lines[lines.length - 1]!.split("\n").at(-1)).toBe("row 29 of a long build log");
		// the cell is committed — the SAME key appends again (the single
		// collapsed entry cycles), it can never rewrite the committed rows
		const again = body.expandNext();
		expect(again.kind).toBe("appended");
	});

	it("W15: the expand pointer cycles the collapsed history newest-first; an empty body answers none", () => {
		const fresh = makeBody({ W: 60 });
		fresh.body.enter();
		expect(fresh.body.expandNext()).toEqual({ kind: "none" });
		// two committed cut shells — turn 1 and turn 2, each pushed past the cap
		const { body, tick } = makeBody({ W: 60 });
		body.enter();
		const turn = (t: string) => {
			body.userLine(t);
			body.toolStart("shell", `c${t}`, { command: `build ${t}` });
			body.toolRunning(`c${t}`);
			body.toolResult(`c${t}`, { content: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n"), isError: false });
			body.textAppend("built.");
			tick();
			body.raw(Array.from({ length: 30 }, (_, i) => `filler ${t} ${i}`));
			tick();
		};
		turn("one");
		turn("two");
		// the first press: the NEWEST collapsed cell (turn two — 0 turns back)
		const first = body.expandNext();
		expect(first.kind).toBe("appended");
		expect((first as { lines: string[] }).lines[0]).toContain("0 turns back");
		// the second press: the OLDER cell — turn one's tool, one user cell after it
		const second = body.expandNext();
		expect(second.kind).toBe("appended");
		expect((second as { lines: string[] }).lines[0]).toContain("1 turn back");
		// the third press: the cycle returns to the newest
		const third = body.expandNext();
		expect(third.kind).toBe("appended");
		expect((third as { lines: string[] }).lines[0]).toContain("0 turns back");
	});

	it("W13: the run of 5 read_file calls + text rolls up to ONE row — the claimed shape, the first-3 children, the overflow, and the expand", () => {
		// The natural turn shape [user, 5× read, text]: the text releases
		// the fold-hold, and at that frame the head's forward scan sees
		// all 5 members done → the ONE rollup row (the claimed shape).
		// The permission raws interleave (the streaming execution — the
		// loop's launch runs the calls concurrently with the model stream):
		// the run must SEE THROUGH them, never crossing a user/text cell.
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("w13");
		for (let i = 0; i < 5; i += 1) {
			body.toolStart("read_file", `r${i}`, { path: `${"abcde"[i]}.ts` });
			body.toolRunning(`r${i}`);
			if (i === 1 || i === 3) body.raw(["  approved"]);
			body.toolResult(`r${i}`, { content: "line one\nline two", isError: false });
		}
		body.textAppend("five files read.");
		tick();
		const frame = writes.join("");
		// the claimed shape, verbatim: the verbCol's 5-char pad reproduces
		// the "read  5 files" double space; the 5 members' 2-line results
		// → 10 lines; the elapsed rides the head's startedAt→doneAt.
		expect(frame).toContain("read  5 files (10 lines, 0.0s)");
		// the children: the first 3 basename targets joined; the overflow
		// row names the rest and carries the ctrl+r affordance (its
		// "└ … ctrl+r" joins the W15 expand history — the head's commit).
		expect(frame).toContain("a.ts · b.ts · c.ts");
		expect(frame).toContain("+2 more — ctrl+r expands");
		// the members are GONE — one   row, not five
		// R2: the settled tick is retired, so "exactly one row for the run"
		// is counted by the row's own verb column rather than by a mark that
		// no longer exists.
		expect(frame.match(/ {2}read {2}5 files/g) ?? []).toHaveLength(1);
		// the head joined the expand history: the expand shows the FULL
		// per-call children, one └ row each, never rewriting the rollup.
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = (r as { lines: string[] }).lines;
		expect(lines[0]).toContain("expanded · read 5 files · 0 turns back");
		for (const t of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
			expect(lines.some((l) => l.includes(t))).toBe(true);
		}
	});

	it("W14: the QUIET turn folds — thinking + 5 reads with no text become the ONE fold line at the boundary; the hold keeps them live before it; the mix terms pluralize", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("quiet turn");
		body.thinkingAppend("thinking quietly");
		for (let i = 0; i < 5; i += 1) {
			body.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
			body.toolRunning(`r${i}`);
			body.toolResult(`r${i}`, { content: "x", isError: false });
		}
		// the HOLD: done cells of an open text-less turn stay live — the
		// frame commits nothing of them (no fold line, no rollup)
		tick();
		expect(writes.join("")).not.toContain("\u2726");
		expect(writes.join("")).not.toContain("5 files");
		writes.length = 0; // drop the hold frame — only the fold frame below
		// the boundary: the terminal closes the turn — the fold line lands
		// at the FIRST held cell's commit (the thinking cell — endTurn
		// closes it), the members render [] after
		body.endTurn(19);
		tick();
		const frame = writes.join("");
		// the claimed shape: the thought-seconds, the reads term, the
		// no-edits term (the fold glyph is bold-wrapped, so the check
		// anchors on the contiguous term text)
		expect(frame).toContain("\u2726");
		expect(frame).toContain("thought 19s · 5 reads · no edits");
		// the members folded away — no individual read rows
		expect(frame.match(/✓/g) ?? []).toHaveLength(0);
		// the extension: the mixed counts — 1 edit + 1 shell pluralize
		// ("no reads · 1 edit · 1 shell", the others in first-call order)
		const mix = makeBody({ W: 80 });
		mix.body.enter();
		mix.body.userLine("mix");
		mix.body.toolStart("edit_file", "e1", { path: "x.ts" });
		mix.body.toolRunning("e1");
		mix.body.toolResult("e1", { content: "ok", isError: false });
		mix.body.toolStart("shell", "s1", { command: "echo hi" });
		mix.body.toolRunning("s1");
		mix.body.toolResult("s1", { content: "hi", isError: false });
		mix.body.endTurn(7);
		mix.tick();
		expect(mix.writes.join("")).toContain("thought 7s · no reads · 1 edit · 1 shell");
	});

	it("A9 (ruling R2, mock A): the user chip rides the fold — the words LEAD the one line in the SGR-7 bracket, the metadata survives; at a narrow width the words width-cut with the honest … while the metadata keeps every term; the ONE row never exceeds W (invariant ①)", () => {
		// the preview's mock-A frame at W=80: `✦ <chip> · thought 19s ·
		// 5 reads · no edits` — the chip the same SGR-7 bracket as the
		// live user row (#16f), the words taking the fold's width budget.
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("any idea what the flaky gate is?");
		for (let i = 0; i < 5; i += 1) {
			body.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
			body.toolRunning(`r${i}`);
			body.toolResult(`r${i}`, { content: "x", isError: false });
		}
		body.endTurn(19);
		tick();
		const frame = writes.join("");
		// the chip rides the fold — the ✦ gutter, then the SGR-7 bracket
		// with the human's words, then the join and the full metadata
		expect(frame).toContain("\u2726\x1b[0m \x1b[7m any idea what the flaky gate is? \x1b[27m · thought 19s · 5 reads · no edits");
		// the fold row fits W=80 whole (no cut at the wide width)
		expect(frame).not.toContain("flaky gate is? …");
		// the words take the width budget at W=40: the metadata keeps
		// EVERY term, the words cut with the "…" — and the row stays ≤ W
		// (the #checked invariant ① — a folded cut, never a crash)
		const narrow = makeBody({ W: 40 });
		narrow.body.enter();
		narrow.body.userLine("any idea what the flaky gate is? ".repeat(4).trim());
		for (let i = 0; i < 5; i += 1) {
			narrow.body.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
			narrow.body.toolRunning(`r${i}`);
			narrow.body.toolResult(`r${i}`, { content: "x", isError: false });
		}
		narrow.body.endTurn(19);
		narrow.tick();
		const nframe = narrow.writes.join("");
		expect(nframe).toContain("…"); // the honest cut mark rides the chip
		expect(nframe).toContain(" · thought 19s · 5 reads · no edits"); // the metadata survives whole
		expect(nframe).toMatch(/\x1b\[7m [^\x1b]*… \x1b\[27m/); // the … sits INSIDE the chip's bracket
		// the whole fold row (gutter + chip + metadata) is ≤ 40 cells —
		// every emitted line: invariant ①. The frame's rows are CUP-separated
		// (no LF), so the fold row is the segment that carries the metadata;
		// visibleWidth strips the CSI sequences itself.
		const foldLine = nframe.split(/\x1b\[[0-9;?]*[ABDGKJ]/).find((l) => l.includes("thought 19s"));
		expect(foldLine).toBeDefined();
		expect(visibleWidth(foldLine!)).toBeLessThanOrEqual(40);
	});

	it("A4+A5: the settled head row carries the TARGET and the VERDICT — `  edit  examples/foo.ts (… · approved by X)`; the denied call's pinned row names the decider; the human approval stays bare", () => {
		// A4: the settled-success row keeps toolTarget — the work order's
		// shape `  edit examples/foo.ts`, the target in the verb's summary
		// column (W3's 5-char pad: "edit  examples/foo.ts"). A5: the
		// verdict rides the head row — an extension's auto-approval appends
		// `· approved by <decidedBy>` (the "why wasn't I asked" answer),
		// its denial appends `· by <decidedBy>` on the W19 pinned row; the
		// human decision (no decidedBy) leaves both rows unchanged.
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("approve and edit");
		body.toolStart("edit_file", "c1", { path: "examples/foo.ts", search: "a", replace: "b" });
		body.toolApproval("c1", { lines: [], added: 1, removed: 1 });
		// the decision lands while the run streams (the panel closed): the
		// event precedes the execution, the record rides the settled row
		body.toolVerdict("c1", "approved", "dont-ask-again");
		body.toolRunning("c1");
		body.toolResult("c1", { content: "ok", isError: false });
		tick();
		let frame = writes.join("");
		// the W4 idiom: the timing closes the parens — the decider rides
		// the metadata group (the checkmark is bold — assert SGR-stripped)
		const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
		// MOVED (R1.5 slice ⑤, the approval-attribution class — DECLARED
		// THIS ROUND): the signal is inverted. A5 put the DECIDER on the row
		// to answer "why wasn't I asked"; the walkthrough found that answer
		// given nine times in a row as `approved by mode:default`, which is
		// the runtime's own backfill for "no policy expressed an opinion"
		// (run.ts stamps it) — the ambient default announced as a decision.
		// A verdict WITH decidedBy is a policy's, and policy is ambient:
		// silent. A verdict WITHOUT one is the human's, and that is the
		// fact worth the row: ` · approved` / ` · denied`.
		expect(plain).toContain("  edit  examples/foo.ts (+1 -1, 0.0s)");
		expect(plain).not.toContain("approved by");
		// the DENIED call: the W19 pinned row (the full name + target) with
		// the decider's tail — the aggregated head row, one line
		body.userLine("deny a call");
		body.toolStart("edit_file", "c2", { path: "bar.ts", search: "a", replace: "b" });
		body.toolVerdict("c2", "denied", "dont-ask-again", "no touch");
		body.toolResult("c2", { content: "[Permission denied] no touch", isError: true, reason: "no touch" });
		tick();
		frame = writes.join("");
		// MOVED (same class): a POLICY denial keeps only its reason — the
		// reason is why, and the decider was ambient.
		expect(frame.replace(/\x1b\[[0-9;]*m/g, "")).toContain("  edit_file bar.ts (no touch)");
		// the HUMAN approval (no decidedBy): the settled row unchanged —
		// no decider tail, the ⏸ → spinner →   sequence told the story
		body.userLine("human approval");
		body.toolStart("read_file", "c3", { path: "x.ts" });
		body.toolApproval("c3", null);
		body.toolVerdict("c3", "approved");
		body.toolRunning("c3");
		body.toolResult("c3", { content: "1 line", isError: false });
		tick();
		frame = writes.join("");
		const plain3 = frame.replace(/\x1b\[[0-9;]*m/g, "");
		// MOVED (same class): the HUMAN answer is now what the row records.
		// The old expectation ("the settled row unchanged") was the exact
		// inversion the walkthrough objected to — the ambient default got a
		// byline and the human's own answer got none.
		expect(plain3).toContain("  read  x.ts (approved, 0.0s)");
		expect(plain3).not.toContain("approved by");
	});

	it("A6 — a wide tool header cuts with the ellipsis — ONE row, never the fold-repeat", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("wide tool");
		body.toolStart("edit_file", "c1", { path: "a".repeat(200), search: "a", replace: "b" });
		body.toolResult("c1", { content: "ok", isError: false });
		tick();
		const frame = writes.join("");
		const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
		// ONE settled header row — the 200-col target cuts with the
		// ellipsis; the pre-A6 foldLine WRAPPED the header and repeated the
		// gutter (the wrapped rows carry no ellipsis — the regex matches
		// exactly the cut row). The invariant ① already enforced the
		// width cap — a violated cut row would have THROWN at tick().
		const rows = plain.match(/  edit  a{20,}…/g) ?? [];
		expect(rows.length).toBe(1);
	});
});

describe("W20 — the task checklist as STATE (the live block, the settle, the cap)", () => {
	// the fixture: 1 active + 7 pending + 2 done — the live capped form
	// is the active row, ≤2 pending, the overflow-pending fold, the done
	// collapse; the active item is LISTED THIRD (the live form promotes
	// it to the first row).
	const ITEMS = [
		{ text: "item 1", status: "done" as const },
		{ text: "item 2", status: "done" as const },
		{ text: "item 3", status: "active" as const },
		{ text: "item 4", status: "pending" as const },
		{ text: "item 5", status: "pending" as const },
		{ text: "item 6", status: "pending" as const },
		{ text: "item 7", status: "pending" as const },
		{ text: "item 8", status: "pending" as const },
		{ text: "item 9", status: "pending" as const },
		{ text: "item 10", status: "pending" as const },
	];
	const CTX: FrameCtx = { spinnerI: 0, now: 0, height: 24 };
	const liveCell = (expanded = false) =>
		cellComponent({
			kind: "checklist",
			header: "10 items — 7 pending, 1 active, 2 done",
			items: ITEMS,
			done: false,
			expanded,
			startedAt: 0,
			durationSeconds: 0,
			turn: 0,
		});

	it("the LIVE block: the fixed prefix + derived counts, the active item FIRST with ▸, ≤2 pending, the cut rows — the cap holds at every width", () => {
		for (const W of [60, 80, 120]) {
			const rows = liveCell().render(W, CTX);
			expect(rows.length).toBeLessThanOrEqual(CAP_TASK_LIVE);
			// every row is exactly one screen row (no wrap) — the
			// POST-FOLD cap equals the row count at every width
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(W);
		}
		// the shape at 80: the compositor-derived counts (never the
		// model's wording), the model tail AFTER the fixed prefix
		const rows = liveCell().render(80, CTX);
		expect(rows[0]).toContain("task · 10 items · 1 active · 2 done");
		expect(rows[0]).toContain("10 items — 7 pending, 1 active, 2 done");
		expect(rows[1]).toContain("item 3"); // the active item promoted
		expect(rows[1]).toContain("\x1b[1m▸\x1b[0m"); // the W20 glyph, bold (the menu vocabulary)
		expect(rows[2]).toContain("□ item 4");
		expect(rows[3]).toContain("□ item 5");
		expect(rows[4]).toContain("└ +5 more · ctrl+r"); // 7 pending, 2 shown
		expect(rows[5]).toContain("└ +2 done · ctrl+r"); // the done collapse
	});

	it("the cap holds when a long item text would wrap — the row CUTS, never folds", () => {
		const long = [{ text: "a very long item text ".repeat(6) + "tail", status: "active" as const }];
		for (const W of [60, 80]) {
			const rows = cellComponent({ kind: "checklist", header: "h", items: long, done: false, expanded: false, startedAt: 0, durationSeconds: 0, turn: 0 }).render(W, CTX);
			expect(rows.length).toBeLessThanOrEqual(CAP_TASK_LIVE);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(W);
		}
	});

	it("the LIVE ctrl+r toggle: the capped form flips to the FULL list in place — the ▣ the collapse hid", () => {
		const rows = liveCell(true).render(80, CTX);
		expect(rows).toHaveLength(11); // header + all 10 items, no collapse rows
		// the full table in MODEL order (the promotion is the capped
		// view's device — the full form shows the list as it is)
		expect(rows[1]).toContain("▣ item 1"); // the done items the collapse hid
		expect(rows[3]).toContain("item 3");
		expect(rows[3]).toContain("\x1b[1m▸\x1b[0m"); // the live active glyph at its own row
		expect(rows[10]).toContain("□ item 10");
		expect(rows.join("")).not.toContain("ctrl+r");
	});

	it("the SETTLED block: the recap idiom + the model tail + the FULL final list in the existing checklist shape", () => {
		const rows = cellComponent({ kind: "checklist", header: "the plan", items: ITEMS, done: true, expanded: false, startedAt: 0, durationSeconds: 8040, turn: 0 }).render(80, CTX);
		expect(rows).toHaveLength(11);
		expect(rows[0]).toContain("task done · 10 items · 2h 14m");
		expect(rows[0]).toContain("the plan"); // the model tail rides after
		// the durable glyphs — the checklist's existing shape (▖ for the
		// active — the settled record, not the live marker)
		expect(rows[1]).toContain("▣ item 1");
		expect(rows[3]).toContain("▖ item 3");
		expect(rows[4]).toContain("□ item 4");
		expect(rows.join("")).not.toContain("ctrl+r");
	});

	it("formatDuration — the `2h 14m` form: seconds under a minute, m s under an hour, h m past it", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(32)).toBe("32s");
		expect(formatDuration(90)).toBe("1m 30s");
		expect(formatDuration(8040)).toBe("2h 14m");
		expect(formatDuration(3600)).toBe("1h 0m");
	});

	it("the compositor: same-turn updates MUTATE the one live block — the settle commits exactly ONCE, the next turn starts a fresh block", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("t1");
		body.checklist("first", [{ text: "a", status: "active" }]);
		body.checklist("second", [
			{ text: "a", status: "done" },
			{ text: "b", status: "active" },
		]);
		body.endTurn(1);
		tick();
		const turn1 = writes.join("");
		// exactly ONE settled block for the turn — never one per update
		expect(turn1.match(/task done · 2 items/g) ?? []).toHaveLength(1);
		expect(turn1.match(/task done/g) ?? []).toHaveLength(1);
		// the next turn starts a FRESH live block (the settled one is done)
		body.userLine("t2");
		body.checklist("third", [{ text: "c", status: "active" }]);
		body.endTurn(2);
		tick();
		const turn2 = writes.join("");
		expect(turn2.match(/task done · 1 item/g) ?? []).toHaveLength(1);
		expect(turn2.match(/task done/g) ?? []).toHaveLength(2); // both turns' settles
	});
});
