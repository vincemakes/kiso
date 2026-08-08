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

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
	});
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
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
		expect(bytes).toContain("╌");
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

	it("invariant ②: the steady-state frames CUP ONLY in the frozen area — the LIVE region (rows 22..24 + the live content) is relative + CHA only", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0; // drop the first frame (the full-redraw path — CUP allowed there)
		body.raw(["line one"]);
		tick();
		const bytes = writes.join("");
		// the frame's CUPs land exclusively in the FROZEN area (the
		// committed section + the gap/stale ELs — the freeze path); the
		// live region (the chrome rows) is drawn with relative moves only
		const cups = [...bytes.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
		expect(cups.length).toBeGreaterThan(0);
		expect(cups.every((r) => r <= 21)).toBe(true);
		expect(bytes).toContain("line one");
	});

	it("the idle no-commit steady frame jumps 2B from the anchor — the chrome stays on H/H−1/H−2/H−3 (the input-shift regression)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "\u4f60", cursor: 1 }), "\x1b[1m▌ \x1b[0m");
		writes.length = 0; // the first frame is the full-redraw (CUP allowed there)
		body.textAppend("live"); // an OPEN cell — the steady NO-COMMIT path
		tick();
		const frame = writes.join("");
		// the buggy frame jumped 1B from the anchor (H−2) and repainted the
		// chrome one row up — the status landed at H−1, the input at H−3
		// (the real-machine report: the input box shifted). The fix jumps
		// 2B straight to the bottom row H.
		expect(frame.startsWith("\x1b[?2026h\x1b[2B")).toBe(true);
		// the bottom-up repaint right after the jump — four relative rows:
		// status (H), lower ╌ (H−1), input (H−2), upper ╌ (H−3)
		const m = frame
			.slice("\x1b[?2026h".length)
			.match(
				/^\x1b\[2B\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)(?=\x1b\[1A|\x1b\[\d+;\d+H|\x1b\[\?2026l)/,
			);
		expect(m).not.toBeNull();
		expect(m![2]).toContain("╌"); // H−1 — the lower ╌
		expect(m![3]).toContain("▌"); // H−2 — the input row
		expect(m![4]).toContain("╌"); // H−3 — the upper ╌
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

	it("the commit frame scrolls from the anchor: 2B then exactly N real LFs — the scroll count matches the committed lines (the stale H−1 anchor)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0;
		body.raw(["a", "b"]); // N = 2 committed lines
		tick();
		const frame = writes.join("");
		// the 1B + N LFs = N−1 scrolls (one short of the bookkeeping N);
		// the 2B + N LFs scroll exactly N rows — one per committed line
		expect(frame.startsWith("\x1b[?2026h\x1b[2B")).toBe(true);
		const lfs = frame.match(/^\x1b\[\?2026h\x1b\[2B(\n+)/);
		expect(lfs).not.toBeNull();
		expect(lfs![1]!.length).toBe(2);
	});

	it("the steady frame draws the LIVE lines at their MODEL rows — CUP, never the relative march (the unclamped geometry: liveTop=1)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		writes.length = 0;
		body.textAppend("streaming line");
		tick();
		const frame = writes.join("");
		// the model row is 1 (liveTop=1); the march drew it at row 20 and
		// the gap ELs erased it — the streamed text was INVISIBLE on screen
		expect(frame).toContain("\x1b[1;1H\x1b[0Kstreaming line");
		// the gap ELs start BELOW the live bottom — never over it
		expect(frame).toContain("\x1b[2;1H\x1b[0K");
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
		const frame = writes.join("");
		// the menu sits at H−3−menu = 20 (1-based) with one item; the gap
		// range must end at H−4−menu = 19 — an EL at 20 erases the menu
		expect(frame).toContain("▸ /mode");
		expect(frame).not.toMatch(/\x1b\[20;1H\x1b\[0K/);
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

	it("the cursor derives from the frame: the marker positions the relative move; the marker never reaches the stream", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "abc", cursor: 1 }), "\x1b[1m▌ \x1b[0m");
		body.raw(["x"]);
		tick();
		const bytes = writes.join("");
		expect(bytes).not.toContain("kiso-cur"); // the APC marker is stripped
		expect(bytes).toContain("\x1b[1m▌ \x1b[0mabc"); // the prompt + the line, marker stripped
		// the cursor rests after the prompt + one char ("▌ a|bc") — the
		// LEFT move equals the trailing width (2)
		expect(bytes).toContain("\x1b[2D");
	});

	it("the ApprovalPrompt slot: the question takes the input row (the brick out); the brick returns when it clears", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.bindInput(() => ({ line: "", cursor: 0 }), "\x1b[1m▌ \x1b[0m");
		body.showQuestion("approve read_file? (y/n) ");
		body.raw(["x"]);
		tick();
		const bytes = writes.join("");
		expect(bytes).toContain("approve read_file? (y/n)");
		expect(bytes).not.toContain("\x1b[1m▌ \x1b[0m"); // the slot swap — no overlay
		body.clearQuestion();
		body.raw(["y"]);
		tick();
		expect(writes.join("")).toContain("\x1b[1m▌ \x1b[0m");
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
		expect(bytes).toContain("▸ /mode\x1b[0m switch the approval tier");
		expect(bytes).toContain("  /model list model profiles");
		// the bottom-up march: the status, then the menu rows (the LAST
		// menu row first), then the content — the menu never overlays the
		// editor row (the brick row renders after the content)
		const hintAt = bytes.indexOf("/ commands · ↑ history");
		const modelAt = bytes.indexOf("list model profiles");
		const modeAt = bytes.indexOf("switch the approval tier");
		const contentAt = bytes.indexOf("\x1b[1;1H\x1b[0Kx"); // the committed write — the CUP freeze path
		expect(hintAt).toBeGreaterThan(0);
		expect(modelAt).toBeGreaterThan(hintAt);
		expect(modeAt).toBeGreaterThan(modelAt);
		expect(contentAt).toBeGreaterThan(modeAt);
	});

	it("the resize: ED0 from the recorded live top + the full CUP redraw — zero LF, zero 3J, idempotent", () => {
		const { body, writes } = makeBody();
		body.enter();
		body.raw(["frozen"]);
		writes.length = 0;
		body.onResize();
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
		expect(writes.join("")).toContain("\x1b[0J");
		expect(writes.join("")).toContain("frozen");
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
		expect(writes.join("").replace(/\x1b\[[0-9;]*m/g, "")).toContain("✓ read");
		writes.length = 0;
		vi.advanceTimersByTime(2_000);
		// the tool ended — no timer re-arms — the idle emits nothing
		expect(writes.join("")).toBe("");
	});

	// ---- TUI v7 — the flow contract (W7, W8, W10; the work order §4) ----

	it("W7: the settled shell tail caps at 5 screen rows POST-FOLD — the renderer cut inside the cap, counted in FOLDED rows (60 vs 120)", () => {
		// 30 lines of 66 chars: at W=120 each line folds to 1 row (30 rows →
		// the cut "+26"); at W=60 each folds to 2 (60 rows → the cut "+56") —
		// the cap counts SCREEN rows, never source entries. The RED state was
		// the measured bug: the 60-entry diff folded to 73 rows at W≤80.
		const output = Array.from({ length: 30 }, (_, i) => `shell line ${String(i).padStart(2, "0")} ` + "x".repeat(52)).join("\n");
		for (const W of [120, 60]) {
			const { body, writes, tick } = makeBody({ W });
			body.enter();
			body.toolStart("shell", "c1", { command: "run" });
			body.toolRunning("c1");
			body.toolResult("c1", { content: output, isError: false });
			tick();
			const frame = writes.join("");
			// the tail + the cut row inside the cap (the cut row counts)
			const cut = frame.match(/└ \+(\d+) earlier rows · ctrl\+r/);
			expect(cut).not.toBeNull();
			expect(Number(cut![1]!)).toBe(W === 120 ? 26 : 56);
			expect((frame.match(/│ /g) ?? []).length + 1).toBeLessThanOrEqual(5);
			// the tail survives: the LAST output line is on screen
			expect(frame).toContain("shell line 29");
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
		for (const W of [120, 60]) {
			const { body, writes, tick } = makeBody({ W });
			body.enter();
			body.toolStart("edit_file", "c1", { path: "x" });
			body.toolApproval("c1", { lines: diff, added: 30, removed: 30 });
			tick();
			const frame = writes.join("");
			const cut = frame.match(/└ \+(\d+) rows · ctrl\+r to expand/);
			expect(cut).not.toBeNull();
			// the head + the named middle + the tail = 12 rows total
			expect((frame.match(/│ /g) ?? []).length + 1).toBeLessThanOrEqual(12);
			// the head AND the tail survive (the truncated middle is named)
			expect(frame).toContain("Identifier0");
			expect(frame).toContain("Identifier59");
		}
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
		expect((frame.match(/│ /g) ?? []).length).toBeLessThanOrEqual(3);
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
		expect(writes.join("")).toContain("└ capped by read_file · offset=201 for the rest");
	});

	it("W8: the running tool's window is a FIXED 3 rows from the first frame — the height never changes while running", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("shell", "c1", { command: "sleep" });
		body.toolRunning("c1");
		tick();
		// the window: 2 blank-padded rows + the waiting row — 3 total
		expect(writes.join("")).toContain("└ waiting for output");
		expect((writes.join("").match(/│ /g) ?? []).length).toBe(2);
		// a SECOND frame (the spinner tick): the window rows byte-identical
		writes.length = 0;
		vi.advanceTimersByTime(200);
		expect(writes.join("")).toContain("└ waiting for output");
		expect((writes.join("").match(/│ /g) ?? []).length).toBe(2);
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
		expect((writes.join("").match(/│ /g) ?? []).length).toBe(0); // no live window, no fold
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
		expect((settled.match(/│ /g) ?? []).length).toBe(0);
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
		body.banner("0.1.37", "");
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
		const userAt = rows.findIndex((l) => l.includes("▍"));
		expect(rows[userAt - 1]).toBe(""); // the banner (multi-row) breathes below
		const readAt = rows.findIndex((l) => l.includes("✓ read"));
		const listAt = rows.findIndex((l) => l.includes("✓ list_dir"));
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
		// the banner cell: 6 art + blank + version + blank + "  ▞ resume" +
		// 1 session row = 11 rows; the W11 blank + the user line follow
		expect(screen.get(10)).toBe("  ▞ resume");
		// metaW = 18 (the single meta); titleW = 80 - 13 - 18 = 49; pad 21
		expect(screen.get(11)).toBe(
			"    now     fix the resize repaint storm" + " ".repeat(21) + " " + "41 events · 3 runs",
		);
		// the done-when: the row is exactly W wide, the meta at its column
		expect(screen.get(11)!.length).toBe(80);
		expect(screen.get(11)!.indexOf("41 events")).toBe(62);
		// the tier gate is per frame — a COMPACT screen drops the list entirely
		const compact = makeBody({ H: 15 });
		compact.body.enter();
		compact.body.banner("0.1.37", "", [
			{ title: "fix the resize repaint storm", events: 41, runs: 3, updatedAt: Date.now() },
		]);
		compact.tick();
		expect(compact.writes.join("")).not.toContain("▞ resume");
	});
});
