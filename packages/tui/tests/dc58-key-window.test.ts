/**
 * B (review of this round) — the digit keys name the rows the RENDERER drew.
 *
 * The renderer sized the pick window with `min(budget, PICK_MAX)`; the digit
 * handler sized its own with `PICK_MAX` alone. On a terminal whose budget is
 * smaller than nine the two disagreed, and the disagreement is not cosmetic:
 * the row a person reads as `1` is the row the key selects. So the frame is now
 * the only producer (`pickWindowOf` → `visiblePickWindow` → `BandHost.pickWindow`)
 * and this gate pins the agreement where it was broken.
 *
 * The gate drives the REAL editor (no pty: the wiring is the subject, not the
 * tty) with a small `maxRows`, a scrolled cursor, and asserts what `1` and `2`
 * select against the rows the same values would have drawn. The fallback path
 * is exercised too — it is what a caller without a bound surface gets, and it
 * must stay the old behaviour rather than a crash.
 *
 * Graphite P3 (owner, 2026-10-04): the window is §8.2's (five rows below a
 * 30-row terminal) and `pickWindow`, the budget-blind derivation this gate
 * compared against, is gone — `pickWindowOf` with an unlimited budget is
 * that derivation now. The subject (the digits name the drawn rows) is
 * unchanged.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { panelRowsOf } from "../src/ask-panel.js";
import { modelPickView, pickWindowOf, type PickSpec } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function many(n: number): PickSpec {
	return {
		header: "model — current: deepseek-v4-flash (openai-compat)",
		options: Array.from({ length: n }, (_, i) => ({ label: `model-${i + 1}`, note: `profile: p${i + 1}` })),
	};
}

/** The window a derivation that ignores the frame's budget would use. */
const unbudgeted = (view: ReturnType<typeof modelPickView>, cursor: number) => pickWindowOf(view, { cursor, level: null }, Number.MAX_SAFE_INTEGER, 24);

/** The option labels a frame with `maxRows` would DRAW, in order. */
function drawnLabels(cursor: number, maxRows: number, n = 60): string[] {
	const view = modelPickView(many(n), "▸ idle");
	return panelRowsOf({ view, phase: "options", cursor, pick: { cursor, level: null } }, 80, maxRows)
		.map(strip)
		.map((r) => /(model-\d+)/.exec(r)?.[1] ?? null)
		.filter((x): x is string => x !== null);
}

describe("B — the digits and the frame agree on the window", () => {
	it("a SMALL budget: `1` selects the first row the frame DREW, not the unbudgeted window's first", () => {
		const view = modelPickView(many(60), "▸ idle");
		// twelve rows down first: the window's origin is not zero any more, so
		// the two derivations are guaranteed to differ (that is the bug).
		const editor = new Editor(() => {});
		editor.beginPanel(view, () => {});
		editor.bindPickWindow(() => {
			const pick = editor.panelState()?.pick ?? null;
			return pick === null ? null : pickWindowOf(view, pick, 5, 24);
		});
		// the panel takes the keys before any arrow is meaningful
		editor.feed(enc("\x1b[B".repeat(12)));
		const cursor = editor.panelState()!.pick!.cursor;
		expect(cursor, "the cursor really scrolled").toBe(12);

		const drawn = drawnLabels(cursor, 5);
		const drawnWindow = pickWindowOf(view, { cursor, level: null }, 5, 24);
		const naiveFirst = unbudgeted(view, cursor).first;
		expect(drawnWindow.size, "the budget really is smaller than §8.2's five here").toBeLessThan(5);
		expect(drawnWindow.first, "and the two derivations really disagree — the bug this gate exists for").not.toBe(naiveFirst);
		expect(drawn.length, "the frame draws exactly the window").toBe(drawnWindow.size);
		expect(drawn[0], "whose first row is what `1` must mean").toBe(`model-${drawnWindow.first + 1}`);

		editor.feed(enc("1"));
		const afterFirst = editor.panelState()!.pick!.cursor;
		expect(afterFirst, "`1` = the first row of the frame that was on screen").toBe(drawnWindow.first);
		// A tiny window SLIDES with the cursor, so a digit names a row of the
		// frame in front of the person at THAT moment: `2` is read against the
		// fresh window, never against the one from a frame ago.
		const fresh = pickWindowOf(view, { cursor: afterFirst, level: null }, 5, 24);
		editor.feed(enc("2"));
		expect(editor.panelState()!.pick!.cursor, "`2` = the second row of THAT frame").toBe(fresh.first + 1);
	});

	it("a WIDE budget keeps §8.2's window (the budget narrows only what it must)", () => {
		const view = modelPickView(many(60), "▸ idle");
		const editor = new Editor(() => {});
		editor.beginPanel(view, () => {});
		editor.bindPickWindow(() => {
			const pick = editor.panelState()?.pick ?? null;
			return pick === null ? null : pickWindowOf(view, pick, 24, 24);
		});
		editor.feed(enc("\x1b[B".repeat(12)));
		editor.feed(enc("1"));
		expect(editor.panelState()!.pick!.cursor, "the same value the renderer used").toBe(unbudgeted(view, 12).first);
	});

	it("nothing bound: the input layer falls back to its own derivation instead of breaking", () => {
		const view = modelPickView(many(60), "▸ idle");
		const editor = new Editor(() => {});
		editor.beginPanel(view, () => {});
		editor.feed(enc("\x1b[B".repeat(12)));
		editor.feed(enc("1"));
		expect(editor.panelState()!.pick!.cursor).toBe(unbudgeted(view, 12).first);
	});
});
