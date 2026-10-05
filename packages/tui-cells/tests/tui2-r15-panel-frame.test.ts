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

// DECLARED REVERSAL (Graphite P4, owner 2026-10-04): the panel no longer
// closes with a rule of its own — it doubled the composer's rail, which sits
// right under the band. VD-13's finding stands and is still pinned below:
// the block's last row is never an orphan `└` elbow, and the cut notice's
// elbow can never be read as an edge. The last row is the KEY row now.
describe("TUI2-R1.5 ⑪, Graphite P4 — the panel closes on its key row (VD-13)", () => {
	it("the last row is the key row, with the counter at the margin — not an elbow, not a rule", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 60, 20);
		const last = rows[rows.length - 1]!;
		expect(last).not.toBe("└ ");
		expect(last.startsWith("\u2500")).toBe(false);
		expect(last).toMatch(/^ {2}↑↓ move .* 2\/4$/);
		expect(visibleWidth(last)).toBe(59);
	});

	it("the key row holds at EVERY width, and the row count is the band, the head, the body, the options and the key row", () => {
		for (const W of [40, 46, 48, 64, 80, 120]) {
			const rows = panelBlockRows(VIEW, "options", 1, W, 20);
			expect(visibleWidth(rows[rows.length - 1]!), `W=${W}`).toBeLessThanOrEqual(W - 1);
			expect(rows[rows.length - 1], `W=${W}`).toMatch(/ 2\/4$/);
			expect(rows, `W=${W}`).toHaveLength(2 + 2 + 4 + 1);
		}
	});

	it("ONE rule: the band's own, on its first row — the cut-notice elbow never collides with an edge", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 60, 20);
		expect(rows.filter((r) => r.startsWith("\u2500"))).toHaveLength(1);
		expect(rows[0]!.startsWith("\u2500")).toBe(true);
	});
});

// MOVED (the TUI2-R3v2 panel-selection supersession class): there is no
// options ROW to separate any more. R1.5 ⑪ settled that the options had to
// share the product's one separator grammar; the list settles the question
// by removing it — each option is on its own line, which is the strongest
// form of "these are three separate things" a terminal has.
describe("TUI2-R3v2 ① — one option per row, in the frame's order", () => {
	it("the approval flavor lists all four options, numbered from one", () => {
		const rows = panelBlockRows(VIEW, "options", 1, 80, 20);
		const labels = ["Yes, run it", "don't ask again", "Show me safer ways to do this", "No — let me tell it what to do instead"];
		for (let i = 0; i < labels.length; i += 1) {
			const row = rows.find((r) => r.includes(labels[i]!));
			expect(row, labels[i]).toBeDefined();
			expect(row).toContain(`${i + 1} `);
		}
	});

	it("a SIMPLE panel lists two, and the second one is the No", () => {
		const rows = panelBlockRows({ ...VIEW, flavor: "simple" as const }, "options", 1, 80, 20);
		expect(rows.some((r) => r.includes(" 1 Yes"))).toBe(true);
		expect(rows.some((r) => r.includes(" 2 No"))).toBe(true);
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
