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
	"这个仓库的编译器前端由词法分析器和语法分析器两部分组成，" +
	"词法分析器负责把源码切分成记号流，语法分析器再把记号流规约成抽象语法树。" +
	"我在阅读的过程中注意到，错误恢复的逻辑分散在若干个不同的位置。";

/** The owner's session shape: many turns, each with a run of capped reads
 *  and a long wrapped paragraph. */
function session(W: number, H: number, turns: number): WideScreen {
	const screen = new WideScreen(H, W);
	const composer = "帮我审计一下这个仓库的编译器前端";
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
		body.userLine(`第 ${turn + 1} 轮：请继续审计仓库里的编译器前端实现`);
		body.render();
		for (let t = 0; t < 3; t += 1) {
			const id = `c${turn}-${t}`;
			body.toolStart("read_file", id, { path: `src/parser/expr-${t}.ts`, offset: 150 });
			body.render();
			body.toolRunning(id);
			body.render();
			body.toolResult(id, { content: "第 1 行\n第 2 行\n…[truncated] offset=150\n", isError: false });
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

	it("T-R2p-6: a committed line reaches the scrollback ONCE — a window top that falls re-scrolls it", () => {
		const screen = session(80, 24, 4);
		const seen = new Map<string, number>();
		for (const row of screen.scrollback) {
			const key = row.trim();
			if (key === "") continue;
			seen.set(key, (seen.get(key) ?? 0) + 1);
		}
		// the user line differs per turn, the read rollup repeats by nature —
		// so count only lines that are unique CONTENT in the model: the
		// per-turn user chips.
		const dupedUserChips = [...seen.entries()].filter(([k, n]) => k.includes("轮：请继续审计") && n > 1);
		expect(dupedUserChips).toEqual([]);
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
