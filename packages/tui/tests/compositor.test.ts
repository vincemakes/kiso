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
				/^\x1b\[2B\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)\x1b\[1A\x1b\[1G\x1b\[0K([\s\S]*?)(?=\x1b\[1A|\x1b\[\?2026l)/,
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
		expect(writes.join("")).toContain("→ read_file");
		expect(writes.join("")).toContain("▖"); // the spinner glyph rides the running line
		body.toolResult("c1", { content: "ok", isError: false });
		vi.advanceTimersByTime(16); // the toolResult's coalesced frame lands
		expect(writes.join("")).toContain("✓ read_file");
		writes.length = 0;
		vi.advanceTimersByTime(2_000);
		// the tool ended — no timer re-arms — the idle emits nothing
		expect(writes.join("")).toBe("");
	});
});
