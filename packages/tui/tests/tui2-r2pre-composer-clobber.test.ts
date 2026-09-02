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
import { APPLE_COLOR_EMOJI_2000_2BFF } from "./helpers/emoji-font.js";

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

/** The dock's own rows, by their glyphs — the rails are unmistakable.
 *  R2: both rails are the SAME dashed rule now, so "intact" is a rule at
 *  H−4 and a rule at H−2 with the input row between them, which is the
 *  property the corner glyphs used to stand in for. */
function dockIntact(screen: WideScreen, H: number): boolean {
	const rows = screen.visible();
	const rail = (r: string | undefined): boolean => r !== undefined && /^\u2500+$/.test(r);
	return rail(rows[H - 4]) && rail(rows[H - 2]);
}

const EMOJI_PARA =
	"✅ \u8bcd\u6cd5\u5206\u6790\u5668\u8d1f\u8d23\u628a\u6e90\u7801\u5207\u5206\u6210\u8bb0\u53f7\u6d41\uff0c\u8fd9\u4e00\u90e8\u5206\u7684\u5b9e\u73b0\u662f\u6e05\u6670\u7684\u3002" +
	"🚀 \u8bed\u6cd5\u5206\u6790\u5668\u518d\u628a\u8bb0\u53f7\u6d41\u89c4\u7ea6\u6210\u62bd\u8c61\u8bed\u6cd5\u6811\uff0c\u6027\u80fd\u4e0a\u6ca1\u6709\u660e\u663e\u95ee\u9898\u3002" +
	"❌ \u4f46\u662f\u9519\u8bef\u6062\u590d\u7684\u903b\u8f91\u5206\u6563\u5728\u82e5\u5e72\u4e2a\u4e0d\u540c\u7684\u4f4d\u7f6e\uff0c\u5bfc\u81f4\u540c\u4e00\u7c7b\u8bed\u6cd5\u9519\u8bef" +
	"\u5728\u4e0d\u540c\u7684\u4e0a\u4e0b\u6587\u91cc\u4f1a\u4ea7\u751f\u4e0d\u4e00\u6837\u7684\u8bca\u65ad\u4fe1\u606f\uff0c\u5efa\u8bae\u7edf\u4e00\u5230\u4e00\u4e2a\u6a21\u5757\u91cc\u3002";

/** The glyphs the renderer actually emits as chrome — one list, two
 *  gates: every one measures a single column (T-R2p-2), and none of
 *  them is a glyph Apple Color Emoji supplies (T-R2p-4). A new mark
 *  joins here or it is not measured at all. */
const CHROME_GLYPHS = ["✓", "✗", "❯", "✦", "✧", "✶", "✸", "✺", "●", "▸", "▖", "▣", "□", "→", "\u2500", "│", "└", "█", "▀", "▄"] as const;

/* The debt this gate shipped with is PAID. `\u26A0` was carried here for
 * one release as a declared exception (DC-42) because it is in Apple
 * Color Emoji too; the owner ruled it dropped rather than replaced —
 * §1.3, the words already say "deletes files permanently" — so the
 * filter below is unconditional and there is no exception list to grow
 * back into. */

describe("TUI2-R2pre ① — the width table is the composer's floor", () => {
	it("T-R2p-1: the emoji-presentation glyphs measure 2 — the table's hole is what lets a line overrun W", () => {
		// every one of these is Emoji_Presentation=Yes: a terminal draws it
		// in TWO columns, with no variation selector involved
		for (const glyph of ["✅", "❌", "🚀", "🀄", "🟠", "🫶", "⭐", "⬛"]) {
			expect(`${glyph} measures ${displayWidth(glyph)}`).toBe(`${glyph} measures 2`);
		}
	});

	it("T-R2p-2: the chrome's own glyphs stay NARROW — the fix widens emoji, never the box rails", () => {
		// ✓ ✗ ❯ are Emoji_Presentation=No: text presentation, one column.
		// Widening these would break every card head in the suite.
		// R2: the glyphs the renderer actually emits now — ✦ and the star
		// ramp joined (the fold mark and the thinking twinkle), ● joined
		// (the command breath), ✦ left.
		for (const glyph of CHROME_GLYPHS) {
			expect(`${glyph} measures ${displayWidth(glyph)}`).toBe(`${glyph} measures 1`);
		}
		expect(displayWidth("\u4e2d")).toBe(2); // the CJK ranges were never the hole
	});

	/**
	 * R9 Q4 — §6.1's OTHER half, which nothing enforced.
	 *
	 * T-R2p-2 above measures kiso's OWN table, and a glyph that table
	 * scores 1 can still be drawn in two columns by a terminal that
	 * resolves it to Apple Color Emoji. That is what §6.1 actually bans,
	 * and `\u23F8` sat inside the gate above for its whole life while
	 * breaking it — absent from Menlo AND present in the emoji font, both
	 * failure modes §6 names, in one glyph. design.md §10 wrote it down;
	 * no gate ever asked. Retiring it for `❯` closes the instance. This
	 * closes the class.
	 */
	it("T-R2p-4: no chrome glyph is one Apple Color Emoji supplies (design §6.1)", () => {
		const offenders = CHROME_GLYPHS.filter((g) => APPLE_COLOR_EMOJI_2000_2BFF.has(g.codePointAt(0)!));
		expect(offenders).toEqual([]);
	});

	it("T-R2p-4b: the gate DISCRIMINATES — the glyphs §6 names are all caught by it", () => {
		// ✳ and ✴ are §6.1's two named bans; \u23F8 is the one R9 Q4
		// retired. A gate that cannot fail on these is not a gate.
		for (const cp of [0x2733, 0x2734, 0x23f8]) {
			expect(`U+${cp.toString(16)} in the emoji font: ${APPLE_COLOR_EMOJI_2000_2BFF.has(cp)}`).toBe(`U+${cp.toString(16)} in the emoji font: true`);
		}
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
				const { body, screen } = screenBody(W, H, "\u7ee7\u7eed\u5ba1\u8ba1");
				body.enter();
				let broke = "";
				outer: for (let turn = 0; turn < 3; turn += 1) {
					body.userLine(`\u7b2c ${turn + 1} \u8f6e\uff1a\u8bf7\u5ba1\u8ba1\u7f16\u8bd1\u5668\u524d\u7aef`);
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
