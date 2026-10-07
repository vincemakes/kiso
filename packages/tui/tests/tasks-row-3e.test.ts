/**
 * ADR-0058 (3e, Amendment 8) — the status rows count the tasks kiso
 * manages: `● N tasks running`, nothing else. A task kiso lost track of is
 * an event said once in the transcript, never a second count beside the
 * first. The running row teaches ctrl+b exactly while a command can be
 * moved to the background.
 */
import { describe, expect, it } from "vitest";
import { idleStatus, runningStatus, tasksSegment } from "../src/status.js";

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

	it("the idle row carries them; without tasks it is today's row byte for byte", () => {
		expect(idleStatus("default", "m", 0.1, undefined, 120, false, { running: 1 })).toContain("▸ default · ● 1 task running · /mode to switch");
		expect(idleStatus("default", "m", 0.1, undefined, 120, false, { running: 0 })).toBe(idleStatus("default", "m", 0.1, undefined, 120, false));
	});

	it("the running row: the count, and ctrl+b only while a command can be moved", () => {
		const row = runningStatus("✳", Date.now(), null, 0.1, null, 120, null, { running: 1 }, true);
		expect(row).toMatch(/● 1 task running · esc stop · ctrl\+b background · alt\+⏎ redirect/);
		expect(runningStatus("✳", Date.now(), null, 0.1, null, 120, null)).not.toContain("ctrl+b");
		expect(runningStatus("✳", Date.now(), null, 0.1, null, 120, null, undefined, false)).toBe(runningStatus("✳", Date.now(), null, 0.1, null, 120, null));
	});

	it("at a narrow width the hint goes before any fact does", () => {
		const row = runningStatus("✳", Date.now(), null, 0.1, null, 60, null, { running: 2 }, true);
		expect(row).toContain("● 2 tasks running");
		expect(row).not.toContain("◌");
		expect(row).not.toContain("ctrl+b background");
	});
});
