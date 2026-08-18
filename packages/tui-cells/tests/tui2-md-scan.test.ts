/**
 * TUI2-MD slice ① — the block scanner IS the streaming state machine,
 * and the FREEZE PROPERTY is what it exists to guarantee.
 *
 * The round's central discipline: a markdown block that has CLOSED
 * commits to scrollback and is never re-rendered; only the unclosed
 * TAIL block lives in the live region. kiso's committed bytes are never
 * re-emitted (ADR-0046), so "never re-rendered" is not a nicety here —
 * a block whose rendering could still change after it committed would
 * put a lie in the user's terminal history.
 *
 * The property, stated so a test can hold it: for ANY way the same text
 * is split into deltas, the sequence of CLOSED blocks — and the lines
 * each of them renders at a given width — is byte-identical to the
 * one-shot scan of the whole text. The scanner earns this by deciding
 * block boundaries ONLY on COMPLETE lines: a trailing partial line can
 * never close anything, so no arriving byte can reach backwards.
 */

import { describe, expect, it } from "vitest";
import { MdStream, renderBlock, renderMarkdown, type MdBlock } from "../src/md.js";
import { MD_BENCHMARK } from "./helpers/md-benchmark.js";

/** Feed `text` through the scanner in chunks of `n` characters. */
function fed(text: string, n: number): MdStream {
	const s = new MdStream();
	for (let i = 0; i < text.length; i += n) s.push(text.slice(i, i + n));
	return s;
}

/** A block's identity for byte comparison — kind + source, never a
 *  rendered form (the render is compared separately, per width). */
function ident(b: MdBlock): string {
	return `${b.kind}|${b.gap ? "gap" : "tight"}|${b.lang}|${JSON.stringify(b.lines)}`;
}

const RAGGED = [1, 2, 3, 5, 7, 9, 13, 29, 64, 257];

