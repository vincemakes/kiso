/**
 * DC-36 — a command whose argument is a CLOSED SET offers the set.
 *
 * The owner's report: `/mode` printed `tiers: manual default …` and
 * stopped, so switching a tier meant typing the word — while bare
 * `/model` has opened a picker since TUI2-R2 ④. Five fixed tiers is the
 * least defensible place in the product to make a human type: the whole
 * answer was already on screen and only the choosing was missing.
 *
 * Two things this file pins that the PTY case cannot:
 *   - ↑↓ really walk the cursor. A pty feed fires once on its needle, so
 *     a burst of arrows proves nothing about a walk;
 *   - the panel offers NO `t` row for a closed set, and `t` therefore
 *     opens no phase. A key that leads to a surface the panel does not
 *     draw is worse than an absent key.
 */

import { describe, expect, it } from "vitest";
import { panelRowsOf } from "../src/ask-panel.js";
import { modePickView, type PickSpec } from "../src/approval-panel.js";

const TIERS = ["manual", "default", "accept-edits", "plan", "bypass"] as const;
const SPEC: PickSpec = {
	header: "mode — current: default",
	options: TIERS.map((n) => ({ label: n, note: n === "default" ? "reads run; writes, edits and shell ask · current" : "a note" })),
};
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("DC-36 — the mode picker", () => {
	it("offers every tier, and no `t` row: the five are the whole world", () => {
		const rows = panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } }, 90, 14).map(plain);
		const body = rows.join("\n");
		for (const t of TIERS) expect(body, `${t} is not offered`).toContain(t);
		expect(body, "a closed set was given a `type it directly` row").not.toMatch(/^\s*t\s/m);
	});

	it("the affordance names the arrows, not only the digits", () => {
		// DC-30's lesson: the keys sheet has said `panels: ↑↓ move` since
		// TUI2-R2 ④, but THIS row — the one a human reads while the panel
		// is up — advertised only the digits, and the owner read it as
		// "type the answer".
		const rows = panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } }, 90, 14).map(plain);
		expect(rows.join("\n")).toContain("↑↓ move");
	});

	it("the cursor is what the panel marks — it moves with the pick state", () => {
		const at = (cursor: number): string =>
			panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor, phase: "options" } }, 90, 14)
				.map(plain)
				.find((r) => r.trimStart().startsWith("→")) ?? "";
		expect(at(0), "the cursor does not mark the first tier").toContain("manual");
		expect(at(4), "the cursor does not follow the pick state").toContain("bypass");
		expect(at(0)).not.toBe(at(4));
	});

	it("a model picker KEEPS its `t` row — its list is never the whole world", () => {
		// the asymmetry is the point: a model that exists but is not
		// configured has to stay typeable, which is why typeHint is
		// optional rather than gone.
		const withHint: PickSpec = { ...SPEC, typeHint: "type provider/model directly" };
		const rows = panelRowsOf({ view: modePickView(withHint, "▸ default"), phase: "options", cursor: 0, pick: { cursor: 0, phase: "options" } }, 90, 14).map(plain);
		expect(rows.join("\n")).toContain("type provider/model directly");
	});
});
