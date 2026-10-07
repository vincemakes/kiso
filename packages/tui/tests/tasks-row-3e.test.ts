/**
 * ADR-0058 (3e, Amendment 8) — the status rows count the tasks kiso
 * manages: `● N tasks running`, nothing else. A task kiso lost track of is
 * an event said once in the transcript, never a second count beside the
 * first. The running row teaches ctrl+b exactly while a command can be
 * moved to the background.
 */
import { describe, expect, it } from "vitest";
import { statusBar, tasksSegment, workingRow, type BarInput } from "../src/status.js";

// RE-DERIVED (the legacy rows retired, owner 2026-10-06): the idle row is
// the bar (§8.9) and the running row the live row (§8.7); the count rides
// the bar on both, and the live row teaches ctrl+b
const BAR: BarInput = { mode: "default", floorOff: false, model: "m", ctx: { used: 0.1, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: null, folder: null };

describe("3e — the task counts on the status rows", () => {
	it("the running count only — a lost task is never a second count on the row", () => {
		expect(tasksSegment({ running: 2 })).toBe("● 2 tasks running");
		expect(tasksSegment({ running: 1 })).toBe("● 1 task running");
		expect(tasksSegment({ running: 0 })).toBe("");
		expect(tasksSegment(undefined)).toBe("");
		// a caller still passing the old field is ignored, never drawn
		expect(tasksSegment({ running: 2, unknown: 1 } as never)).toBe("● 2 tasks running");
		expect(tasksSegment({ running: 0, unknown: 1 } as never)).toBe("");
	});

	it("the bar carries them; without tasks it is the bar it was, byte for byte", () => {
		expect(statusBar({ ...BAR, tasks: { running: 1 } }, 120, null)).toContain("▸ default · ● 1 task running · /mode to switch");
		expect(statusBar({ ...BAR, tasks: { running: 0 } }, 120, null)).toBe(statusBar(BAR, 120, null));
	});

	it("the live row teaches ctrl+b only while a command can be moved", () => {
		expect(workingRow("✳", Date.now(), null, null, 120, null, true)).toMatch(/esc stop · ctrl\+b background · ⏎ steer · alt\+⏎ redirect$/);
		expect(workingRow("✳", Date.now(), null, null, 120, null, false)).not.toContain("ctrl+b");
	});

	it("at a narrow width the hint goes before any fact does", () => {
		const row = statusBar({ ...BAR, tasks: { running: 2 } }, 40, null);
		expect(row).toContain("● 2 tasks running");
		expect(row).not.toContain("◌");
		expect(row).not.toContain("/mode to switch");
	});
});
