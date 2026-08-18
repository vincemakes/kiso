/**
 * TUI2-MD slice ③ — wrap-with-hang and the CJK BREAK CLASS.
 *
 * THE CRASH CASE, stated exactly. The recon's finding is that a
 * whitespace-only wrapper meets a space-free CJK run and cannot place
 * it: the run is one unbreakable "word", so the wrapper either
 * overflows (tripping the compositor's width invariant, which THROWS)
 * or gives up on word-wrapping entirely and hard-folds. kiso is the
 * second kind — `foldWords` falls back to `foldLine` — so the failure
 * here is not a throw but three measurable ones, each pinned below:
 *
 *   ① COLUMN WASTE — the CJK run is atomic, so a row breaks before it
 *     and leaves most of the width empty (T-MD-19).
 *   ② MID-WORD CHOPPING — once a spaceless head appears, the REST of
 *     the paragraph hard-folds, cutting Latin words that would have
 *     fit on a fresh row, and stranding the break's space at the start
 *     of the next row (T-MD-20).
 *   ③ SPLIT SURROGATE PAIRS — the fold steps by UTF-16 code UNIT, so
 *     an astral CJK character (ext-B and up) is cut in half. Both
 *     halves measure one column while the terminal draws two
 *     replacement glyphs: the exact width lie the R2pre table exists
 *     to prevent, written into permanent scrollback (T-MD-21).
 *
 * All three fail on the tree as it stands. The fix treats every CJK
 * code point as individually breakable — sharing the width authority's
 * own ranges, never a second table — carries SGR state across the
 * break, and steps by code point.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "../src/components.js";
import { mdWrap, renderMarkdown } from "../src/md.js";
import { palette } from "../src/render.js";
import { breakable, charWidth } from "../src/width.js";
import { MD_BENCHMARK } from "./helpers/md-benchmark.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** A run of distinct CJK unified ideographs — no spaces anywhere. */
function cjk(n: number, from = 0x4e00): string {
	return Array.from({ length: n }, (_, i) => String.fromCodePoint(from + i)).join("");
}

