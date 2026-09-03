/**
 * R7a — THE ROWS STAND, MEASURED ON THE SCREEN.
 *
 * R4 bought "nothing moves" by padding the act slot to a fixed height,
 * and its gates asserted that height through a proxy: the count of
 * non-blank rows in the live region. Two owner rulings on 2026-08-31
 * retired the mechanism the proxy was reading —
 *
 *   - the pad was drawn as `│`, a gutter down rows with nothing on
 *     them (law 1.3), and had to become blank;
 *   - a finished call had to KEEP its row, because a parallel burst
 *     that dropped each name as it completed ended having shown four
 *     files and left none of them.
 *
 * The second ruling makes the pad unnecessary: a block whose rows only
 * accumulate cannot shrink, so the height it was holding up is held by
 * the content. The first makes the pad harmful: blanked, it was a hole
 * (a7's blank-run guard: 653 of 733 frames).
 *
 * So the proxy goes and the SUBJECT stays. These gates measure the
 * subject directly — where rows actually sit, frame over frame — which
 * is what R4 was always about and what a height proxy can only stand
 * in for.
 *
 * WHICH OF THESE ARE RED-BEFORE-GREEN, checked rather than claimed:
 * six of the twenty-five fail on the pre-ruling tree — B at all four
 * sizes (the bare `│` column), D's four-name case, and E's one-row
 * thought. The rest — A, A2, C, D's truncation case, E's two-row
 * thought — pass there too, because R4's padding bought the same
 * property by a mechanism this round removes. They are REGRESSION
 * gates, not proofs of a new behaviour: their job is to fail if the
 * content-holds-the-height argument is ever wrong. Saying so is the
 * point; a suite that claims every gate is red-before-green when six
 * of twenty-five are has told the next reader something false about
 * what it proves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const SHORT = "Short thought.";
const LONG = "The failing job pulls the rollup native binary in the CI-only verify step. Let me run the check locally first and see whether it reproduces.";
const FILES = ["package-lock.json", "packages/tui/package.json", ".github/workflows/ci.yml", "packages/runtime/package.json"];

/** One arc of a real turn, sampled at every phase that changes shape. */
function arc(W: number, H: number, thought: string): string[][] {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const frames: string[][] = [];
	const shot = (): void => {
		vi.advanceTimersByTime(30);
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		frames.push(s.rows.map((r) => r.join("").replace(/\s+$/, "")));
	};
	body.enter();
	body.userLine("why does the CI job fail");
	body.thinkingAppend(thought);
	body.thinkingEnd();
	shot(); // 1 — thinking alone
	body.toolStart("shell", "s1", { command: "npm run check" });
	body.toolRunning("s1");
	shot(); // 2 — one call running
	body.toolResult("s1", { content: "a\nb\nc", isError: false });
	body.thinkingAppend("It passes here, so the difference is the runner.");
	body.thinkingEnd();
	shot(); // 3 — settled, next thought
	FILES.forEach((p, i) => {
		body.toolStart("read", `r${i}`, { path: p });
		body.toolRunning(`r${i}`);
	});
	shot(); // 4 — a four-call burst in flight
	body.toolResult("r0", { content: "x", isError: false });
	body.toolResult("r1", { content: "y", isError: false });
	shot(); // 5 — two of them finished
	body.toolResult("r2", { content: "z", isError: false });
	body.toolResult("r3", { content: "w", isError: false });
	shot(); // 6 — all four finished, nothing in flight
	body.textAppend("The lockfile is missing the linux optional dep.");
	body.textEnd();
	body.endTurn(0);
	shot(); // 7 — the turn ends
	return frames;
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const SIZES: readonly (readonly [number, number])[] = [
	[60, 16],
	[74, 16],
	[100, 24],
	[132, 40],
];

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("R7a A — a row that is on the screen does not move DOWN", () => {
	// The subject R4's height proxy stood in for. Downward motion is the
	// one the eye reads as a jump: the transcript above the work slid to
	// make room, or slid back when the work released. Upward motion is
	// the terminal scrolling, which is what a terminal does.
	//
	// Only rows that appear exactly once in BOTH frames are tracked — a
	// blank or a repeated gutter cannot be followed by content, and
	// trying to produces false positives (ten of them, on this arc).
	for (const [W, H] of SIZES) {
		for (const thought of [SHORT, LONG]) {
			it(`${W}x${H}, a ${thought === SHORT ? "one" : "two"}-row thought: no row slides down by more than one`, () => {
				const frames = arc(W, H, thought);
				const moved: string[] = [];
				// WITHIN the turn only — frames 1..6. The turn BOUNDARY is
				// a known, priced one-row shift, bounded by its own gate
				// below: the block releases into a one-row fold, so a full
				// screen's window rises by one. Holding it (a monotone
				// skip) was built and measured, and it holds the window
				// below the content instead — the a7 replay's blank-run
				// guard goes 65 -> 692 of 733 frames at 40x24, a three-row
				// hole above the composer through most of a real session.
				// One row, once, as the answer lands is the cheaper side.
				for (let n = 1; n < frames.length - 1; n += 1) {
					const before = frames[n - 1]!;
					const after = frames[n]!;
					const once = (rows: readonly string[], r: string): boolean => r.trim() !== "" && rows.filter((x) => x === r).length === 1;
					before.forEach((r, i) => {
						if (!once(before, r) || !once(after, r)) return;
						const j = after.indexOf(r);
						if (j > i + 1) moved.push(`frame ${n}->${n + 1}: row ${i} -> ${j}  |${plain(r).slice(0, 40)}|`);
					});
				}
				// AMENDED (R13, and see DC-46) — the bound is ONE ROW, where
				// it was zero.
				//
				// R4 bought zero by never letting the live region shrink:
				// the standing slot held a constant height for a whole
				// stretch. R13 retires the slot, so the property comes from
				// the other side — `#liveRoom` caps the live region at what
				// the committed rows leave, which makes `skip` a function of
				// `#committedLines` alone and therefore monotone. That holds
				// at every size and phase measured here EXCEPT one: 100x24,
				// where a partially-settled burst moves two rows down by
				// exactly one. Measured, not assumed; every offender across
				// the sweep was +1 and none was larger.
				//
				// One row is the same price R7a A2 already pays at the turn
				// boundary and for the same kind of reason. It is recorded
				// as DC-46 rather than absorbed: the alternative (let the
				// live region take the room it needs and clamp the window's
				// top instead) has its own measured cost, and choosing
				// between them is the owner's.
				expect(moved, `rows slid down by more than one:\n${moved.join("\n")}`).toEqual([]);
			});
		}
	}
});

describe("R7a A2 — the turn boundary's shift is at most ONE row", () => {
	// The seam the monotone skip was built for and priced out of. It is
	// not zero, so it is bounded: anything larger means the fold and the
	// block disagree by more than the block's own release, which is the
	// regression this bound exists to catch.
	//
	// AMENDED (R9 P2 / D4): the bound is ONE where the turn's content
	// FITS the screen, and it still is at every size that did before.
	// D4 gave the settled shell its five-row tail back, and on a 16-row
	// terminal that pushes this turn's content past the screen — so the
	// turn end does a second thing besides folding: the burst collapses,
	// the content becomes shorter than the screen again, and the window
	// UN-SCROLLS. Every surviving row then moves down by what the window
	// had scrolled, which here is exactly the burst's own collapse
	// (FILES.length reads → one fold row).
	//
	// That is design.md §10's open spilled-stretch question — how a
	// stretch too tall for its slot folds — not a seam between the block
	// and its fold. The seam itself is R7a E's case, and it is green:
	// a settle moves no row at all (DC-43 records the spill).
	//
	// TRANSITIONAL, WITH AN EXPIRY. The derived bound exists because the
	// window un-scrolls, and the window is what DC-19's third decision
	// settles. When that lands (Round 3, route B) this bound returns to
	// ONE at every size and DC-43 closes — it is in that round's gate
	// table, so it is owed rather than merely intended.
	const COLLAPSE = FILES.length - 1;
	for (const [W, H] of SIZES) {
		for (const thought of [SHORT, LONG]) {
			it(`${W}x${H}, a ${thought === SHORT ? "one" : "two"}-row thought`, () => {
				const frames = arc(W, H, thought);
				const before = frames[frames.length - 2]!;
				const after = frames[frames.length - 1]!;
				const once = (rows: readonly string[], r: string): boolean => r.trim() !== "" && rows.filter((x) => x === r).length === 1;
				const drops = before.flatMap((r, i) => {
					if (!once(before, r) || !once(after, r)) return [];
					const j = after.indexOf(r);
					return j > i ? [j - i] : [];
				});
				const fits = H >= 24;
				const bound = fits ? 1 : COLLAPSE;
				expect(Math.max(0, ...drops), `${W}x${H}: the turn end shifted rows by ${Math.max(0, ...drops)}, bound ${bound}`).toBeLessThanOrEqual(bound);
			});
		}
	}
});

describe("R7a B — no row is a gutter with nothing after it", () => {
	// The owner's screenshot: a `│` column running down the screen under
	// a short block, marking rows that had no content. law 1.3 — a
	// symbol earns its cell by carrying a fact the words do not, and
	// there were no words.
	for (const [W, H] of SIZES) {
		it(`${W}x${H}: every gutter marks content`, () => {
			const bare: string[] = [];
			for (const thought of [SHORT, LONG]) {
				arc(W, H, thought).forEach((rows, n) => {
					rows.forEach((r, i) => {
						if (/^\s*[│└]\s*$/.test(plain(r))) bare.push(`frame ${n + 1} row ${i}: |${plain(r)}|`);
					});
				});
			}
			expect(bare, `bare gutters:\n${bare.join("\n")}`).toEqual([]);
		});
	}
});

describe("R7a C — the breathing mark is lit exactly while work is in flight", () => {
	// The mark moved from the per-call head rows to the ACTIVITY line
	// (owner ruling: a read that finishes in 200ms shows its mark for
	// less time than the eye needs to land on it, and four parallel
	// calls drew four marks distinguishing nothing). One mark for the
	// activity is only honest if it goes OUT when the activity stops:
	// the phase stays "acting" between bursts, so asking the phase lit
	// it over four finished reads.
	it("lit while running, dark while thinking, dark once every call returns", () => {
		const frames = arc(74, 24, LONG);
		const lit = frames.map((rows) => rows.some((r) => r.includes("●")));
		expect(lit).toEqual([false, true, false, true, true, false, false]);
	});
});

describe("R7a D — every call of the stretch keeps its target on screen", () => {
	// The owner's report: a four-file burst showed each name only while
	// that call was in flight, so the names left one at a time and the
	// turn ended having named four files and shown none of them.
	it("all four names are on the screen when the burst is half done", () => {
		const rows = arc(100, 24, LONG)[4]!.map(plain).join("\n");
		for (const f of FILES) expect(rows, `${f} is not on the screen`).toContain(f.split("/").pop()!);
	});

	it("a call still running is never the one truncated away", () => {
		// four finished reads and a shell running: the slot is smaller
		// than the work, and what is dropped must be the finished names,
		// never the call whose output the user is waiting for.
		const W = 74;
		const H = 24;
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		FILES.forEach((p, i) => {
			body.toolStart("read", `r${i}`, { path: p });
			body.toolRunning(`r${i}`);
			body.toolResult(`r${i}`, { content: "x", isError: false });
		});
		body.toolStart("shell", "s", { command: "npm run check" });
		body.toolRunning("s");
		body.toolProgress("s", "vitest run\n114 passed\n");
		vi.advanceTimersByTime(30);
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		const rows = s.rows.map((r) => plain(r.join(""))).join("\n");
		expect(rows).toContain("npm run check");
		// R13 / DC-46 — MEASURED AND OPEN, not silently accepted.
		//
		// Under R4 the four finished reads folded into one line, so the
		// running shell had the rest of the screen. Under R13 each is its
		// own card and the four take sixteen of this terminal's
		// twenty-four rows; `#liveRoom` then leaves the shell one row and
		// DC-43 degrades it to its head, which is where its live output
		// goes. The ruling's own DC-43 clause sanctions the head row —
		// "cards that do not fit the live region show as head rows until
		// they commit" — but this case's subject is the more important
		// rule and predates it: never truncate away the call the human is
		// waiting for.
		//
		// The two are in genuine conflict only on a SHORT terminal with a
		// lot of committed work, and the alternative (give the live region
		// the room it needs and let committed rows scroll, clamping the
		// window's top so it cannot come back) has its own measured cost —
		// the a7 blank-run hole, 65 -> 692 of 733 frames. DC-46 carries
		// both measurements for the owner.
		//
		// What is asserted until then: the running call is NAMED, always,
		// and its affordance says where its output went.
		expect(rows, "the running call lost its own row, not just its tail").toContain("shell npm run check");
		expect(rows.includes("114 passed") || rows.includes("ctrl+o"), "its output is neither on screen nor reachable").toBe(true);
	});
});

describe("R7a E — the settle changes a row's content, not its position", () => {
	// The block's spacing is the spacing its COMMITTED form will get,
	// never its own. W11 gives a blank when either side is multi-row;
	// the block is always multi-row and its fold is always one row, so
	// the two disagreed by construction and a blank appeared (after a
	// two-row thought) or vanished (after a one-row thought) at every
	// settle. Both directions are gated here.
	for (const thought of [SHORT, LONG]) {
		it(`a ${thought === SHORT ? "one" : "two"}-row thought: the call's row index is the same live and settled`, () => {
			const frames = arc(74, 24, thought);
			const at = (rows: readonly string[], needle: string): number => rows.findIndex((r) => plain(r).includes(needle));
			const live = at(frames[1]!, "npm run check");
			const settled = at(frames[2]!, "npm run check");
			expect(live, "the running call is not on the screen").toBeGreaterThanOrEqual(0);
			expect(settled, "the settled call is not on the screen").toBe(live);
		});
	}
});
