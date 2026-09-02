/**
 * DC-38 — a panel's key hint belongs on ONE row of the screen.
 *
 * `panelAffordance` feeds two consumers written rounds apart, and
 * neither knows about the other: `panelBlockRows` pushes it as the
 * block's last row (TUI2-R1.5, "the affordance — the phase's key hint,
 * ONE row"), and the compositor's `#statusSource` returns it as the
 * status row's right-aligned hint (W21). On an approval at W=100 both
 * land and the same 48-cell sentence is printed twice, six rows apart.
 *
 * It is width-dependent, which is what makes it worse than a plain
 * duplicate: the status row drops its hint when the left text plus the
 * hint will not fit, so the ask panel (long left text) shows one copy
 * and an approval (`❯ run paused`, twelve cells) shows two. The build
 * that duplicates and the build that does not are the same build.
 *
 * Found by the UI-1 walkthrough item 4 against the installed 0.20.3.
 *
 * The claim under test is about the SCREEN, not the byte stream: every
 * frame repaints every row, so counting occurrences in the writes
 * counts frames. What a reader sees is rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";
import type { PanelView } from "../src/approval-panel.js";

const AFFORDANCE = "↑↓ move · ⏎ or click confirms · 1-4 instant · esc";

function makeBody(W: number, H: number) {
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

function rowsOf(writes: readonly string[], W: number, H: number): string[] {
	const screen = new Screen(W, H);
	screen.feed(writes.join(""));
	return screen.rows.map((r) => r.join("").replace(/\s+$/, ""));
}

const approval: PanelView = {
	flavor: "approval",
	name: "edit_file",
	title: "edit examples/foo.ts",
	speaker: "mode:default",
	hint: "/mode accept-edits auto-approves edits",
	statusText: "❯ run paused",
	args: { kind: "text", lines: ["old", "new"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

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

describe("DC-38 — the panel key hint is printed once", () => {
	// The width matters and is the point: 100 is where the status row has
	// room for the hint beside "❯ run paused" and so prints the second
	// copy. At 80 it does not fit and the bug is invisible — which is why
	// the fixed-width gates never saw it.
	for (const W of [100, 120, 160]) {
		it(`W=${W}: the affordance is on exactly one row`, () => {
			const { body, writes, tick } = makeBody(W, 24);
			body.enter();
			body.bindApproval(() => ({ view: approval, phase: "options", cursor: 0 }));
			body.raw(["x"]);
			tick();
			const rows = rowsOf(writes, W, 24);
			const carrying = rows.filter((r) => r.includes(AFFORDANCE));
			expect(carrying.length).toBe(1);
		});
	}

	it("the row that keeps it is the PANEL's, not the status row's", () => {
		const W = 100;
		const { body, writes, tick } = makeBody(W, 24);
		body.enter();
		body.bindApproval(() => ({ view: approval, phase: "options", cursor: 0 }));
		body.raw(["x"]);
		tick();
		const rows = rowsOf(writes, W, 24);
		const at = rows.findIndex((r) => r.includes(AFFORDANCE));
		const status = rows.findIndex((r) => r.includes("❯ run paused"));
		expect(at).toBeGreaterThanOrEqual(0);
		expect(status).toBeGreaterThanOrEqual(0);
		// the panel's block sits ABOVE the status row; keeping the hint
		// there puts it next to the options it names, and out of the row
		// that drops it for width
		expect(at).toBeLessThan(status);
	});

	it("the status row still carries the phase status", () => {
		const W = 100;
		const { body, writes, tick } = makeBody(W, 24);
		body.enter();
		body.bindApproval(() => ({ view: approval, phase: "options", cursor: 0 }));
		body.raw(["x"]);
		tick();
		// W21's other half is untouched: the panel's status REPLACES the
		// CLI's painting status. Only the hint moves out.
		expect(rowsOf(writes, W, 24).some((r) => r.includes("❯ run paused"))).toBe(true);
	});
});
