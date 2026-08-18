/**
 * TUI2-R2pre ① — BUG-1: streaming clobbers the composer box.
 *
 * The owner's first real 0.9.0 session (a CJK-heavy audit) reported that
 * new content OCCASIONALLY overwrote part of the composer box while a
 * turn streamed. The repro below is deterministic.
 *
 * The mechanism is width accounting, not height: a glyph the width table
 * scores 1 but a terminal draws in 2 columns makes a line whose MEASURED
 * width is ≤ W really need W+1 columns. Invariant ① passes (it measures
 * with the same table), the compositor budgets ONE row for the line, and
 * the terminal soft-wraps the tail onto the next row — the row the dock
 * is standing on. Pure CJK never trips it: those ranges are in the table.
 * The emoji-presentation ranges (✅ ❌ 🚀 🀄 🟠 🫶) are the hole, and a
 * model writing Chinese technical prose emits them constantly.
 *
 * The screen here measures with `referenceWidth` (Unicode EAW +
 * Emoji_Presentation), NOT with the source table — otherwise the emulator
 * would repeat the compositor's own mistake and agree with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { displayWidth } from "../src/width.js";
import { WideScreen, referenceWidth } from "./helpers/wide-screen.js";

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

/** A Body whose every byte lands on a width-aware screen. */
function screenBody(W: number, H: number, composer: string) {
	const screen = new WideScreen(H, W);
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => screen.write(s),
	});
	body.bindInput(() => ({ line: composer, cursor: composer.length }), "> ");
	return { body, screen };
}

/** The dock's own rows, by their glyphs — the box rails are unmistakable. */
function dockIntact(screen: WideScreen, H: number): boolean {
	const rows = screen.visible();
	return rows.findIndex((r) => /^╭─+╮$/.test(r)) !== -1 && rows.findIndex((r) => /^╰─+╯$/.test(r)) === H - 2;
}

const EMOJI_PARA =
	"✅ 词法分析器负责把源码切分成记号流，这一部分的实现是清晰的。" +
	"🚀 语法分析器再把记号流规约成抽象语法树，性能上没有明显问题。" +
	"❌ 但是错误恢复的逻辑分散在若干个不同的位置，导致同一类语法错误" +
	"在不同的上下文里会产生不一样的诊断信息，建议统一到一个模块里。";

describe("TUI2-R2pre ① — the width table is the composer's floor", () => {
	it("T-R2p-1: the emoji-presentation glyphs measure 2 — the table's hole is what lets a line overrun W", () => {
		// every one of these is Emoji_Presentation=Yes: a terminal draws it
		// in TWO columns, with no variation selector involved
		for (const glyph of ["✅", "❌", "🚀", "🀄", "🟠", "🫶", "⭐", "⬛"]) {
			expect(`${glyph} measures ${displayWidth(glyph)}`).toBe(`${glyph} measures 2`);
		}
	});

	it("T-R2p-2: the chrome's own glyphs stay NARROW — the fix widens emoji, never the box rails", () => {
		// ✓ ✗ ⚠ ⏸ are Emoji_Presentation=No: text presentation, one column.
		// Widening these would break every card head in the suite.
		for (const glyph of ["✓", "✗", "⚠", "⏸", "▞", "▸", "─", "╭", "╰", "│", "└", "█", "▀", "▄"]) {
			expect(`${glyph} measures ${displayWidth(glyph)}`).toBe(`${glyph} measures 1`);
		}
		expect(displayWidth("中")).toBe(2); // the CJK ranges were never the hole
	});

	it("T-R2p-3: the source table and the reference agree on every glyph the renderer can emit", () => {
		const disagreements: string[] = [];
		const probe = (cp: number): void => {
			const ch = String.fromCodePoint(cp);
			if (displayWidth(ch) !== referenceWidth(cp)) disagreements.push(`U+${cp.toString(16).toUpperCase()}`);
		};
		for (let cp = 0x2000; cp <= 0x2bff; cp += 1) probe(cp);
		for (let cp = 0x1f000; cp <= 0x1faff; cp += 1) probe(cp);
		expect(disagreements.slice(0, 12)).toEqual([]);
	});

	it("T-R2p-4: a streaming turn NEVER paints over the composer box — the CJK+emoji storm", () => {
		// the owner's shape: a wide-glyph paragraph streaming while the
		// composer holds text. W=42 is where the paragraph's fold lands a
		// wide glyph on the boundary; the storm sweeps a band of widths.
		const failures: string[] = [];
		for (const H of [20, 24]) {
			for (let W = 40; W <= 64; W += 1) {
				const { body, screen } = screenBody(W, H, "继续审计");
				body.enter();
				let broke = "";
				outer: for (let turn = 0; turn < 3; turn += 1) {
					body.userLine(`第 ${turn + 1} 轮：请审计编译器前端`);
					body.render();
					for (let i = 0; i < EMOJI_PARA.length; i += 11) {
						body.textAppend(EMOJI_PARA.slice(i, i + 11));
						body.render();
						if (!dockIntact(screen, H)) {
							broke = `W=${W} H=${H} turn=${turn} at=${i}`;
							break outer;
						}
					}
					body.textEnd();
					body.endTurn(1.2);
					body.render();
				}
				if (broke !== "") failures.push(broke);
			}
		}
		expect(failures).toEqual([]);
	});
});
