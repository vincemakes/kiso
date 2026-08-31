/**
 * R4 — THE STANDING ACT SLOT.
 *
 * Written before the code, per the R3i charter's process.
 *
 * The defect R3i left: the act window was built INTERMITTENTLY. A call
 * in flight got its fixed 1+3 block (W8); a call that had finished got
 * nothing. So the live region's height was a function of how many calls
 * happened to be in flight at that instant — 2 rows between calls, 7
 * with one running, up to 17 with a three-call batch — and every
 * transition scrolled everything above it. The owner's report was that
 * the screen "keeps jumping"; that is an accurate description of the
 * shipped design, not a defect in its execution.
 *
 * The cure is a STANDING slot: allocated when the stretch opens,
 * released at the fold, its CONTENTS swapped rather than its rows
 * removed. Height changes twice per stretch instead of twice per call.
 *
 * Every gate below fails against 0.17.0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 90;
	const H = opts.H ?? 40;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const screen = (): string[] => {
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		return s.rows.map((r) => r.join("").replace(/\s+$/, ""));
	};
	const body_ = (): string[] => screen().filter((l) => l !== "" && !l.startsWith("─") && !l.includes("/ commands") && !l.includes("working"));
	return { body, writes, screen, body_, tick: () => vi.advanceTimersByTime(30) };
}
const running = (b: Body, name: string, id: string, input: Record<string, unknown>): void => {
	b.toolStart(name, id, input);
	b.toolRunning(id);
};
const finish = (b: Body, id: string, content = "line one\nline two\nline three"): void => {
	b.toolResult(id, { content, isError: false });
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R4 A — the height stands still across a whole stretch", () => {
	it("thinking, one call running, the gap after it, and the next call all occupy the SAME height", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("the failing job pulls rollup in the CI-only verify step");
		tick();
		const thinking = body_().length;

		running(body, "shell", "s1", { command: "npm run check" });
		tick();
		const acting = body_().length;

		finish(body, "s1");
		tick();
		const gap = body_().length; // 0.17.0 collapses here — this is the jump

		running(body, "read_file", "r1", { path: "packages/tui/src/compositor.ts" });
		tick();
		const next = body_().length;

		// DECLARED SUPERSESSION (R7a, owner-ruled 2026-08-31) — THE
		// REGION IS MONOTONE WITHIN A STRETCH, not constant.
		//
		// R4 held the height constant by PADDING the slot, because its
		// content came and went: a finished call left the block and the
		// block shrank under everything above it. Two rulings retired
		// that. The pad was drawn as `│`, a gutter down rows with
		// nothing on them, and blanking it (law 1.3) turned the padding
		// into a hole — the a7 replay priced it at blank runs over 2 in
		// 653 of 733 frames. And a finished call now KEEPS its row,
		// because a burst that dropped each name as it completed ended
		// having read four files and shown none of them.
		//
		// Keeping the rows is what makes the pad unnecessary: a block
		// whose rows only accumulate cannot shrink, so nothing above it
		// can be pulled down. That is the property below — the height
		// never DECREASES across a stretch — and it is strictly what
		// this test was protecting. The screen-position subject itself
		// is gated directly in r7a-standing-rows.test.ts.
		//
		// A per-stretch high-water pad was built to make `next` monotone
		// too, and measured: it did not (the re-composition is the
		// stretch line and the spacing, not the slot alone) and it put
		// a7's hole back. So the claim stops where it is TRUE — a call
		// finishing never shrinks the region, which is the ruling's own
		// content — and the screen-position subject is gated directly.
		expect(acting, "a call in flight must not shrink the region").toBeGreaterThanOrEqual(thinking);
		expect(gap, "a call FINISHING must not shrink the region — its name stays").toBeGreaterThanOrEqual(acting);
		expect(Math.abs(next - gap), "the next call re-composed the region by more than one row").toBeLessThanOrEqual(1);
	});

	it("a three-call parallel burst does NOT grow the region", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "read_file", "r1", { path: "a.ts" });
		tick();
		const one = body_().length;

		running(body, "read_file", "r2", { path: "b.ts" });
		running(body, "read_file", "r3", { path: "c.ts" });
		tick();
		const three = body_().length;
		// R7a: each call takes a row (the owner's ruling — a burst has
		// to leave its four names behind), so three calls are taller
		// than one. What must hold is that the growth is BOUNDED by the
		// slot and never reverses: finishing them does not shrink it.
		expect(three).toBeGreaterThanOrEqual(one);
		expect(three - one, "three calls cost more than three rows").toBeLessThanOrEqual(3);
		finish(body, "r1");
		finish(body, "r2");
		finish(body, "r3");
		tick();
		expect(body_().length, "finishing shrank the region").toBeGreaterThanOrEqual(three);
	});

	it("six calls in flight stay inside the slot and the overflow is COUNTED, not dropped", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "read_file", "r1", { path: "a.ts" });
		tick();
		const one = body_().length;
		for (let i = 2; i <= 6; i += 1) running(body, "read_file", `r${i}`, { path: `f${i}.ts` });
		tick();
		// the CAP is the subject and it holds: six calls do not draw six
		// rows. R7a lets each call take a row up to the slot's budget,
		// and the rest are counted rather than dropped.
		expect(body_().length, "six calls escaped the slot").toBeLessThanOrEqual(one + 4);
		expect(body_().join("\n")).toMatch(/\+\d+ more running/);
	});
});

describe("R4 B — the slot's contents SWAP rather than vanish", () => {
	it("between two calls the slot keeps the call that just finished, and its output", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "shell", "s1", { command: "npm run check" });
		finish(body, "s1", "tui-cells 94 passed\ntui 181 passed\n275 passed");
		tick();
		const shown = body_().join("\n");
		expect(shown).toContain("npm run check"); // the head is still there
		expect(shown).toContain("275 passed"); // and so is its tail
	});

	it("before any call, the slot shows the THINKING that is producing them (R3i ruling 5)", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("the failing job pulls rollup in the CI-only verify step");
		tick();
		expect(body_().join("\n")).toContain("CI-only verify step");
	});

	it("the tail under a head belongs to THAT head's call — never the previous one's output", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "shell", "s1", { command: "first command" });
		finish(body, "s1", "OUTPUT-OF-FIRST");
		running(body, "shell", "s2", { command: "second command" });
		tick();
		const shown = body_().join("\n");
		expect(shown).toContain("second command");
		expect(shown).not.toContain("OUTPUT-OF-FIRST");
	});
});

describe("R4 C — the slot never causes a force-commit (the clamp)", () => {
	// NOTE on falsifiability: these three gates PASS against 0.17.0,
	// because 0.17.0 had no standing slot and so nothing to overflow.
	// They are regression guards on the mechanism this round introduces,
	// not red→green proofs of a fixed defect — recorded as such rather
	// than dressed up as the latter.

	it("the slot GIVES WAY on a short terminal instead of committing real work", () => {
		// The slot is the thing that shrinks. At H=40 it stands at its
		// full budget. R6/D1 removed the block's W11 blank (it existed
		// while running and vanished at the settle, moving the fold row
		// up one), so the block is 5 content rows now, not 6 — and the
		// screen has to be one shorter for the clamp to fire at all. A slot that did NOT give way
		// would have made the force-commit loop push a real cell into
		// the scrollback to make room for its own blank padding.
		// R7a: the slot no longer PADS, so one running shell fits inside
		// H=8 on its own and the clamp has nothing to do — the old setup
		// stopped exercising the mechanism it was written for. A burst
		// is what wants more rows than a short screen has, so that is
		// what the two bodies are given now. The subject is unchanged:
		// the slot gives way rather than force-committing real work.
		const burst = (b: Body): void => {
			b.enter();
			b.userLine("x");
			b.thinkingAppend("planning");
			running(b, "shell", "s1", { command: "npm run check" });
			for (let i = 1; i <= 5; i += 1) running(b, "read_file", `r${i}`, { path: `packages/tui/src/f${i}.ts` });
		};
		const tall = makeBody({ H: 40 });
		burst(tall.body);
		tall.tick();

		const short = makeBody({ H: 8 });
		burst(short.body);
		short.tick();

		expect(tall.body.liveCount(), "the burst does not exceed H=8 on the tall body — the clamp is untested").toBeGreaterThan(8);
		expect(short.body.liveCount()).toBeLessThan(tall.body.liveCount());
		expect(short.body.liveCount()).toBeLessThanOrEqual(8);
	});

	it("the live region fits the content cap in every phase of a stretch, at H=10", () => {
		const { body, tick } = makeBody({ H: 10 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning a fairly long thought that will need folding at this width");
		const seen: number[] = [];
		tick();
		seen.push(body.liveCount());
		running(body, "shell", "s1", { command: "npm run check" });
		tick();
		seen.push(body.liveCount());
		finish(body, "s1");
		tick();
		seen.push(body.liveCount());
		for (const n of seen) expect(n).toBeLessThanOrEqual(10);
	});
});

describe("R4 D — DC-28: ctrl+r mid-stretch acts, and is seen to act", () => {
	it("expanding the finished call between two calls RENDERS the expansion", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "shell", "s1", { command: "npm run check" });
		finish(body, "s1", ["row one", "row two", "row three", "row four", "row five", "row six"].join("\n"));
		tick();
		const before = body_().join("\n");
		expect(before).not.toContain("row one"); // outside the 3-row window

		body.expandNext();
		tick();
		expect(body_().join("\n")).toContain("row one"); // the press is VISIBLE
	});
});

describe("R4 E — DC-27: the scalar measures the screen", () => {
	it("liveCount tracks the projection through a stretch, not a render of its own", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "shell", "s1", { command: "npm run check" });
		tick();
		const withOne = body.liveCount();
		// R7a: a finished call KEEPS its row (the owner's ruling), so the
		// five below are worth up to five rows — not zero, as R4 had it,
		// and emphatically not the twenty the pre-DC-27 scalar counted
		// by re-rendering each as a four-row block the screen does not
		// contain. The subject is that the scalar measures the SAME
		// projection the screen is painted from; the bound is what
		// discriminates it from a second render of its own.
		for (let i = 0; i < 5; i += 1) {
			running(body, "read_file", `r${i}`, { path: `f${i}.ts` });
			finish(body, `r${i}`);
		}
		tick();
		expect(body.liveCount()).toBeGreaterThanOrEqual(withOne);
		expect(body.liveCount(), "the scalar is rendering blocks the screen does not have").toBeLessThanOrEqual(withOne + 5);
		// and it agrees with the screen: the live region starts where the
		// scalar says it does, counting up from the bottom.
		const rows = body_();
		expect(rows.length, "the scalar disagrees with the painted rows").toBeLessThanOrEqual(body.liveCount());
	});
});

describe("R4a — the fold row prints no key, and ctrl+r opens the MOST RECENT", () => {
	// R7: a stretch needs TWO calls to fold now — thinking left the
	// segment, so think + one call is a single cell and stays below the
	// >= 2 gate (which is the ruling working: a lone call keeps its own
	// row, with its target verbatim). These gates are about the FOLD, so
	// their fixture makes one.
	const stretch = (b: Body, i: number): void => {
		b.thinkingAppend(`thinking ${i}`);
		b.thinkingEnd();
		for (const k of [0, 1]) {
			b.toolStart("read_file", `r${i}-${k}`, { path: `f${i}${k === 0 ? "" : "b"}.ts` });
			b.toolRunning(`r${i}-${k}`);
			b.toolResult(`r${i}-${k}`, { content: "one\ntwo\nthree", isError: false });
		}
		b.textAppend(`narrating ${i}.\n`);
		b.textEnd();
	};
	/** the committed FOLD rows only — a tool card's own `ctrl+r expands`
	 *  is a different row with a different (still true) promise. */
	const foldRows = (writes: string[]): string[] =>
		plain(writes.join(""))
			.split(/\x1b\[\d+;1H|\n/)
			.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim())
			// R6/D3: the fold wears no mark — its grammar is what finds it.
			.filter((l) => /^(read|edited|wrote|listed|ran|explored|thought)\b/.test(l) && !l.includes("("));

	it("no committed fold advertises a key — the row is its words alone", () => {
		const { body, writes, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		const rows = foldRows(writes);
		expect(rows.length).toBeGreaterThanOrEqual(2); // the folds are there...
		for (const r of rows) expect(r).not.toContain("ctrl+r"); // ...and none names a key
	});

	it("...and the work is still reachable: the key answers with the run's own rows", () => {
		const { body, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		stretch(body, 0);
		body.endTurn(1);
		tick();
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		if (r.kind !== "appended") return;
		expect(plain(r.lines.join("\n"))).toContain("f0.ts");
	});

	it("the FIRST press after new work opens the MOST RECENT fold, always", () => {
		// The owner's question was "with that many folds, do you know which
		// one opens?" — the answer has to be the same sentence every time.
		// A new fold resets the walk, so it is: the last one.
		const { body, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		stretch(body, 0);
		stretch(body, 1);
		body.endTurn(1);
		tick();
		const first = body.expandNext();
		expect(first.kind).toBe("appended");
		if (first.kind === "appended") expect(plain(first.lines.join("\n"))).toContain("f1.ts");

		// a walk already in progress, and then NEW work lands
		body.expandNext(); // walks back to the older one
		body.userLine("y");
		stretch(body, 2);
		body.endTurn(1);
		tick();
		const after = body.expandNext();
		expect(after.kind).toBe("appended");
		if (after.kind === "appended") expect(plain(after.lines.join("\n"))).toContain("f2.ts");
	});

	it("repeats walk BACK — the older folds stay reachable from the keyboard", () => {
		const { body, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		stretch(body, 0);
		stretch(body, 1);
		body.endTurn(1);
		tick();
		const seen: string[] = [];
		for (let i = 0; i < 2; i += 1) {
			const r = body.expandNext();
			if (r.kind === "appended") seen.push(plain(r.lines.join("\n")));
		}
		expect(seen[0]).toContain("f1.ts"); // newest first...
		expect(seen[1]).toContain("f0.ts"); // ...then back
	});
});

describe("R4 G — C4(d): the append-only re-wrap", () => {
	const para = "The failing job pulls the rollup native binary in the CI-only verify step, which is where the lockfile's optional platform package never gets installed on a clean Linux runner.";

	it("re-folds the prose at the CURRENT width — narrow gives more rows than wide", () => {
		const rowsAt = (W: number): number => {
			const { body, tick } = makeBody({ W, H: 40 });
			body.enter();
			body.userLine("x");
			body.textAppend(`${para}\n`);
			body.textEnd();
			body.endTurn(1);
			tick();
			return body.rewrap().lines.length;
		};
		expect(rowsAt(50)).toBeGreaterThan(rowsAt(100));
	});

	it("APPENDS — the committed rows above are not touched (ADR-0046)", () => {
		const { body, tick } = makeBody({ W: 80, H: 40 });
		body.enter();
		body.userLine("x");
		body.textAppend(`${para}\n`);
		body.textEnd();
		body.endTurn(1);
		tick();
		const before = body.liveCount();
		const r = body.rewrap();
		expect(r.lines.length).toBeGreaterThan(0);
		// rewrap is a pure read: it renders, it does not commit, scroll,
		// or mutate a single cell. The caller appends its lines like any
		// other log output.
		expect(body.liveCount()).toBe(before);
	});

	it("every re-wrapped row obeys invariant ① at the width it was asked for", () => {
		const W = 44;
		const { body, tick } = makeBody({ W, H: 40 });
		body.enter();
		body.userLine("x");
		body.textAppend(`${para}\n`);
		body.textEnd();
		body.endTurn(1);
		tick();
		for (const line of body.rewrap().lines) {
			expect(plain(line).length).toBeLessThanOrEqual(W);
			expect(line).not.toContain("\n"); // invariant ①b — a row is ONE row
		}
	});

	it("with no prose yet it says so rather than returning a confident nothing", () => {
		const { body, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		tick();
		expect(body.rewrap()).toEqual({ lines: [], blocks: 0, skipped: 0 });
	});
});
