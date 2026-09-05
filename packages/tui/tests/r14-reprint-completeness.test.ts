/**
 * R14 / route B — THE REPRINT LOSES NOTHING.
 *
 * `2J H 3J` erases the terminal's screen AND its scrollback, so after a
 * settled resize the ONLY record the terminal holds is what the reprint
 * puts back. That makes completeness the load-bearing property of the
 * whole route: the old contract could afford an incomplete repaint
 * because the scrollback still held the original: this one cannot.
 *
 * The first build of the reprint got exactly this wrong. `#settleResize`
 * erased and the resize frame still took DC-34's adopt branch, which
 * scrolls nothing — so the frame painted the last screenful onto a
 * terminal whose history it had just erased and everything above was
 * simply gone. `dc34-widen-seam` measured 36 tokens missing. This file
 * is the unit-level form of that measurement, where it can be iterated
 * on in milliseconds rather than in a two-minute PTY run.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

function harness(opts: { W: number; H: number }) {
	let W = opts.W;
	let H = opts.H;
	const screen = new Screen(W, H);
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => screen.feed(s),
	});
	return {
		body,
		screen,
		setSize: (w: number, h: number) => {
			W = w;
			H = h;
			screen.resizeTo(w, { narrowing: "truncate-post-erase" });
		},
	};
}

/** Every line the terminal has ever shown: scrollback, then visible. */
const held = (s: Screen): string[] => s.allLines();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("R14 — after a settle, the terminal holds the whole transcript exactly once", () => {
	it("a transcript TALLER than the screen survives a widen, every row once", () => {
		const h = harness({ W: 60, H: 12 });
		h.body.enter();
		// 40 committed rows on a 12-row screen: most of it must live in the
		// scrollback, which is exactly what the erase throws away and the
		// reprint has to put back.
		const marks = Array.from({ length: 40 }, (_, i) => `MK${String(i).padStart(3, "0")}`);
		for (const m of marks) h.body.raw([m]);
		vi.advanceTimersByTime(100);

		h.setSize(80, 12);
		h.body.onResize();
		vi.advanceTimersByTime(200);

		const lines = held(h.screen);
		const missing = marks.filter((m) => !lines.some((l) => l.includes(m)));
		const doubled = marks.filter((m) => lines.filter((l) => l.includes(m)).length > 1);
		expect(missing, `the reprint dropped ${missing.length} rows`).toEqual([]);
		expect(doubled, `the reprint duplicated ${doubled.length} rows`).toEqual([]);
	});

	it("and survives a NARROW the same way", () => {
		const h = harness({ W: 80, H: 12 });
		h.body.enter();
		const marks = Array.from({ length: 40 }, (_, i) => `NK${String(i).padStart(3, "0")}`);
		for (const m of marks) h.body.raw([m]);
		vi.advanceTimersByTime(100);

		h.setSize(60, 12);
		h.body.onResize();
		vi.advanceTimersByTime(200);

		const lines = held(h.screen);
		expect(marks.filter((m) => !lines.some((l) => l.includes(m)))).toEqual([]);
		expect(marks.filter((m) => lines.filter((l) => l.includes(m)).length > 1)).toEqual([]);
	});

	it("G7 — a resize STORM through many geometries ends where the direct resize ends", () => {
		const marks = Array.from({ length: 30 }, (_, i) => `GK${String(i).padStart(3, "0")}`);
		const run = (path: readonly [number, number][]) => {
			const h = harness({ W: 80, H: 24 });
			h.body.enter();
			for (const m of marks) h.body.raw([m]);
			vi.advanceTimersByTime(100);
			for (const [w, hh] of path) {
				h.setSize(w, hh);
				h.body.onResize();
				vi.advanceTimersByTime(200); // each one settles
			}
			return held(h.screen).map((l) => l.replace(/\s+$/, "")).filter((l) => l !== "");
		};
		// V6 ②'s claim, un-scoped: the path taken to a geometry does not
		// change what the terminal ends up holding. Under the old contract
		// this was FALSE and the case documented the seam; the reprint
		// makes it true by construction — the terminal holds one rendering
		// of the model at the current geometry, and the model does not
		// remember how it got there.
		const direct = run([[64, 18]]);
		// NON-VACUITY, and it is not optional. Two empty lists are equal,
		// and a comparison over an empty region is a green test that
		// proves nothing — this round has already shipped three gates that
		// were green against the defect they named. The direct render must
		// actually be holding the transcript before its equality with the
		// storm means anything.
		expect(direct.length, "the direct resize held nothing to compare").toBeGreaterThan(20);
		expect(direct.filter((l) => l.includes("GK0")).length, "the marks are not on screen").toBeGreaterThan(0);
		const storm = run([
			[100, 30],
			[50, 10],
			[72, 40],
			[64, 18],
		]);
		expect(storm).toEqual(direct);
	});
});

/**
 * A MID-STREAM unit case was attempted here and REMOVED, because the
 * harness could not carry it. Driving `textAppend` under fake timers and
 * reading the emulator loses rows with NO resize at all — 11 of 24 marks
 * absent on a 12-row screen — so any resize claim built on it would have
 * been measuring the harness. The mid-stream shape is gated where it can
 * be driven honestly: `apps/cli/tests/dc34-widen-seam.test.ts`, through a
 * real CLI process and a real winch.
 */
