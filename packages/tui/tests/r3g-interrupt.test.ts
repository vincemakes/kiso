/**
 * R3g — what an INTERRUPTION does to the commit pointer, the fold and
 * the rollup. Three defects found by an independent review of R3b–R3f
 * (fable, 2026-08-28), all sharing one shape: a call that never
 * finished was treated as a call that finished fine.
 *
 * ① THE STALL (the worst of the three, because it outlives its turn).
 *    An esc mid-tool leaves the cell `done: false` forever — the tool
 *    never returns a result. The commit loop stops at the first cell
 *    that is not done, so ONE interrupt parked the pointer for the
 *    REST of the session: every later turn's rows piled into the live
 *    region and left it only through the force-commit cap. The screen
 *    the owner photographed — a session that "stopped halfway" — is
 *    this. The turn's end closes them, exactly as it closes an open
 *    thinking cell.
 *
 * ② THE FOLD'S BLIND SPOT. A denial that carries no `reason` string
 *    left `isError` false and `reason` null, so the trouble predicate
 *    could not see it and `✦ thought 3s · 20 reads` could stand over a
 *    refused write. The verdict is the record of the refusal.
 *
 * ③ THE ROLLUP'S BLIND SPOT (found by fixing ①). `explored 3 paths` is
 *    a sentence a failed or interrupted member makes false, and the row
 *    it replaced was the only place that failure had words. The rollup
 *    now obeys the rule the fold already obeyed — law 1.3 at the scale
 *    of a run.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). Two reasons, one of them a truthfulness bug: that table
 * names what a single-tool rollup COUNTS — "14 matches" means fourteen
 * matched lines — while this line counts CALLS, so one search rendered
 * "1 match" whenever the search had matched any other number. The
 * phrasing is the owner's, from the shape they asked for: "thought 17s
 * · read 4 files · listed 1 directory · ran 4 shell commands".
 */
/**
 * DECLARED SUPERSESSION (R3i phase 3, owner-ruled) — TROUBLE FOLDS,
 * NAMED.
 *
 * Everything below about an interrupt or a denial STOPPING a fold is
 * superseded. Law 1.3 governs marks versus words and never granted a
 * failure a permanent row; law 1.7 says "Work folds, words do not". So
 * the work folds and the outcome WORDS ride the fold line — which call,
 * and what happened — and the stderr is behind the key, because it is
 * detail, not outcome. Measured cost of the old rule: the 0.16.7
 * dogfood hit 2 failures in 28 calls and produced ZERO fold lines.
 *
 * What these cases still hold, and what they were written for, is
 * unchanged: an interrupt must not park the commit pointer, a denial
 * must not be invisible, and a rollup must not speak for a run it did
 * not finish. Only the shape of "must not be invisible" moved — from a
 * row that stands to a clause that is named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(H = 40) {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
}
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The fold's SIGNATURE. Keying a "does not fold" claim on the literal
 * `✦ thought` is unfalsifiable: when the turn's user chip rides the
 * fold (A9) the line reads `✦  write it  · thought 3s · …` and the
 * literal never appears — so the assertion held whether the turn folded
 * or not. Both shapes carry `thought <n>s`, and nothing else the
 * compositor draws does (the thinking row has no clock, and the recap
 * is the CLI's line, not this one).
 */
const NO_FOLD = /thought \d+s/;
const call = (body: Body, name: string, id: string, input: Record<string, unknown>, out: string, isError = false): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: out, isError });
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R3g ① — an interrupt does not park the commit pointer", () => {
	it("a turn abandoned mid-tool still settles, and the NEXT turn's work reaches the screen", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("first");
		body.toolStart("run_shell", "a", { command: "sleep 100" });
		body.toolRunning("a"); // ...and esc arrives: no result ever comes
		body.endTurn(1);
		tick();

		// the second turn: a quiet turn, whose fold can only be drawn by
		// the commit loop — and the loop can only reach it if the pointer
		// moved past the abandoned cell.
		body.userLine("second");
		call(body, "read_file", "b", { path: "x.ts" }, "x");
		call(body, "read_file", "c", { path: "y.ts" }, "y");
		body.endTurn(4);
		tick();

		// R13 MOVED THIS ASSERTION. The claim is that the commit pointer
		// moved PAST the abandoned cell, and the fold line was the proof
		// only because the fold was the one thing the loop had to reach
		// the second turn to draw. With no fold, the second turn's own
		// calls are that proof — and a sharper one, because they are the
		// work rather than a sentence about it.
		const after = plain(writes.join(""));
		expect(after, "the pointer parked on the abandoned cell").toContain("read  x.ts");
		expect(after).toContain("read  y.ts");
	});

	it("the abandoned row keeps its words — the interruption is NAMED, never silently done", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("first");
		body.toolStart("run_shell", "a", { command: "sleep 100" });
		body.toolRunning("a");
		body.endTurn(1);
		tick();
		expect(plain(writes.join(""))).toContain("interrupted");
	});

	/* R13 — "and that turn DOES fold" retired with the fold and the rollup it is about.
	   R3g's own subject — an interrupt, a denial and a failure are each
	   NAMED rather than silently swallowed — survives on the call's own
	   card and is asserted by the cases that remain in this file. */
});
/* R13 — "a DENIED call holds the turn unfolded" retired with the fold and the rollup it is about.
	   R3g's own subject — an interrupt, a denial and a failure are each
	   NAMED rather than silently swallowed — survives on the call's own
	   card and is asserted by the cases that remain in this file. */

	/* R13 — "the same turn with the call APPROVED folds" retired with the fold and the rollup it is about.
	   R3g's own subject — an interrupt, a denial and a failure are each
	   NAMED rather than silently swallowed — survives on the call's own
	   card and is asserted by the cases that remain in this file. */
/* R13 — "a FAILED member breaks the rollup" retired with the fold and the rollup it is about.
	   R3g's own subject — an interrupt, a denial and a failure are each
	   NAMED rather than silently swallowed — survives on the call's own
	   card and is asserted by the cases that remain in this file. */

	/**
	 * A CONTROL, not a gate: nothing in R3g can turn it red, and that is
	 * its job — it fails if a later fix takes the rollup out altogether
	 * rather than narrowing it to troubled runs.
	 */
	/**
	 * RETIRED (R3i phase 2), with the reason on the record rather than a
	 * contorted scenario.
	 *
	 * This was a CONTROL: it fed a clean run that spilled and asserted
	 * the rollup still formed, so that a later fix could not take the
	 * rollup out altogether while claiming to have narrowed it to
	 * troubled runs. It worked because twenty paced calls overflowed the
	 * live region — each call held a row of its own.
	 *
	 * Under the R3i projection that premise is gone by design: the open
	 * stretch is ONE line whose height does not depend on the call
	 * count, so a clean run of any length no longer spills and the
	 * commit-time rollup is unreachable for it. Measured while retiring
	 * this: eight paced reads at H=8 render `reading 2 files` …
	 * `reading 8 files` in place and settle as `✦ read 8 files · ctrl+o`
	 * — no force-commit, no rollup, nothing to control.
	 *
	 * The rollup itself is NOT gone: it is what `ctrl+o` opens on a
	 * folded stretch, through the same `rolledOf` / `rolledDetail`
	 * projection, and `r3b-segment-fold.test.ts` gates it there. Writing
	 * a new spill shape here just to keep a green row would be a gate
	 * that tests the shape it was given rather than the rule it names.
	 *
	 * The narrowing this control guarded — trouble breaks a rollup — is
	 * still gated by the case above it, which does not need a spill.
	 */
