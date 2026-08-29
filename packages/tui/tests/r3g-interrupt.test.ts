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

		// (the fold rides the turn's user chip — A9 — so the line reads
		// `✦  second  · thought 4s · 2 reads`; the claim is the summary,
		// not the chip.)
		expect(plain(writes.join(""))).toContain("· thought 4s · read 2 files");
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

	it("and that turn does NOT fold — an interruption is trouble, and trouble keeps every row", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("first");
		call(body, "read_file", "a", { path: "x.ts" }, "x");
		body.toolStart("run_shell", "b", { command: "sleep 100" });
		body.toolRunning("b");
		body.endTurn(1);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toMatch(NO_FOLD);
		expect(frame).toContain("x.ts");
	});
});

describe("R3g ② — a denial is trouble even when it carries no reason string", () => {
	it("a DENIED call holds the turn unfolded", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("write it");
		call(body, "read_file", "a", { path: "x.ts" }, "x");
		body.toolStart("edit_file", "b", { path: "y.ts" });
		body.toolVerdict("b", "denied");
		body.toolResult("b", { content: "not permitted", isError: false });
		body.endTurn(3);
		tick();
		expect(plain(writes.join(""))).not.toMatch(NO_FOLD);
	});

	it("the same turn with the call APPROVED folds — the verdict is what makes the difference", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("write it");
		call(body, "read_file", "a", { path: "x.ts" }, "x");
		body.toolStart("edit_file", "b", { path: "y.ts" });
		body.toolVerdict("b", "approved");
		body.toolResult("b", { content: "ok", isError: false });
		body.endTurn(3);
		tick();
		expect(plain(writes.join(""))).toContain("· thought 3s · read 1 file · edited 1 file");
	});
});

/**
 * ③ needs a screen the turn cannot FIT: on a screen that fits it, a
 * clean turn folds and the rollup never renders at all (the fold is the
 * turn's one line — R3d). The rollup is what the force-commit path
 * leaves behind when the work spilled past the hold, so the pair below
 * is fed paced at H=12, which is where a rollup is the thing on screen.
 */
describe("R3g ③ — the rollup never speaks for a run it did not finish", () => {
	it("a FAILED member breaks the rollup: the rows stand, the failure keeps its own", () => {
		// Fed in ONE frame so the three calls are ONE run: the failure
		// already blocks the fold (isError — the rule that predates R3g),
		// which leaves the rollup as the thing under judgment here.
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("look");
		call(body, "read_file", "a", { path: "one.ts" }, "x");
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "no such file", true);
		call(body, "list_dir", "c", { path: "src" }, "x");
		body.textAppend("done.");
		body.endTurn(0);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("explored"); // no sentence over a failure
		expect(frame).toContain("one.ts"); // every member keeps its own row
	});

	/**
	 * A CONTROL, not a gate: nothing in R3g can turn it red, and that is
	 * its job — it fails if a later fix takes the rollup out altogether
	 * rather than narrowing it to troubled runs.
	 */
	it("a clean run that SPILLED still rolls up — the rule is the trouble, not the shape", () => {
		// PACED: fed in one frame the turn never overflows the hold, so it
		// folds and no rollup is drawn at all. A rollup is what the
		// force-commit leaves behind, and the force-commit needs frames.
		const { body, writes, tick } = makeBody(12);
		body.enter();
		body.userLine("look");
		for (let i = 0; i < 20; i += 1) {
			call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
			tick();
		}
		body.textAppend("done.");
		body.endTurn(0);
		tick();
		expect(plain(writes.join(""))).toContain("read  9 files");
	});
});
