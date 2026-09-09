/**
 * §2.3 — the thinking switch, at the compositor.
 *
 * ctrl+t folds the COMMITTED thinking blocks and folds them back. It is
 * DC-50's mechanism, not a second one: one boolean, then the session is
 * printed again, so the blocks already on screen obey the switch rather
 * than only the next ones.
 *
 * What must not move is the record. The switch is a rendering decision:
 * the events are untouched, and `/think` still reaches the last block
 * whole no matter which way the switch is thrown. That is the assertion
 * that matters here — a "hide" that quietly lost the text would be the
 * DC-19 family, and this is deliberately not that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { foldThinking, foldThinkingRow } from "../src/lines.js";

const THOUGHT =
	"Weighing the two shapes for this. The first keeps every character on the screen and pays for it in rows; the second is quieter and leaves nothing behind, which reads as a fault even when the log still holds it.";

function makeBody(W = 80) {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 24, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, take: (): string => writes.splice(0).join("") };
}

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("§2.3 — the thinking switch", () => {
	it("folds a committed block to one row, and back, while /think keeps the whole of it", () => {
		const { body, take } = makeBody();
		body.thinkingAppend(THOUGHT);
		body.thinkingEnd();
		body.textAppend("the answer is the first one.");
		vi.advanceTimersByTime(16);
		take();

		// FOLDED: one row, carrying the count and the way back
		body.toggleThinking();
		const folded = strip(take());
		expect(folded, "the fold names how to read the rest").toContain("/think");
		expect(folded, "and it is one row, not the paragraphs").not.toContain("leaves nothing behind");
		expect(folded, "the prose beside it is untouched").toContain("the answer is the first one.");

		// UNFOLDED: the words are back
		body.toggleThinking();
		expect(strip(take()), "the second press restores the block").toContain("leaves nothing behind");

		// and the record never moved, either way
		expect(body.lastThinking(), "/think still reaches the whole block").toBe(THOUGHT);
	});

	it("a block that SETTLES after the press is folded like the rest", () => {
		const { body, take } = makeBody();
		body.toggleThinking(); // thrown before anything has been thought
		take();
		body.thinkingAppend(THOUGHT);
		body.thinkingEnd();
		body.textAppend("done.");
		vi.advanceTimersByTime(16);
		const out = strip(take());
		expect(out, "the session stays one way up").toContain("/think");
		expect(out).not.toContain("leaves nothing behind");
	});

	it("the folded ROW is the pipe's fold, fitted — same shape, and it keeps its suffix", () => {
		// The pipe writes `foldThinking`: the leading …, 100 characters and
		// " (N chars · /think)". That is about 122 columns, so a row must
		// not be it verbatim — invariant ① — and cutting it from the right
		// would take the suffix, which is the one part that says how to
		// read the rest.
		const room = 60;
		const row = strip(foldThinkingRow(THOUGHT, room));
		expect(row.length, "the row fits").toBeLessThanOrEqual(room);
		expect(row, "the affordance survived the fit").toContain("/think");
		expect(row.startsWith("…"), "and the shape is the pipe's").toBe(true);

		// with unlimited room it IS the pipe's line, byte for byte — one
		// source for the shape, which is what keeps this from being a third
		// rendering of thinking
		expect(`${foldThinkingRow(THOUGHT, Number.POSITIVE_INFINITY)}\n`).toBe(foldThinking(THOUGHT));
	});
});
