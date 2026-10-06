/**
 * 0.40.0 (the owner's dogfood) — a coloured tool output reaches the card
 * without its styling, and without the remnants of it.
 *
 * escapeTerminal drops the ESC byte alone, so a test run's colours reached
 * the shell card as `[31m─── [1m[41m Failed Tests 2 [49m`. The output body
 * now drops each whole sequence first. A NAME keeps the old escape: there
 * the `[31m` remnant is what shows an injection (strings.test.ts pins it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeTerminal, stripAnsi } from "@vincemakes/kiso-tui-cells/render";
import { Body } from "../src/compositor.js";

const E = "\x1b";
/** The REAL clock, taken before the fake timers replace it — a timing gate
 *  read through faked time measures nothing. */
const realNow = performance.now.bind(performance);
/** What a coloured vitest run prints, as the owner's card received it. */
const VITEST = [
	`${E}[31m────────${E}[39m${E}[1m${E}[41m Failed Tests 2 ${E}[49m${E}[22m${E}[31m────────${E}[39m`,
	`${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m2 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m13 passed${E}[39m${E}[22m${E}[90m (15)${E}[39m`,
].join("\n");

/** The expanded card's render of `rows` rows, each 1,700 unterminated
 *  `ESC P` and a label (~3,400 chars a row), on the real clock: the result
 *  arrives, then ctrl+o draws the WHOLE output through blockRows. */
function renderExpanded(rows: number): number {
	const hostile = Array.from({ length: rows }, (_, i) => `${`${E}P`.repeat(1_700)}row ${i}`).join("\n");
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 24, width: () => 100, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	body.toolStart("shell", "c1", { command: "cat hostile" });
	body.toolRunning("c1");
	const started = realNow();
	body.toolResult("c1", { content: hostile, isError: false });
	vi.advanceTimersByTime(16);
	body.toggleExpanded();
	vi.advanceTimersByTime(16);
	const elapsed = realNow() - started;
	const frame = writes.join("");
	// the expanded card was drawn, with the WHOLE output
	if (!frame.includes("ctrl+o collapses") || !frame.includes("row 0") || !frame.includes(`row ${rows - 1}`)) throw new Error(`the expanded card of ${rows} rows was not drawn whole`);
	return elapsed;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("tool output without its terminal styling", () => {
	it("every kind of sequence goes whole: colours, titles, links, charset, 8-bit CSI", () => {
		expect(stripAnsi(VITEST)).toBe(["──────── Failed Tests 2 ────────", "      Tests  2 failed | 13 passed (15)"].join("\n"));
		expect(stripAnsi(`a${E}]0;title\x07b${E}]8;;https://x${E}\\link${E}]8;;${E}\\c`)).toBe("ablinkc");
		expect(stripAnsi(`${E}(B${E}[mdone \x9b31mred`)).toBe("done red");
		expect(stripAnsi(`a${E}Pq#0;1;2${E}\\b${E}_apc body${E}\\c`)).toBe("abc"); // DCS and APC strings, terminated
		expect(stripAnsi("plain [31m text")).toBe("plain [31m text"); // no ESC, nothing to strip
	});

	it("the shell card shows the words and none of the remnants", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => 100, editCol: () => 1, write: (s) => writes.push(s) });
		body.enter();
		body.toolStart("shell", "c1", { command: "npx vitest run" });
		body.toolRunning("c1");
		body.toolResult("c1", { content: VITEST, isError: false });
		vi.advanceTimersByTime(16);
		const frame = writes.join("");
		expect(frame).toContain("Failed Tests 2");
		expect(frame).toContain("2 failed | 13 passed (15)");
		for (const remnant of ["[31m", "[41m", "[39m", "[22m", "[90m"]) expect(frame).not.toContain(remnant);
	});

	it("hostile output stays linear: four times the unterminated ESC P costs about four times as much, not sixteen", () => {
		// the lead's review: a string-body branch that scanned lazily to the
		// end of the text for its terminator made every unterminated `ESC P`
		// an O(n) scan — n²/2 steps on the render path, synchronously (the
		// DC-54 shape: a missing bound, not a sync/async question).
		//
		// The gate compares the render at n and at 4n rather than holding it
		// under a fixed number of milliseconds: a linear render costs about 4×
		// (less, with the card's fixed cost), the quadratic one 16×. An
		// absolute 50 ms budget went red at 72 ms on a loaded machine (a full
		// check's unit pool on every core, load 21) while the render was
		// linear; load slows both sizes alike, so the ratio does not move
		// with it. Each size is the fastest of five, so one stall cannot
		// decide the gate.
		const RUNS = 5;
		const fastest = (rows: number): number => {
			let best = Number.POSITIVE_INFINITY;
			for (let run = 0; run < RUNS; run += 1) best = Math.min(best, renderExpanded(rows));
			return best;
		};
		const small = fastest(8); // ~27,000 chars
		const large = fastest(32); // ~109,000 chars
		expect(large / small, `${Math.round(small)} ms at n, ${Math.round(large)} ms at 4n`).toBeLessThan(8);
		// a backstop on the absolute cost, wide enough for any load the ratio
		// tolerates: the quadratic render took 817 ms at ~100,000 chars on an
		// idle machine, the linear one a few
		expect(large, `${Math.round(large)} ms at ~109,000 chars`).toBeLessThan(400);
	});

	it("a NAME keeps the visible remnant — stripping it would let an injected name pass as another", () => {
		expect(escapeTerminal(`sh${E}[31mell`)).toBe("sh[31mell");
	});
});
