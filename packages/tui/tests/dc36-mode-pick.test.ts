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
 *   - the panel offers NO way to type an answer for a closed set (P3: the
 *     `t` row and its phase are gone; a model picker's filter offers a typed
 *     `provider/model` as a row instead).
 */

import { describe, expect, it } from "vitest";
import { panelRowsOf } from "../src/ask-panel.js";
import { modePickView, type PickSpec } from "../src/approval-panel.js";

/** The rows the CLI's /mode offers: the four tiers by their labels — the
 *  don't-ask switch is not a tier and is not a row (owner, 2026-09-30). */
const TIERS = ["default", "accept edits", "plan", "full access"] as const;
/** Astra F4 widened the CLI's real notes (each asking tier now says a saved
 *  allow still allows). A fixture SHORTER than the world is the DF-0330-F1
 *  trap — it measures an easier layout than the one that ships — so these
 *  are the live strings, copied, and the longest of them rides the tier
 *  whose row this file measures. */
const NOTES: Readonly<Record<(typeof TIERS)[number], string>> = {
	default: "read-only runs; the rest asks — a saved allow still allows",
	"accept edits": "read-only, edits run; rest asks — a saved allow still allows",
	plan: "reads run; all else is denied — read-only, and a deny wins",
	"full access": "runs without asking — a user deny and the floor still win",
};
const SPEC: PickSpec = {
	header: "mode — current: default",
	options: TIERS.map((n) => ({ label: n, note: n === "default" ? `${NOTES[n]} · current` : NOTES[n] })),
};
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("DC-36 — the mode picker", () => {
	it("offers every OFFERED tier, and no `t` row: the four are the whole world", () => {
		const rows = panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor: 0, level: null } }, 90, 14).map(plain);
		const body = rows.join("\n");
		for (const t of TIERS) expect(body, `${t} is not offered`).toContain(t);
		expect(body, "a closed set was given a `type it directly` row").not.toMatch(/^\s*t\s/m);
	});

	it("the affordance names the arrows, not only the digits", () => {
		// DC-30's lesson: the keys sheet has said `panels: ↑↓ move` since
		// TUI2-R2 ④, but THIS row — the one a human reads while the panel
		// is up — advertised only the digits, and the owner read it as
		// "type the answer".
		const rows = panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor: 0, level: null } }, 90, 14).map(plain);
		expect(rows.join("\n")).toContain("↑↓ move");
	});

	it("the cursor is what the panel marks — it moves with the pick state", () => {
		const at = (cursor: number): string =>
			panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: { cursor, level: null } }, 90, 14)
				.map(plain)
				.find((r) => r.trimStart().startsWith("→")) ?? "";
		expect(at(0), "the cursor does not mark the first tier").toContain("default");
		expect(at(3), "the cursor does not follow the pick state").toContain("full access");
		expect(at(0)).not.toBe(at(3));
	});

	// RE-DERIVED (Graphite P3): the `t` row retired into the model picker's
	// filter. The asymmetry it pinned stands: a model that exists but is not
	// configured has to stay typeable, and a closed set offers no such row.
	it("a model picker KEEPS a way to type a model — its list is never the whole world", () => {
		const typed = { cursor: 0, level: null, query: "openai/deepseek-reasoner" };
		const open: PickSpec = { ...SPEC, input: "filter", direct: true };
		const rows = panelRowsOf({ view: modePickView(open, "▸ default"), phase: "options", cursor: 0, pick: typed }, 90, 14).map(plain);
		expect(rows.join("\n")).toContain("use openai/deepseek-reasoner directly");
		const closed = panelRowsOf({ view: modePickView(SPEC, "▸ default"), phase: "options", cursor: 0, pick: typed }, 90, 14).map(plain);
		expect(closed.join("\n"), "a closed set has nothing to type into").not.toContain("directly");
	});
});
