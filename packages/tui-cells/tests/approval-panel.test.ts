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
		statusText: "❯ run paused",
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
		statusText: "❯ project trust",
		args: { kind: "text", lines: ["config.mjs  (a1b2c3)", "mcp.json  (d4e5f6)"] },
		ruleOverride: "trust this project's .kiso?",
		fallbackQuestion: "trust this project's .kiso? (y/n) ",
	};
}

// 40/46: the crash widths from the 0.1.42 release-smoke — below 47 the
// option-2 span cannot fit (45 fixed cells + the ellipsis cell) and
// drops; the invariant must hold there too (it fired at 40 pre-fix)
const WIDTHS = [40, 46, 48, 64, 80, 120];
const MAX_ROWS = [8, 12, 20];
// MOVED (the TUI2-R3v2 panel-selection supersession class): the "rule"
// phase is retired and the selection is a 0-based CURSOR into the option
// list, so the grid sweeps the rows a bar can sit on rather than the
// four values the old PanelSel union had.
const PHASES: readonly PanelPhase[] = ["options", "amend"];
const CURSORS: readonly number[] = [0, 1, 2, 3];

describe("W21: panelBlockRows", () => {
	it("invariant ① — every row's visible width ≤ W across the W/height/phase/sel grid", () => {
		for (const W of WIDTHS) {
			for (const maxRows of MAX_ROWS) {
				for (const phase of PHASES) {
					for (const sel of CURSORS) {
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

	// MOVED (R1.5 slice 11, the panel-frame class — DECLARED THIS ROUND):
	// the threshold moved DOWN, and the case is stronger for it. Option 2
	// no longer repeats the tool name — the panel's title says it, one row
	// above — so the row's fixed part is 33 cells instead of 45 and the
	// full three-option grammar now survives a 40-column winch that used
	// to drop it. The property the case exists for is unchanged and still
	// asserted at the widths where the drop DOES happen: the 1/3 decision
	// survives any width, and invariant 1 never fires on this row.
	// MOVED (the TUI2-R3v2 panel-selection supersession class): the case
	// asserted that a narrow winch DROPS the middle option to save the row,
	// keeping 1/3 as the semantics worth saving. A list has no row to save —
	// each option owns one — so the property inverts into a stronger one: at
	// every width the winch survives, every option is still there. The
	// invariant-① half of the case is unchanged.
	it("a narrow winch drops no CHOICE — every option keeps its row, cut but present", () => {
		for (const W of [20, 28, 34, 40, 46]) {
			for (const maxRows of MAX_ROWS) {
				const rows = panelBlockRows(approvalView(), "options", 0, W, maxRows);
				for (const row of rows) expect(visibleWidth(row), `W=${W} maxRows=${maxRows}`).toBeLessThanOrEqual(W);
			}
		}
		// at 28 columns the LABELS are cut to fit; all four rows are there,
		// which is the choice surviving — the thing the retired case traded
		// away to keep the block one row shorter.
		const narrow = panelBlockRows(approvalView(), "options", 0, 28, 20).map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
		// R2: the │ gutter left the option rows (a gutter scopes a verbatim
		// block; an option list is not one) and the cursor row leads with →.
		expect(narrow.filter((r) => /^\s*[→ ] ?[1-4] \S/.test(r))).toHaveLength(4);
		expect(narrow.filter((r) => /^\s*→ [1-4] \S/.test(r)), "the cursor row names itself in PLAIN text").toHaveLength(1);
	});

	it("the block's row count is bounded by maxRows — the args fold, the single rows cut", () => {
		for (const W of WIDTHS) {
			for (const maxRows of MAX_ROWS) {
				const rows = panelBlockRows(approvalView(), "options", 0, W, maxRows);
				expect(rows.length, `W=${W} maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows);
			}
		}
	});

	// MOVED (the TUI2-R3v2 panel-selection supersession class): the fixed
	// chrome is five rows (rule, title, divider, affordance, corner) plus
	// ONE ROW PER OPTION — two on the simple flavor — where it used to be
	// five plus one shared options row.
	it("short args render exactly 6 + options + n rows (R2: the block opens with a rule too)", () => {
		const rows = panelBlockRows(simpleView(), "options", 0, 80, 20);
		expect(rows).toHaveLength(6 + 2 + 2); // R2: six rows of frame
		expect(rows.join("")).not.toContain("more rows");
	});

	// MOVED (the TUI2-R3v2 panel-selection supersession class): the args and
	// the option list now SHARE the budget under the chrome, so an eight-row
	// block spends its rows differently. The property the case exists for is
	// unchanged: the block never exceeds maxRows, and what it cut says so.
	it("overflowing args cap under the shared budget and carry the +N notice row", () => {
		const rows = panelBlockRows(approvalView(), "options", 0, 120, 8);
		expect(rows).toHaveLength(8);
		expect(rows.some((r) => r.includes("more rows — the full args are in the event log"))).toBe(true);
	});

	it("the args are the ALWAYS-verbose shape — the fold shows every diff row, never the capped copy", () => {
		// the 4-row diff + 5 chrome rows + 4 option rows = 13; at maxRows 20
		// nothing is cut (the old 6-fixed-row arithmetic is superseded).
		const rows = panelBlockRows(approvalView(), "options", 0, 120, 20);
		expect(rows).toHaveLength(14); // R2: six rows of frame
		expect(rows.join("")).toContain("the brand new line that was written by the tool");
		expect(rows.join("")).toContain("the old line that gets replaced by the new one");
	});
});

describe("W21: the panel chrome helpers", () => {
	// MOVED (the TUI2-R3v2 panel-selection supersession class): "1-3> " and
	// "1/3> " were prompts for input the panel no longer asks for, and the
	// two "feedback (...)" leads collapsed into the single typed phase.
	it("the leads: NO lead while the list is up, the named prompt while typing", () => {
	// DECLARED SUPERSESSION (R2): the idle lead is EMPTY, not a chevron.
	// The composer dropped its own chevron this round — the cursor sits at
	// column one — so a panel that kept one would be the single surface
	// reintroducing the glyph everything else just removed. The NAMED
	// lead is untouched: `amend›` says where the keystrokes go, which is
	// information rather than decoration.
		expect(panelLeadPlain(approvalView(), "options", 0)).toBe("");
		expect(panelLeadPlain(simpleView(), "options", 0)).toBe("");
		expect(panelLeadPlain(approvalView(), "amend", 3)).toBe("amend\u203a ");
		// the width is the PLAIN text's display width — the colored lead
		// renders wider in bytes but occupies the same cells.
		expect(panelLeadWidth(approvalView(), "options", 0)).toBe(0);
		expect(panelLeadWidth(approvalView(), "amend", 3)).toBe("amend\u203a ".length);
		// and an empty lead spends NO bytes on styling nothing
		expect(panelLead(approvalView(), "options", 0)).toBe("");
	});

	// MOVED (the TUI2-R3v2 panel-selection supersession class): the
	// affordance no longer varies with the selection (every gesture is live
	// on every row), and the retired phases took their copy with them.
	it("the status is the phase, the affordance the v4 hint line", () => {
		// DECLARED SUPERSESSION (R2, design §4): the pending mark was `▸`,
		// which is also the checklist's "the current one". A panel waiting
		// on a human says `❯` — the one mark that means "nothing moves
		// until you answer". The 867a0fa literals are otherwise intact.
		expect(panelStatus(approvalView(), "options", 0)).toBe("❯ run paused");
		expect(panelStatus(approvalView(), "amend", 3)).toBe("❯ your note goes to the model — it will propose a new call");
		expect(panelAffordance(approvalView(), "options", 0)).toBe("↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		expect(panelAffordance(approvalView(), "options", 1)).toBe("↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		expect(panelAffordance(simpleView(), "options", 0)).toBe("↑↓ move · ⏎ or click confirms · 1-2 instant · esc");
		expect(panelAffordance(approvalView(), "amend", 3)).toBe("⏎ send · esc back");
	});
});
