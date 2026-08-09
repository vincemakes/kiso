/**
 * W21 — the approval panel, unit-tested: invariant ① (every row's
 * visible width ≤ W across the width/height/phase/sel grid — the W20
 * #checked discipline the compositor enforces on every emitted line),
 * the bounded-block row count (the args fold + cap with the notice
 * row), and the single-row lines CUTTING (the rule line, the title,
 * the options row) while the args FOLD (the W21 "single-row lines cut,
 * body folds" rule).
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import {
	panelAffordance,
	panelBlockRows,
	panelLead,
	panelLeadPlain,
	panelLeadWidth,
	panelStatus,
	type PanelPhase,
	type PanelSel,
	type PanelView,
} from "../src/approval-panel.js";

/** An approval-flavor view with a long rule name, a long title, and a
 *  diff whose lines exceed any reasonable width (the fold path). */
function approvalView(): PanelView {
	return {
		flavor: "approval",
		name: "this-is-a-very-long-tool-name-that-must-cut",
		title: "edit /a/very/long/path/that/must/cut/at/narrow/widths/file.ts",
		speaker: "mode:default",
		hint: "/mode accept-edits auto-approves edits",
		statusText: "▸ run paused",
		args: {
			kind: "diff",
			diff: [
				{ kind: " ", text: "    const line = 'a line that is very long and keeps going past any width'" },
				{ kind: "-", text: "    const old = 'the old line that gets replaced by the new one'" },
				{ kind: "+", text: "    const fresh = 'the brand new line that was written by the tool'" },
				{ kind: " ", text: "    return { ok: true, message: 'a trailing context line for the diff' }" },
			],
		},
		fallbackQuestion: "approve this-is-a-very-long-tool-name-that-must-cut? (y/n) ",
	};
}

/** The simple flavor (the trust gate / uncertain resolutions). */
function simpleView(): PanelView {
	return {
		flavor: "simple",
		name: "project trust",
		title: "/a/very/long/project/root/that/must/cut/at/narrow/widths",
		speaker: "kiso",
		statusText: "▸ project trust",
		args: { kind: "text", lines: ["config.mjs  (a1b2c3)", "mcp.json  (d4e5f6)"] },
		ruleOverride: "trust this project's .kiso?",
		fallbackQuestion: "trust this project's .kiso? (y/n) ",
	};
}

const WIDTHS = [48, 64, 80, 120];
const MAX_ROWS = [8, 12, 20];
const PHASES: readonly PanelPhase[] = ["options", "rule", "amend"];
const SELS: readonly PanelSel[] = [0, 1, 2, 3];

describe("W21: panelBlockRows", () => {
	it("invariant ① — every row's visible width ≤ W across the W/height/phase/sel grid", () => {
		for (const W of WIDTHS) {
			for (const maxRows of MAX_ROWS) {
				for (const phase of PHASES) {
					for (const sel of SELS) {
						const rows = panelBlockRows(approvalView(), phase, sel, W, maxRows);
						for (const row of rows) {
							expect(visibleWidth(row), `W=${W} maxRows=${maxRows} phase=${phase} sel=${sel}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(W);
						}
					}
					const sRows = panelBlockRows(simpleView(), phase, 0, W, maxRows);
					for (const row of sRows) {
						expect(visibleWidth(row), `simple W=${W} maxRows=${maxRows} phase=${phase}`).toBeLessThanOrEqual(W);
					}
				}
			}
		}
	});

	it("the block's row count is bounded by maxRows — the args fold, the single rows cut", () => {
		for (const W of WIDTHS) {
			for (const maxRows of MAX_ROWS) {
				const rows = panelBlockRows(approvalView(), "options", 0, W, maxRows);
				expect(rows.length, `W=${W} maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows);
			}
		}
	});

	it("short args render exactly 6 + n rows (no cap, no notice)", () => {
		const rows = panelBlockRows(simpleView(), "options", 0, 80, 20);
		expect(rows).toHaveLength(6 + 2);
		expect(rows.join("")).not.toContain("more rows");
	});

	it("overflowing args cap at maxRows − 1 and carry the +N notice row", () => {
		// the 4-row diff overflows a maxRows-8 block: budget 2 → keep 1 +
		// the notice (+3 more rows).
		const rows = panelBlockRows(approvalView(), "options", 0, 120, 8);
		expect(rows).toHaveLength(8);
		expect(rows.some((r) => r.includes("+3 more rows — the full args are in the event log"))).toBe(true);
	});

	it("the args are the ALWAYS-verbose shape — the fold shows every diff row, never the capped copy", () => {
		// The diff has 4 rows + 6 fixed rows = 10; at maxRows 12 nothing is cut.
		const rows = panelBlockRows(approvalView(), "options", 0, 120, 12);
		expect(rows).toHaveLength(10);
		expect(rows.join("")).toContain("the brand new line that was written by the tool");
		expect(rows.join("")).toContain("the old line that gets replaced by the new one");
	});
});

describe("W21: the panel chrome helpers", () => {
	it("the leads name the phase — the digit leads bold, the rule/amend leads plain", () => {
		expect(panelLeadPlain(approvalView(), "options", 0)).toBe("1-3> ");
		expect(panelLeadPlain(simpleView(), "options", 0)).toBe("1/3> ");
		expect(panelLeadPlain(approvalView(), "rule", 2)).toBe("2 Yes, don't ask again for ");
		expect(panelLeadPlain(approvalView(), "amend", 3)).toBe("feedback (deny): ");
		expect(panelLeadPlain(approvalView(), "amend", 1)).toBe("feedback (amend): ");
		// the width is the PLAIN text's display width — the colored lead
		// renders wider in bytes but occupies the same cells.
		expect(panelLeadWidth(approvalView(), "options", 0)).toBe(5);
		expect(panelLeadWidth(approvalView(), "rule", 2)).toBe("2 Yes, don't ask again for ".length);
		expect(panelLeadWidth(approvalView(), "amend", 3)).toBe("feedback (deny): ".length);
	});

	it("the status is the phase, the affordance the phase's keys", () => {
		expect(panelStatus(approvalView(), "options", 0)).toBe("▸ run paused");
		expect(panelStatus(approvalView(), "rule", 2)).toBe("▸ rule input");
		expect(panelStatus(approvalView(), "amend", 3)).toBe("▸ deny · the words become the tool_result");
		expect(panelAffordance(approvalView(), "options", 0)).toBe("tab amend · esc cancel");
		expect(panelAffordance(approvalView(), "options", 1)).toBe("enter sends · esc backs out");
		expect(panelAffordance(simpleView(), "options", 0)).toBe("esc cancel");
		expect(panelAffordance(simpleView(), "options", 3)).toBe("enter sends");
		expect(panelAffordance(approvalView(), "rule", 2)).toBe("enter commits · esc backs out");
	});
});
