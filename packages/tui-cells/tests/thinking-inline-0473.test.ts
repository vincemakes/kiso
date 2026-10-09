/**
 * 0.47.3 — thinking draws its paragraphs' inline markdown (design.md §7.2).
 *
 * A reasoning summary (the Responses API's, asked for with an effort)
 * opens on a `**title**`; drawn as plain grey italic its asterisks were
 * noise on the owner's screen. The thinking block now passes each
 * paragraph through `inlineSpans`, with its own grey italic as the style
 * every span closes back to. Blocks are untouched: a paragraph is still
 * one folded run.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cellComponent, foldWords, type BodyCell, type FrameCtx } from "../src/components.js";
import { palette, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	delete process.env.NO_COLOR;
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
const strip = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const thought = (text: string, W = 60, done = true): string[] =>
	cellComponent({ kind: "thinking", text, done } as unknown as BodyCell).render(W, CTX);

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
const WORDS = ["the", "model", "reads", "a", "config", "**Reading", "file**", "`npm test`", "*maybe*", "**", "*", "`", "[docs](https://x.y/z)", "2*3*4", "\u538b\u7f29", "supercalifragilisticexpialidocious"];
function prose(r: () => number, n: number): string {
	let s = "";
	while (s.length < n) s += WORDS[Math.floor(r() * WORDS.length)]! + " ";
	return s.trim();
}

for (const g of ["light", "dark"] as const) {
	describe(`0.47.3 — inline markdown inside thinking (${g} ground)`, () => {
		it("a summary's **title** is bold, without its asterisks, inside the grey italic", () => {
			setGround(g);
			const p = palette();
			const rows = thought("**Reading configuration file**");
			expect(rows.map(strip)).toEqual(["  Reading configuration file"]);
			expect(rows[0]).toContain(`${p.bold}Reading configuration file`);
			// the row opens in the thinking's own look and the bold closes back to it
			expect(rows[0]).toContain(`${p.dim}${p.italic}${p.bold}`);
		});

		it("text after a bold span is grey italic again, and an inner *italic* never ends the paragraph's italic", () => {
			setGround(g);
			const p = palette();
			const row = thought("**Plan** then *maybe* check the cache")[0]!;
			expect(strip(row)).toBe("  Plan then maybe check the cache");
			expect(row).toContain(`${p.reset}${p.dim}${p.italic} then `);
			// one SGR 23, the row's own close: none mid-row
			expect(row.split(p.italicEnd).length - 1).toBe(1);
			expect(row.endsWith(`${p.italicEnd}${p.reset}`)).toBe(true);
		});

		it("a code span and a link read as the answer's do; the markers go", () => {
			setGround(g);
			expect(strip(thought("run `npm test` per [the docs](https://x.y/z)")[0]!)).toBe("  run npm test per the docs (https://x.y/z)");
		});

		it("a half-streamed marker stays literal until its closer lands", () => {
			setGround(g);
			expect(strip(thought("**Reading confi", 60, false)[0]!)).toMatch(/^[✧✦✶✸✺] \*\*Reading confi$/);
			expect(strip(thought("**Reading config**", 60, false)[0]!)).toMatch(/^[✧✦✶✸✺] Reading config$/);
		});

		it("text with no markers draws byte for byte as before", () => {
			setGround(g);
			const p = palette();
			const r = rng(473);
			for (let k = 0; k < 200; k += 1) {
				let s = "";
				while (s.length < 1 + Math.floor(r() * 400)) s += ["alpha", "bravo", "charlie-delta", "\u538b\u7f29\u4e4b\u540e", "x"][Math.floor(r() * 5)]! + " ";
				const W = 8 + Math.floor(r() * 100);
				const room = Math.max(1, W - 4); // proseRoom: the edge on both sides
				const before = foldWords(s.trim(), room).map((line) => `  ${p.dim}${p.italic}${line}${p.italicEnd}${p.reset}`);
				expect(thought(s, W), `case ${k} W=${W}`).toEqual(before);
			}
		});

		it("every row fits: 300 seeded paragraphs full of markers, W 10..120", () => {
			setGround(g);
			const r = rng(20261008);
			for (let k = 0; k < 300; k += 1) {
				const W = 10 + Math.floor(r() * 111);
				for (const row of thought(prose(r, 1 + Math.floor(r() * 500)), W)) expect(visibleWidth(row), `case ${k} W=${W}`).toBeLessThanOrEqual(W);
			}
		});
	});
}

describe("0.47.3 — thinking's inline markdown, colour off and at length", () => {
	it("colour off: the plain word `thinking:` still opens it, and the markers still go", () => {
		process.env.NO_COLOR = "1";
		expect(thought("**Reading configuration file**")).toEqual(["  thinking: Reading configuration file"]);
	});

	it("a 40,000-character block full of markers draws in well under a frame budget", () => {
		setGround("dark");
		const text = prose(rng(7), 40_000);
		thought(text, 96);
		const t0 = performance.now();
		const rows = thought(text, 96);
		const ms = performance.now() - t0;
		expect(rows.length).toBeGreaterThan(300);
		// the bound leaves room for a loaded box; the thinking-freeze bug was 61 ms
		expect(ms).toBeLessThan(60);
	});
});