function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TUI2-MD ③ — wrap with hang, and the CJK break class", () => {
	it("T-MD-18: mdWrap never exceeds W, at any width, hang or content", () => {
		const p = palette();
		const bodies = [cjk(40), `${cjk(20)} and some english words`, `abc ${cjk(10)} def`, `${p.bold}${cjk(30)}${p.reset}`, "supercalifragilisticexpialidocious"];
		const leads = ["", "  • ", "      1. ", "▏ "];
		const offenders: string[] = [];
		for (const body of bodies) {
			for (const lead of leads) {
				const hang = " ".repeat(visibleWidth(lead));
				for (let W = 6; W <= 40; W += 1) {
					for (const row of mdWrap(body, W, lead, hang)) {
						if (visibleWidth(row) > W) offenders.push(`W=${W} lead=${JSON.stringify(lead)} row=${JSON.stringify(row)}`);
					}
				}
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("T-MD-19: ① a CJK run FILLS the row — the break class is the difference", () => {
		// "abc" plus a space-free CJK run: a whitespace-only wrapper strands
		// "abc" alone on a 16-column row and starts the run on the next.
		expect(renderMarkdown(`abc ${cjk(10)} def ghi`, 16).map(plain)).toEqual([
			`abc ${cjk(6)}`,
			`${cjk(4, 0x4e06)} def ghi`,
		]);
	});

	it("T-MD-20: ② a CJK run does not poison the rest of the paragraph", () => {
		// after the run, word wrapping must still apply: no Latin word is cut,
		// and no row begins with the break's stranded space.
		const rows = renderMarkdown(`${cjk(12)} alpha beta gamma delta epsilon`, 20).map(plain);
		expect(rows.some((r) => r.startsWith(" "))).toBe(false);
		expect(rows.join("|")).toContain("gamma");
		for (const word of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
			expect(rows.filter((r) => r.includes(word))).toHaveLength(1);
		}
	});

	it("T-MD-21: ③ a surrogate pair is never split", () => {
		// CJK ext-B: real characters, two UTF-16 code units each
		const offenders: string[] = [];
		for (const W of [7, 9, 11, 13, 15, 21]) {
			for (const row of renderMarkdown(`x ${cjk(10, 0x20000)}`, W).map(plain)) {
				if (/[\ud800-\udbff]$/.test(row) || /^[\udc00-\udfff]/.test(row)) offenders.push(`W=${W}: ${JSON.stringify(row)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("T-MD-22: SGR state crosses the break — every row closes, the next reopens", () => {
		const p = palette();
		const rows = mdWrap(`${p.bold}${cjk(30)}${p.reset}`, 14, "  • ", "    ");
		expect(rows.length).toBeGreaterThan(2);
		for (const row of rows) {
			// nothing leaks past a row end...
			expect(row.endsWith(p.reset)).toBe(true);
			// ...and the style is present on every row, not just the first
			expect(row).toContain(p.bold);
		}
		// italic closes with its own 23 and reopens, never stranding a base
		const ital = mdWrap(`${p.italic}${cjk(20)}${p.italicEnd}`, 12, "", "");
		expect(ital.every((r) => r.includes(p.italic))).toBe(true);
	});

	it("T-MD-23: nothing is lost and nothing is duplicated", () => {
		const offenders: string[] = [];
		for (const body of [cjk(31), `${cjk(9)} tail words here`, "one two three four five six", `${cjk(5)}\uff0c${cjk(5)}\u3002`]) {
			for (let W = 8; W <= 30; W += 1) {
				const joined = mdWrap(body, W, "  • ", "    ")
					.map((r) => plain(r).replace(/^ +/, ""))
					.join(" ")
					.replace(/[• ]/g, "");
				if (joined !== body.replace(/ /g, "")) offenders.push(`W=${W} ${JSON.stringify(body.slice(0, 8))}`);
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("T-MD-24: the HANGING INDENT — a wrapped item aligns to its text column", () => {
		const rows = renderMarkdown(`- ${cjk(30)}`, 20).map(plain);
		expect(rows[0]!.startsWith("  • ")).toBe(true);
		for (const row of rows.slice(1)) expect(row.startsWith("    ")).toBe(true);
		// a nested item indents two more, and its hang follows it
		const nested = renderMarkdown(`  - ${cjk(30)}`, 20).map(plain);
		expect(nested[0]!.startsWith("    • ")).toBe(true);
		for (const row of nested.slice(1)) expect(row.startsWith("      ")).toBe(true);
	});

	it("T-MD-25: the acceptance content holds the width invariant at every width", () => {
		// invariant ① is a THROW in the compositor — a row wider than W is a
		// crash, not a cosmetic defect. The whole CJK-heavy benchmark case,
		// every construct, from a narrow terminal upward.
		const offenders: string[] = [];
		for (let W = 20; W <= 120; W += 1) {
			for (const row of renderMarkdown(MD_BENCHMARK, W)) {
				if (visibleWidth(row) > W) offenders.push(`W=${W} w=${visibleWidth(row)} ${JSON.stringify(row.slice(0, 50))}`);
			}
		}
		expect(offenders.slice(0, 5)).toEqual([]);
	});

	it("T-MD-26: the break class EXTENDS the width table — one table, two questions", () => {
		// every breakable code point is one the width authority already knows
		// as wide; the class is a view of that table, not a second copy.
		for (const cp of [0x4e00, 0x9fff, 0x3042, 0xac00, 0xff0c, 0x20000]) {
			expect(breakable(cp)).toBe(true);
			expect(charWidth(cp)).toBe(2);
		}
		// Latin, and the chrome glyphs, are not breakable
		for (const cp of [0x61, 0x2f, 0x2502, 0x2713, 0x2022]) expect(breakable(cp)).toBe(false);
		// an emoji is wide but NOT breakable — a sequence must stay whole
		expect(charWidth(0x1f600)).toBe(2);
		expect(breakable(0x1f600)).toBe(false);
	});

	it("T-MD-27: a row never OPENS with CJK closing punctuation", () => {
		// a line that begins with a comma or a full stop reads as broken; the
		// break class carries the smallest honest kinsoku rule with it.
		const body = Array.from({ length: 20 }, (_, i) => `${cjk(3, 0x4e00 + i * 3)}\uff0c`).join("");
		for (let W = 10; W <= 40; W += 1) {
			for (const row of mdWrap(body, W, "", "").map(plain)) {
				expect("\u3001\u3002\uff0c\uff1a\uff1b\uff1f\uff01").not.toContain(row.slice(0, 1));
			}
		}
	});
});
