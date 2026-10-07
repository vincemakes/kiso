/**
 * The second main-sync round (ADR-0058 3e on Graphite) — the session's tasks
 * are counted on the bar (§8.9), right after the mode, where 0.46.0's status
 * row has them (owner, 2026-10-06): `● N tasks running` with the mark in the
 * machine's blue, the words quiet. A fact: it never gives way.
 *
 * RE-DERIVED (the main sync, 0.46.2, Amendment 8): the gold `◌ N unknown`
 * beside it retired — a task kiso lost track of is said once in the
 * transcript (a TASK row), not counted here; `TaskCountsOnRow` is
 * `{ running }`. And the live row teaches ctrl+b exactly while a running
 * command can be moved to the background.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { statusBar, workingRow, type BarInput } from "../src/status.js";
import { palette, setGround } from "../src/lines.js";
import { visibleWidth } from "../src/components.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const BAR: BarInput = { mode: "default", floorOff: false, model: "deepseek-flash", ctx: { used: 0.01, soft: 0.5, hard: 0.8 }, tokPerSec: null, branch: "main", folder: "~/work" };

describe("the bar counts the session's tasks", () => {
	it("right after the mode, before `/mode to switch`", () => {
		setGround("light");
		const row = plain(statusBar({ ...BAR, tasks: { running: 2 } }, 120, null));
		expect(row).toMatch(/^ default {3}● 2 tasks running {2}\/mode to switch {2}deepseek-flash/);
		expect(plain(statusBar({ ...BAR, tasks: { running: 1 } }, 120, null))).toContain(" default   ● 1 task running  /mode to switch");
		expect(row).not.toContain("◌");
	});

	it("the mark carries the colour — the machine's blue — and the words are quiet", () => {
		setGround("light");
		const p = palette();
		expect([p.blue, p.dim].includes(""), "the palette is on").toBe(false);
		const row = statusBar({ ...BAR, tasks: { running: 2 } }, 120, null);
		expect(row).toContain(`${p.blue}●${p.fgEnd} ${p.dim}2 tasks running`);
	});

	it("no tasks: the bar is the bar it was, byte for byte", () => {
		for (const g of ["light", "unknown"] as const) {
			setGround(g);
			expect(statusBar({ ...BAR, tasks: { running: 0 } }, 100, null)).toBe(statusBar(BAR, 100, null));
		}
	});

	it("a fact: it never gives way — the hints and the place go first; every width fits", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 1) {
				const row = statusBar({ ...BAR, tasks: { running: 2 } }, W, "expand all");
				expect(visibleWidth(row), `${g} W=${W}`).toBeLessThanOrEqual(W);
				if (W >= 70) expect(plain(row), `${g} W=${W}`).toContain("2 tasks running");
			}
		}
	});
});

describe("the live row teaches ctrl+b while a command can be moved", () => {
	it("after esc, before the steer and the redirect; gone when nothing can move", () => {
		setGround("light");
		const on = plain(workingRow("✳", Date.now(), null, null, 120, null, true));
		expect(on).toMatch(/esc stop · ctrl\+b background · ⏎ steer · alt\+⏎ redirect$/);
		expect(plain(workingRow("✳", Date.now(), null, null, 120, null))).not.toContain("ctrl+b");
		// narrow: the steer and the redirect give way before ctrl+b does
		expect(plain(workingRow("✳", Date.now(), null, null, 44, null, true))).toMatch(/esc stop · ctrl\+b background$/);
	});
});
