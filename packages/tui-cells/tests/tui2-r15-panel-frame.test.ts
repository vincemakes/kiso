/**
 * TUI2-R1.5 slice ⑪ — VD-13: the approval panel's bottom edge.
 *
 * The block closed with `└ ` — a two-cell stub floating at column 1,
 * with no rule running from it and no corner above it to answer. The
 * same glyph is the cut-notice prefix everywhere else in the product, so
 * a capped panel emitted two `└` rows meaning unrelated things. And the
 * options row separated its three choices with two spaces while every
 * other metadata group in the product separates with `·`, which is why
 * `3 No` read as detached rather than as the third option.
 *
 * The panel's edge vocabulary is the `─` of its own divider; the bottom
 * is now a real rule in that vocabulary, anchored at the gutter column.
 * The ask panel shares it — the two frames were byte-identical at the
 * edges and stay that way.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { panelBlockRows } from "../src/approval-panel.js";
import { visibleWidth } from "../src/components.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const VIEW = {
	flavor: "approval" as const,
	name: "edit_file",
	title: "src/parser.ts",
	speaker: "mode:default",
	statusText: "▸ run paused",
	args: { kind: "text" as const, lines: ["one", "two"] },
	fallbackQuestion: "approve edit_file? (y/n) ",
};

describe("TUI2-R1.5 ⑪ — the panel closes with a real rule (VD-13)", () => {
	it("the last row is a RULE across the width, not an orphan elbow", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 60, 20);
		const last = rows[rows.length - 1]!;
		expect(last).not.toBe("└ ");
		expect(last.startsWith("└")).toBe(true);
		expect(visibleWidth(last)).toBe(60);
		expect(last).toBe(`└${"─".repeat(59)}`);
	});

	it("the rule spans the width at EVERY width, and the row count is unchanged", () => {
		for (const W of [40, 46, 48, 64, 80, 120]) {
			const rows = panelBlockRows(VIEW, "options", 1, W, 20);
			expect(visibleWidth(rows[rows.length - 1]!), `W=${W}`).toBe(W);
			expect(rows, `W=${W}`).toHaveLength(6 + 2); // the frame is still 6 fixed rows
		}
	});

	it("the ONE `└` in the block is the bottom rule — the cut-notice elbow no longer collides", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 60, 20);
		expect(rows.filter((r) => r.startsWith("└"))).toHaveLength(1);
	});
});

describe("TUI2-R1.5 ⑪ — one separator grammar on the options row (VD-13)", () => {
	it("the three options are `·`-separated, like every other metadata group", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 80, 20);
		const options = rows.find((r) => r.includes("1 Yes"))!;
		expect(options).toContain("1 Yes · 2 Yes, don't ask again · 3 No");
		expect(options).not.toContain("Yes  ");
	});

	it("a SIMPLE panel keeps two options, same separator", () => {
		const rows = panelBlockRows({ ...VIEW, flavor: "simple" as const }, "options", 1, 80, 20);
		expect(rows.find((r) => r.includes("1 Yes"))!).toContain("1 Yes · 3 No");
	});

	it("invariant ① — every row fits the width across the grid", () => {
		for (const W of [40, 46, 48, 64, 80, 120]) {
			for (const sel of [0, 1, 2, 3] as const) {
				for (const row of panelBlockRows(VIEW, "options", sel, W, 12)) {
					expect(visibleWidth(row), `W=${W} sel=${sel}: ${row}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});
});
