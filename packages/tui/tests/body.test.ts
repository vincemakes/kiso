/**
 * v2d — the body renderer, unit-tested through its byte output: the
 * cell→line forms, the freeze semantics (a completed cell prints ONCE and
 * is never touched again), and the in-place tail redraw (the same tool
 * line running→done at the SAME row). The writer is injected, so every
 * assertion is on the exact bytes the terminal receives.
 */

import { describe, expect, it } from "vitest";
import { Body } from "../src/body.js";

interface Captured {
	body: Body;
	out: string;
}

function make(opts: { height?: number; width?: number } = {}): Captured {
	let out = "";
	const body = new Body({
		active: () => true,
		height: () => opts.height ?? 24,
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
	it("the UserCell freezes as one blue line at its region row", () => {
		const c = make();
		c.body.userLine("hello");
		flush(c);
		// The frozen print positions the row, clears, writes the rail line.
		expect(c.out).toContain("\x1b[1;1H\x1b[0K▍ hello"); // TUI v5 #16f: the ▍ rail (plain here — no TTY in the test)
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

	it("the ThinkingCell carries the live char count once over 100 chars", () => {
		const c = make();
		c.body.thinkingAppend("A".repeat(110));
		flush(c);
		expect(c.out).toContain(`…${"A".repeat(100)} (110 chars · /think)`);
	});

	it("the terminal cell freezes as label + status + the rhythm gap blank", () => {
		const c = make();
		c.body.terminal("\ndone\n", "[turn 2 · faux]");
		flush(c);
		expect(c.out).toContain("\x1b[1;1H\x1b[0Kdone");
		expect(c.out).toContain("\x1b[2;1H\x1b[0K[turn 2 · faux]");
		expect(c.out).toContain("\x1b[3;1H\x1b[0K");
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
		// The live (running) form sits at the region bottom (row 21 = H-3).
		expect(c.out).toContain("\x1b[20;1H\x1b[0K\x1b[20;1H→ list_dir {\"path\":\"/\"} "); // v3 §03: 4 dock rows — the tail sits at H-4=20
		c.body.toolResult("c1", { content: "ok", isError: false });
		flush(c);
		// The completed form FREEZES into the region at the frozen area's
		// next row (row 2 — after the user cell) and is never touched again.
		expect(c.out).toContain("\x1b[2;1H\x1b[0K✓ list_dir ({\"path\":\"/\"}, ");
		// The user cell (frozen at row 1) was never reprinted.
		expect((c.out.match(/go/g) ?? []).length).toBe(1);
	});
});