describe("TUI2-MD ① — the block scanner", () => {
	it("T-MD-1: the FREEZE PROPERTY — every delta split yields the same closed blocks as the one-shot scan", () => {
		const oneShot = new MdStream();
		oneShot.push(MD_BENCHMARK);
		oneShot.end();
		const want = oneShot.blocks().map(ident);
		const offenders: string[] = [];
		for (const n of RAGGED) {
			const s = fed(MD_BENCHMARK, n);
			s.end();
			const got = s.blocks().map(ident);
			if (JSON.stringify(got) !== JSON.stringify(want)) offenders.push(`chunk=${n}`);
		}
		expect(offenders).toEqual([]);
		// and the scan is not trivially empty
		expect(want.length).toBeGreaterThan(8);
	});

	it("T-MD-2: a CLOSED block's rendered lines never change as more text arrives", () => {
		// snapshot each block's render at the exact moment it closes, then
		// again after the whole message has streamed in — byte-equal.
		const offenders: string[] = [];
		for (const W of [40, 60, 80, 100]) {
			for (const n of [1, 7, 64]) {
				const s = new MdStream();
				const atClose = new Map<number, string>();
				for (let i = 0; i < MD_BENCHMARK.length; i += n) {
					s.push(MD_BENCHMARK.slice(i, i + n));
					const blocks = s.blocks();
					for (let b = 0; b < s.closed(); b += 1) {
						if (!atClose.has(b)) atClose.set(b, JSON.stringify(renderBlock(blocks[b]!, W)));
					}
				}
				s.end();
				const final = s.blocks();
				for (const [b, frozen] of atClose) {
					const now = JSON.stringify(renderBlock(final[b]!, W));
					if (now !== frozen) offenders.push(`W=${W} chunk=${n} block=${b}`);
				}
				if (atClose.size === 0) offenders.push(`W=${W} chunk=${n}: nothing ever closed`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("T-MD-3: closed blocks + tail reassemble the one-shot render exactly", () => {
		for (const W of [60, 80]) {
			const want = renderMarkdown(MD_BENCHMARK, W);
			const s = fed(MD_BENCHMARK, 11);
			s.end();
			const got = s.blocks().flatMap((b) => renderBlock(b, W));
			expect(got).toEqual(want);
		}
	});

	it("T-MD-4: an unclosed ** renders LITERAL in the tail and flips only when it closes", () => {
		const s = new MdStream();
		s.push("before **bold not closed yet");
		const open = s.blocks();
		expect(s.closed()).toBe(0);
		expect(open).toHaveLength(1);
		// the tail carries the raw asterisks — nothing has been styled
		expect(renderBlock(open[0]!, 80).join("")).toContain("**bold not closed yet");
		// the close flips it — and the flip happens inside the SAME (still
		// open) block, which is the live region's occupant
		s.push("**");
		const flipped = renderBlock(s.blocks()[0]!, 80).join("");
		expect(flipped).not.toContain("**bold");
		expect(s.closed()).toBe(0);
	});

	it("T-MD-5: an open fence renders eagerly with the gutter, and its body lines close one at a time", () => {
		const s = new MdStream();
		s.push("```ts\n");
		expect(s.closed()).toBe(1); // the opener row is final the moment its line is
		expect(s.blocks()[0]!.kind).toBe("fence-open");
		expect(s.blocks()[0]!.lang).toBe("ts");
		s.push("const a = 1;\n");
		expect(s.closed()).toBe(2); // a fence body line is line-local — it can never change
		expect(s.blocks()[1]!.kind).toBe("fence-line");
		s.push("const b = ");
		// the partial line renders NOW, with the gutter, without closing
		expect(s.closed()).toBe(2);
		const tail = s.blocks()[2]!;
		expect(tail.kind).toBe("fence-line");
		expect(renderBlock(tail, 80).join("")).toContain("const b = ");
		s.push("2;\n```\n");
		expect(s.closed()).toBe(3); // the closing fence itself emits no block
		expect(s.blocks()).toHaveLength(3);
	});

	it("T-MD-6: a streaming table re-layouts ONLY inside the tail", () => {
		const s = new MdStream();
		s.push("intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
		const closedNow = s.closed();
		const before = s.blocks().slice(0, closedNow).map((b) => JSON.stringify(renderBlock(b, 60)));
		// a much wider cell arrives — the table's columns must re-measure,
		// and nothing already closed may move
		s.push("| a very much longer cell | 4 |\n");
		const after = s.blocks().slice(0, closedNow).map((b) => JSON.stringify(renderBlock(b, 60)));
		expect(after).toEqual(before);
		// the table is still the tail (nothing closed it)
		expect(s.blocks()[s.blocks().length - 1]!.kind).toBe("table");
		expect(s.closed()).toBe(closedNow);
	});

	it("T-MD-7: the benchmark case scans to the construct sequence the round renders", () => {
		const s = new MdStream();
		s.push(MD_BENCHMARK);
		s.end();
		expect(s.blocks().map((b) => b.kind)).toEqual([
			"para",
			"heading",
			"list",
			"heading",
			"para",
			"heading",
			"para",
			"table",
			"para",
		]);
		// exactly one blank row between top-level blocks: the first block
		// opens tight, every later one carries its own gap
		expect(s.blocks().map((b) => b.gap)).toEqual([false, true, true, true, true, true, true, true, true]);
	});

	it("T-MD-8: the tail never closes a block on a partial line", () => {
		// "#" could still become "#hashtag" (a paragraph) rather than a
		// heading — a decision taken on an incomplete line is a decision
		// that can be wrong, and a wrong decision here is a wrong commit.
		const s = new MdStream();
		s.push("a paragraph\n");
		expect(s.closed()).toBe(0);
		s.push("#");
		expect(s.closed()).toBe(0);
		s.push("hashtag\n");
		expect(s.closed()).toBe(0);
		expect(s.blocks()[0]!.lines).toEqual(["a paragraph", "#hashtag"]);
	});
});
