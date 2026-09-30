/**
 * The thinking-freeze fix (2026-09-30): foldWords walks a paragraph ONCE.
 *
 * The owner saw the working twinkle freeze while the model thought. The
 * thinking block is one flattened paragraph re-folded every frame, and
 * foldWords re-measured and rebuilt the paragraph's remainder for every
 * row — O(n²/W): 61 ms a render at 40k characters. The fix reads through a
 * cursor; the rows must be byte for byte what they were, so the pre-fix
 * function is kept here as the oracle and compared on seeded random text.
 */

import { describe, expect, it } from "vitest";
import { foldLine, foldWords } from "../src/components.js";
import { visibleWidth, widthCut } from "../src/width.js";

/** The pre-fix foldWords and its helper, verbatim — the oracle. */
function spansOpenAfterRef(text: string, before: readonly string[]): string[] {
	let open = [...before];
	for (const m of text.matchAll(/\x1b\[[0-9;]*m/g)) {
		if (m[0] === "\x1b[0m") open = [];
		else open.push(m[0]);
	}
	return open;
}
function foldWordsRef(line: string, W: number): string[] {
	if (W < 1) return [line];
	const out: string[] = [];
	for (const para of line.split("\n")) {
		if (visibleWidth(para) <= W) {
			out.push(para);
			continue;
		}
		let rest = para;
		let open: string[] = [];
		while (visibleWidth(rest) > W) {
			const head = widthCut(rest, W);
			const at = head.lastIndexOf(" ");
			if (at <= 0) break;
			const cut = head.slice(0, at);
			out.push(`${cut}${open.length > 0 || /\x1b\[[0-9;]*m/.test(cut) ? "\x1b[0m" : ""}`);
			open = spansOpenAfterRef(cut, open);
			rest = `${open.join("")}${rest.slice(cut.length + 1)}`;
		}
		out.push(...foldLine(rest, W));
	}
	return out.length > 0 ? out : [""];
}

/** mulberry32 — a seeded generator, so a red case replays */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const PIECES = [
	"the", "model", "weighs", "whether", "a", "cache", "prefix", "survives",
	"supercalifragilisticexpialidocious-and-then-some-more-letters",
	"\u538b\u7f29\u4e4b\u540e", "\u7f13\u5b58\u547d\u4e2d\u7387", "\ud83d\ude80", "e\u0301",
	"\x1b[1mbold\x1b[0m", "\x1b[2mdim words\x1b[0m", "\x1b[38;2;36;86;181mblue\x1b[39m", "\x1b[3mitalic", "\x1b[23m",
	"  ", "\n", "x",
];
function text(r: () => number, n: number): string {
	let s = "";
	while (s.length < n) s += PIECES[Math.floor(r() * PIECES.length)]! + (r() < 0.8 ? " " : "");
	return s;
}

describe("foldWords is linear and unchanged", () => {
	it("the rows are byte for byte the pre-fix rows: 3,000 seeded texts, W 1..120", () => {
		const r = rng(20260930);
		for (let k = 0; k < 3000; k += 1) {
			const s = text(r, 1 + Math.floor(r() * 600));
			const W = 1 + Math.floor(r() * 120);
			expect(foldWords(s, W), `case ${k} W=${W} ${JSON.stringify(s)}`).toEqual(foldWordsRef(s, W));
		}
	});

	it("one long paragraph folds in linear time: 200k characters well under the budget the old fold needed for 40k", () => {
		const r = rng(7);
		const para = text(r, 200_000).replace(/\n/g, " ");
		const t0 = performance.now();
		const rows = foldWords(para, 96);
		const ms = performance.now() - t0;
		expect(rows.length).toBeGreaterThan(1000);
		// the pre-fix fold took ~60 ms at 40k and grows with n²; 200k would be
		// seconds. Linear is a few ms — the bound leaves room for a loaded box.
		expect(ms).toBeLessThan(400);
	});
});
