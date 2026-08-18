/**
 * TUI2-R2pre ② — BUG-2: large blank gaps mid-history.
 *
 * The owner's field report: scrolling back through a long session shows
 * multi-row blank bands INSIDE the transcript. The screen is fine — every
 * frame repaints the window at absolute rows — so no screen-state gate
 * could see it. The damage is in the terminal's SCROLLBACK, which is
 * append-only and which the house emulator throws away (its LF drops the
 * top row on the floor). `WideScreen` keeps it.
 *
 * Three accounting errors, one class — the number of rows the frame
 * scrolls must equal the number of model rows that LEFT the window:
 *   (a) #drawFull scrolled `skip` (the window's absolute top) every full
 *       redraw, not the delta since the previous frame;
 *   (b) #drawSteady scrolled one row per line COMMITTED this frame, which
 *       is a different number entirely;
 *   (c) `skip` was recomputed from the CURRENT model height, so it fell
 *       when the live region shrank (a tool cell collapsing into its
 *       one-line rollup). A window top that falls is a window that
 *       un-scrolls — which a terminal cannot do — so the next growth
 *       re-scrolled rows that had already left, duplicating them and
 *       pushing the blanks the repaint had left behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { WideScreen, longestInnerBlankRun } from "./helpers/wide-screen.js";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const PARA =
	"\u8fd9\u4e2a\u4ed3\u5e93\u7684\u7f16\u8bd1\u5668\u524d\u7aef\u7531\u8bcd\u6cd5\u5206\u6790\u5668\u548c\u8bed\u6cd5\u5206\u6790\u5668\u4e24\u90e8\u5206\u7ec4\u6210\uff0c" +
	"\u8bcd\u6cd5\u5206\u6790\u5668\u8d1f\u8d23\u628a\u6e90\u7801\u5207\u5206\u6210\u8bb0\u53f7\u6d41\uff0c\u8bed\u6cd5\u5206\u6790\u5668\u518d\u628a\u8bb0\u53f7\u6d41\u89c4\u7ea6\u6210\u62bd\u8c61\u8bed\u6cd5\u6811\u3002" +
	"\u6211\u5728\u9605\u8bfb\u7684\u8fc7\u7a0b\u4e2d\u6ce8\u610f\u5230\uff0c\u9519\u8bef\u6062\u590d\u7684\u903b\u8f91\u5206\u6563\u5728\u82e5\u5e72\u4e2a\u4e0d\u540c\u7684\u4f4d\u7f6e\u3002";

/** The owner's session shape: many turns, each with a run of capped reads
 *  and a long wrapped paragraph. */
function session(W: number, H: number, turns: number): WideScreen {
	const screen = new WideScreen(H, W);
	const composer = "\u5e2e\u6211\u5ba1\u8ba1\u4e00\u4e0b\u8fd9\u4e2a\u4ed3\u5e93\u7684\u7f16\u8bd1\u5668\u524d\u7aef";
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => screen.write(s),
	});
	body.bindInput(() => ({ line: composer, cursor: composer.length }), "> ");
	body.enter();
	for (let turn = 0; turn < turns; turn += 1) {
		body.userLine(`\u7b2c ${turn + 1} \u8f6e\uff1a\u8bf7\u7ee7\u7eed\u5ba1\u8ba1\u4ed3\u5e93\u91cc\u7684\u7f16\u8bd1\u5668\u524d\u7aef\u5b9e\u73b0`);
		body.render();
		for (let t = 0; t < 3; t += 1) {
			const id = `c${turn}-${t}`;
			body.toolStart("read_file", id, { path: `src/parser/expr-${t}.ts`, offset: 150 });
			body.render();
			body.toolRunning(id);
			body.render();
			body.toolResult(id, { content: "\u7b2c 1 \u884c\n\u7b2c 2 \u884c\n…[truncated] offset=150\n", isError: false });
			body.toolSucceeded(id);
			body.render();
		}
		for (let i = 0; i < PARA.length; i += 9) {
			body.textAppend(PARA.slice(i, i + 9));
			body.render();
		}
		body.textEnd();
		body.endTurn(1.5);
		body.render();
	}
	return screen;
}

describe("TUI2-R2pre ② — the scrollback is the transcript", () => {
	it("T-R2p-5: no blank band wider than 2 rows anywhere in the committed history", () => {
		const offenders: string[] = [];
		for (const H of [20, 24, 30]) {
			for (const W of [60, 80, 100]) {
				const screen = session(W, H, 4);
				const { run } = longestInnerBlankRun(screen.scrollback);
				if (run > 2) offenders.push(`W=${W} H=${H} run=${run}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("T-R2p-6: the duplicate copies of a committed line are BOUNDED — finding R2pre-1 is what remains", () => {
		// FINDING R2pre-1 (escalated, not fixed here): a committed line can
		// still reach the scrollback more than once. The remaining mechanism
		// is the third one named above — `skip` is recomputed from the
		// CURRENT model height, so it FALLS when the live region shrinks, and
		// the next growth re-scrolls rows that had already left.
		//
		// The correct fix is a MONOTONE window top, and it was built and
		// measured this round: it makes the scrollback exact, and it
		// reintroduces the A8 on-screen pileup the R1.5 round closed — the
		// un-scroll debt has to go somewhere, and with the history frozen the
		// only place left is a blank band above the composer (a7-replay's A8
		// gate went from 107/144/83 bad frames to 384/456/178, and the fill
		// index from 110/147/98 to 726/726/723). Trading the reported bug for
		// a reopened one is not a fix, so the window top is left alone and
		// the residue is bounded here instead. Adjudication: the integrator.
		const worst: string[] = [];
		for (const [W, H] of [[60, 20], [80, 24], [100, 30], [120, 24]] as const) {
			const screen = session(W, H, 5);
			const seen = new Map<string, number>();
			for (const row of screen.scrollback) {
				const key = row.trim();
				if (key === "") continue;
				seen.set(key, (seen.get(key) ?? 0) + 1);
			}
			// the per-turn user chip is the one line that is unique CONTENT in
			// the model — the read rollups repeat by nature.
			const copies = [...seen.entries()].filter(([k]) => k.includes("\u8f6e\uff1a\u8bf7\u7ee7\u7eed\u5ba1\u8ba1")).map(([, n]) => n);
			const max = Math.max(0, ...copies);
			if (max > 3) worst.push(`${W}x${H}: ${max} copies`);
		}
		expect(worst).toEqual([]);
	});

	it("T-R2p-7: the scrollback holds real transcript — the blank share never dominates", () => {
		// the direct consequence of the over-scroll: rows the repaint had
		// already blanked were pushed into the history as blanks. A healthy
		// session's scrollback is mostly content.
		const screen = session(80, 24, 5);
		const rows = screen.scrollback;
		const blanks = rows.filter((r) => r.trim() === "").length;
		expect(`${rows.length} rows, ${blanks} blank`).toBe(`${rows.length} rows, ${Math.min(blanks, Math.floor(rows.length / 3))} blank`);
	});
});
