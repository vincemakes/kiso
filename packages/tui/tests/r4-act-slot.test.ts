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

/* R13 — R4 A RETIRED, owner-ruled 2026-09-03, and the reversal is
   explicit: the standing act slot is gone, so the live region's height
   is a function of the calls IN FLIGHT rather than a constant. Its three
   cases said a stretch occupies one height whatever happens inside it,
   a three-call burst does not grow the region, and six calls in flight
   stay inside the slot with the overflow counted. None of them can be
   true without the slot.

   What replaces the property they were buying: `#liveRoom` caps the live
   region at what the committed rows leave, so the WINDOW's top depends
   only on `#committedLines` and therefore never falls — which is what
   R7a A measures directly, and where the residual one-row shift is
   priced (DC-46). The overflow is no longer "counted"; DC-43's shrink is
   what handles it, down to head rows. */

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
		// R13 MOVED THIS ASSERTION, and it is a stronger one now. Under R4
		// the finished call's output was in the SLOT, under the running
		// call's head, so the only way to state "the tail belongs to its
		// own call" was to forbid the older output entirely. Under R13
		// each call is its own card and the first call's output is on
		// screen where it belongs — under the FIRST head. So the subject
		// is asserted directly: the output is above the second call's
		// head, not below it.
		const rows = body_();
		const shown = rows.join("\n");
		expect(shown).toContain("second command");
		const at = rows.findIndex((r) => r.includes("OUTPUT-OF-FIRST"));
		const second = rows.findIndex((r) => r.includes("second command"));
		expect(at, "the first call's output is not on screen at all").toBeGreaterThanOrEqual(0);
		expect(at, "the first call's output landed under the SECOND call's head").toBeLessThan(second);
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

describe("R4 D — DC-28: ctrl+o mid-stretch acts, and is seen to act", () => {
	it("expanding the finished call between two calls RENDERS the expansion", () => {
		const { body, body_, tick } = makeBody({ H: 40 });
		body.enter();
		body.userLine("x");
		body.thinkingAppend("planning");
		running(body, "shell", "s1", { command: "npm run check" });
		// R13 E2 widened the window from three rows to the settled card's
		// five-plus-note, so the fixture grows with it: DC-28's subject is
		// that the PRESS is visible, and it needs a row the cap hides.
		finish(body, "s1", Array.from({ length: 9 }, (_, i) => `row ${i + 1}`).join("\n"));
		tick();
		const before = body_().join("\n");
		expect(before).not.toContain("row 1 "); // outside the preview cap

		// THE FORM OF THIS PRESS HAS CHANGED TWICE, and DC-28's subject has
		// survived both. Under R4 a finished call was still LIVE (its
		// committed form waited on the fold), so `ctrl+o` TOGGLED it in
		// place. R13 removed the fold, so a done call commits at once and
		// the press took the COMMITTED path and APPENDED a copy — the
		// shape ADR-0046 §3 required of history already in the scrollback.
		// DC-50 / R14 removes that requirement: the scrollback is ours to
		// erase, so the card is re-rendered where it stands and there is
		// no copy.
		//
		// DC-28's subject is unchanged and is still what is asserted: the
		// press ACTS, and what it produces carries the rows the cap had
		// hidden. The observation point moves from a returned block to the
		// projection, which is the stronger place — a returned block could
		// pass this case without ever reaching the terminal.
		body.toggleExpanded();
		tick();
		expect(body_().join("\n"), "the press did nothing at all").toContain("row 1");
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
		// R13: a finished call keeps its CARD, not its row, so five of them
		// are worth up to five cards. A read's card is three rows painted
		// and one unpainted; here nothing paints, and the blank D1 puts
		// between each pair is the second row. The bound moves from
		// five rows to ten and still discriminates: the pre-DC-27 scalar
		// re-rendered each call as its own block and counted twenty.
		expect(body.liveCount(), "the scalar is rendering blocks the screen does not have").toBeLessThanOrEqual(withOne + 10);
		// and it agrees with the screen: the live region starts where the
		// scalar says it does, counting up from the bottom.
		const rows = body_();
		expect(rows.length, "the scalar disagrees with the painted rows").toBeLessThanOrEqual(body.liveCount());
	});
});

/* R13 — R4a's four cases RETIRED with the fold row they are about: two
   of them said the committed fold prints no key and that its key still
   opens the run, and two said the ring's FIRST press opens the most
   recent fold with repeats walking back.

   The ring survives and so does its walk — it holds CARDS now, and
   `#collapsed` is fed by the same `hidesRows` test it always was. What
   is gone is the fold head that used to be fed alongside them. The
   walk's own rule (newest first, repeats walk back, the cycle restarts)
   is unchanged code and is exercised by dc35-expand-repeat. */

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
