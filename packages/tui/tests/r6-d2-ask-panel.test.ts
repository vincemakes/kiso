/**
 * R6 / D2 — the ask panel says what finishes it, and stops crashing.
 *
 * The owner's dogfood, verbatim: they moved the bar to option 1, pressed
 * enter, and nothing happened — no answer, no advance, no message. Then
 * "do I really have to type 1? that's inhuman", then, working it out
 * alone, "I see, it's multi-select; does it only take effect after
 * enter?".
 *
 * Three defects and one latent crash were behind that:
 *  - enter at rest was a SILENT NO-OP, in both modes, while the approval
 *    panel had already ruled the opposite (TUI2-R3v2 ①). Two selection
 *    models under one identical bar;
 *  - the affordance row never named ENTER, on the one shape where enter
 *    is the only finisher;
 *  - it hardcoded "1-4" whatever the option count was — REL-0152-D3's
 *    defect, one function down from where that finding fixed it;
 *  - and it was pushed UNCUT into the panel block, so a narrow terminal
 *    threw out of `#checked` (invariant ①).
 */

import { describe, expect, it } from "vitest";
import { askAffordance, askAffordanceFit, askBlockRows, askKey, type AskRuntime } from "../src/ask-panel.js";
import type { PanelView } from "../src/approval-panel.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const q = (n: number, multi: boolean) => ({
	question: "which part of kiso should I review?",
	header: "scope",
	multiSelect: multi,
	options: Array.from({ length: n }, (_, i) => ({ label: `option ${i + 1}`, description: `what option ${i + 1} means` })),
});
const view = (n: number, multi: boolean): PanelView => ({ ask: { questions: [q(n, multi)] } }) as unknown as PanelView;
const view2 = (n: number, multi: boolean): PanelView => ({ ask: { questions: [q(n, multi), q(n, multi)] } }) as unknown as PanelView;
/** picks and custom are per-question ARRAYS, one slot each (verified
 *  against approval-panel.ts:284). */
const start = (n = 1): AskRuntime => ({ phase: "options", qIndex: 0, cursor: 0, picks: Array.from({ length: n }, () => []), custom: Array.from({ length: n }, () => null) }) as unknown as AskRuntime;

describe("R6/D2 A — enter takes the bar's row", () => {
	it("SINGLE: enter on the bar answers and advances — it used to do nothing at all", () => {
		const v = view(4, false);
		const r = askKey(v.ask!, start(), "enter");
		expect(r.state.picks[0]).toEqual([0]); // the bar's row was taken
	});

	it("MULTI: enter with nothing marked MARKS the bar's row — the press becomes visible", () => {
		const v = view(4, true);
		const r = askKey(v.ask!, start(), "enter");
		expect(r.state.picks[0]).toEqual([0]);
		expect(r.state.qIndex).toBe(0); // ...and does NOT send yet
	});

	it("MULTI: a second enter, with something marked, sends the set", () => {
		const v = view2(4, true);
		let s = askKey(v.ask!, start(2), "2").state; // mark option 2
		expect(s.picks[0]).toEqual([1]);
		s = askKey(v.ask!, s, "enter").state;
		expect(s.qIndex).toBe(1); // it advanced — the set was sent
	});

	it("SINGLE: a digit still answers instantly — the fast path is untouched", () => {
		const v = view2(4, false);
		const s = askKey(v.ask!, start(2), "3").state;
		expect(s.picks[0]).toEqual([2]);
		expect(s.qIndex).toBe(1);
	});
});

describe("R6/D2 B — the row names the finisher, and the real option count", () => {
	it("SINGLE names ⏎ confirms; MULTI names ⏎ sends the set", () => {
		expect(askAffordance(start(), q(4, false))).toContain("⏎ confirms");
		expect(askAffordance(start(), q(4, true))).toContain("⏎ sends the set");
	});

	it("the digit range is the REAL count, never a hardcoded 1-4", () => {
		expect(askAffordance(start(), q(2, false))).toContain("1-2 instant");
		expect(askAffordance(start(), q(6, true))).toContain("space or 1-6 marks");
		expect(askAffordance(start(), q(2, false))).not.toContain("1-4");
	});

	it("the finisher is the LAST clause standing, in both modes, at every width", () => {
		for (const multi of [false, true]) {
			for (let W = 12; W <= 90; W += 1) {
				const row = askAffordanceFit(start(), q(4, multi), W);
				expect(plain(row).length, `W=${W} multi=${multi}`).toBeLessThanOrEqual(W);
				if (W >= 30) {
					expect(row, `W=${W} multi=${multi}`).toMatch(multi ? /⏎ sends/ : /⏎ confirms/);
					expect(row, `W=${W} multi=${multi}`).toContain("esc declines");
				}
			}
		}
	});
});

describe("R6/D2 C — the narrow-terminal CRASH", () => {
	it("a two-question multi ask renders at every width from 20 up, without throwing", () => {
		// The row used to be pushed uncut, and panel rows go through
		// #checked, which throws on any row wider than W. A multi-question
		// ask on question 2 at W ≤ 41, or any ask at W ≤ 32, killed the
		// renderer outright.
		const v = view2(4, true);
		const s = { ...start(2), qIndex: 1 } as AskRuntime;
		for (let W = 20; W <= 60; W += 1) {
			const rows = askBlockRows(v, s, W, 20);
			for (const row of rows) {
				expect(plain(row).length, `W=${W}`).toBeLessThanOrEqual(W);
				expect(row).not.toMatch(/[\n\r]/);
			}
		}
	});
});
