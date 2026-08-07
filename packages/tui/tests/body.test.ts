/**
 * v2d — the body renderer, unit-tested through its byte output: the
 * cell→line forms, the freeze semantics (a completed cell prints ONCE and
 * is never touched again), and the in-place tail redraw (the same tool
 * line running→done at the SAME row). The writer is injected, so every
 * assertion is on the exact bytes the terminal receives.
 *
 * #17 (P1): every frozen line commits via the REAL-LF scroll path
 * (\x1b[24;1H\n + write at the body's bottom row) — short sessions too;
 * the resize handler clears the old tail+dock area (ED, zero LF) and
 * redraws at the new geometry; the thinking fold fits its row.
 */

import { describe, expect, it } from "vitest";
import { Body } from "../src/body.js";

interface Captured {
	body: Body;
	out: string;
}

function make(opts: { height?: number; heightFn?: () => number; width?: number } = {}): Captured {
	let out = "";
	const height = opts.heightFn ?? (() => opts.height ?? 24);
	const body = new Body({
		active: () => true,
		height,
		width: () => opts.width ?? 80,
		editCol: () => 7,
		write: (s) => {
			out += s;
		},
	});
	const captured = { body, get out(): string { return out; } };
	return captured as unknown as Captured;
}

/** Render synchronously (close flushes a pending frame). */
const flush = (c: Captured): void => c.body.close();

describe("v2d: cell → line forms", () => {
	it("the UserCell freezes as one rail line via the REAL-LF scroll path (#17: no CUP pre-fill)", () => {
		const c = make();
		c.body.userLine("hello");
		flush(c);
		// #17: EVERY frozen line scrolls the whole screen with a real LF at
		// the last row, then lands at the body's bottom row (H-4 = 20 with
		// an empty tail) — never at a pre-fill CUP row (the reflow defect).
		expect(c.out).toContain("\x1b[24;1H\n\x1b[20;1H\x1b[0K▍ hello"); // TUI v5 #16f: the ▍ rail (plain here — no TTY in the test)
	});

	it("the ToolCell runs the lifecycle: pending → running (spinner + elapsed) → done ✓ (summary, Ns)", () => {
		const c = make();
		c.body.toolStart("list_dir", "c1", { path: "/" });
		flush(c);
		expect(c.out).toContain("→ list_dir {\"path\":\"/\"}");
		c.body.toolRunning("c1");
		flush(c);
		// The running line carries a spinner glyph and the elapsed seconds.
		expect(c.out).toMatch(/→ list_dir \{"path":"\/"\} [▖▘▝▗] \d+s/);
		c.body.toolResult("c1", { content: "ok", isError: false });
		flush(c);
		expect(c.out).toMatch(/✓ list_dir \(\{"path":"\/"\}, \d+\.\ds\)/);
	});

	it("a FAILED tool freezes as ✗ name (error first line, Ns)", () => {
		const c = make();
		c.body.toolStart("shell", "c1", { command: "npm test" });
		c.body.toolRunning("c1");
		c.body.toolResult("c1", { content: "boom\nline2", isError: true });
		flush(c);
		expect(c.out).toMatch(/✗ shell \(boom, \d+\.\ds\)/);
	});

	it("the approval state shows the inline ⏸ badge", () => {
		const c = make();
		c.body.toolStart("asky_read", "c1", {});
		c.body.toolApproval("c1", null);
		flush(c);
		expect(c.out).toContain("→ asky_read {} ⏸");
	});

	it("the ThinkingCell carries the live char count once over 100 chars — and FITS its row (#17)", () => {
		const c = make();
		c.body.thinkingAppend("A".repeat(110));
		flush(c);
		// #17: the fold is width-capped (W - 1 - suffix) so its whole line
		// fits ONE row — a soft-wrapped fold's continuation would be
		// clobbered by the next frozen line's commit at the same write row
		// (the /think suffix lost — the recorded symptom).
		const suffix = " (110 chars · /think)";
		expect(c.out).toContain(`…${"A".repeat(80 - 1 - suffix.length)}${suffix}`);
	});

	it("the terminal cell freezes as label + status + the rhythm gap blank (each via the real-LF path)", () => {
		const c = make();
		c.body.terminal("\ndone\n", "[turn 2 · faux]");
		flush(c);
		// Each of the three lines commits at the same write row — the
		// scroll shifts the previous one up.
		expect(c.out).toContain("\x1b[24;1H\n\x1b[20;1H\x1b[0Kdone");
		expect(c.out).toContain("\x1b[20;1H\x1b[0K[turn 2 · faux]");
		expect(c.out).toContain("\x1b[20;1H\x1b[0K\x1b[?2026h\x1b[24;7H"); // the gap blank + the cursor home
	});
});

describe("v2d: freeze semantics — printed once, never touched again", () => {
	it("a completed cell's bytes appear EXACTLY once across two renders (the heartbeat must not reprint it)", () => {
		const c = make();
		c.body.userLine("hello");
		c.body.userLine("world");
		flush(c);
		const once = c.out;
		c.body.toolStart("x", "c1", {});
		flush(c); // a later render must NOT reprint the frozen user cells
		expect((c.out.match(/hello/g) ?? []).length).toBe(1);
		expect((c.out.match(/world/g) ?? []).length).toBe(1);
		expect(c.out.length).toBeGreaterThan(once.length); // the tail redrew
	});

	it("the in-place update evidence — the SAME tool cell's running→done sequence: the live form at the tail, the ✓ frozen into the region", () => {
		const c = make();
		c.body.userLine("go");
		c.body.toolStart("list_dir", "c1", { path: "/" });
		c.body.toolRunning("c1");
		flush(c);
		// The live (running) form sits at the region bottom (row 20 = H-4).
		expect(c.out).toContain("\x1b[20;1H\x1b[0K\x1b[20;1H→ list_dir {\"path\":\"/\"} "); // v3 §03: 4 dock rows — the tail sits at H-4=20
		c.body.toolResult("c1", { content: "ok", isError: false });
		flush(c);
		// The completed form FREEZES via the real-LF scroll commit at the
		// body's bottom row (the tail is empty now — writeRow = 20) and is
		// never touched again.
		expect(c.out).toContain("\x1b[24;1H\n\x1b[20;1H\x1b[0K✓ list_dir ({\"path\":\"/\"}, ");
		// The user cell was never reprinted.
		expect((c.out.match(/go/g) ?? []).length).toBe(1);
	});
});

describe("#17: the resize handler — clear the old tail+dock area, redraw at the new geometry", () => {
	it("onResize emits ONE ED from the last-drawn tail top, ZERO real LF, and re-draws the LIVE tail at the new rows", () => {
		let h = 24;
		const c = make({ heightFn: () => h });
		c.body.userLine("go");
		c.body.toolStart("list_dir", "c1", { path: "/" });
		c.body.toolRunning("c1");
		flush(c);
		// The live tail sat at row 20 (H-4, tailHeight 1) — the last-drawn
		// tail top is cached.
		expect(c.out).toContain("\x1b[20;1H→ list_dir");
		const before = c.out.length;
		// A resize to 20 tall: the handler clears the old tail area with
		// the OLD geometry (one ED from row 20 — EL/ED only, no LF), then
		// the tail redraws at the NEW geometry (tailTop = 20-3-1 = 16).
		h = 20;
		c.body.onResize();
		const delta = c.out.slice(before);
		expect(delta).toContain("\x1b[20;1H\x1b[0J"); // the old tail top — one ED
		expect(delta).not.toContain("\n"); // zero real LF — the storm gate's invariant
		expect(delta).toContain("\x1b[16;1H→ list_dir"); // the tail redrawn at the new rows
	});

	it("consecutive resizes are idempotent — the second clear covers the already-drawn area (still no LF)", () => {
		let h = 24;
		const c = make({ heightFn: () => h });
		c.body.toolStart("shell", "c1", { command: "npm test" });
		c.body.toolRunning("c1");
		flush(c);
		const before = c.out.length;
		h = 20;
		c.body.onResize();
		h = 18;
		c.body.onResize();
		const delta = c.out.slice(before);
		expect(delta).not.toContain("\n");
		// the second resize cleared from the NEW tail top (16) — the tail
		// redrew at 18-3-1 = 14.
		expect(delta).toContain("\x1b[16;1H\x1b[0J");
		expect(delta).toContain("\x1b[14;1H→ shell");
	});
});
