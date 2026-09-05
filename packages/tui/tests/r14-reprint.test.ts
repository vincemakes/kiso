/**
 * R14 / route B — A SETTLED RESIZE ERASES THE TERMINAL AND REPRINTS.
 *
 * ADR-0046 §3 used to say committed bytes are never re-emitted: zero
 * replay, zero `\x1b[3J`, the user's shell history never touched. R10
 * measured what that bought on the owner's real terminal, and it was
 * not what it promised — a grow lost 16 rows of history outright
 * (DC-39), a narrow duplicated four tokens, and the scrolled-off part
 * of the transcript never reflowed at all. Every one of those is the
 * same fact from a different side: kiso was doing window arithmetic
 * over rows the terminal had already reflowed underneath it.
 *
 * Route B stops arguing with the terminal. On a settled resize whose
 * geometry changed, kiso writes `2J H 3J` — erase screen, home, erase
 * scrollback, in that order, because on Apple Terminal `2J` alone
 * scrolls the screen INTO history and only the following `3J` makes
 * the state clean — and then reprints the whole committed transcript
 * at the new width through the path a fresh terminal already uses. The
 * terminal ends holding exactly one rendering of the session.
 *
 * THE DECLARED COST, and it is not small: everything the terminal held
 * before kiso started is erased at the first resize. Measured on the
 * reference implementation as 0/60 in every direction — this is the
 * behaviour being adopted, not a regression being introduced. kiso's
 * own record is untouched; the session log holds it and `--resume`
 * replays it. Ruled by the owner 2026-09-04 against the alternative
 * (a transcript whose scrolled-off part never reflows) after both were
 * measured. ADR-0046 Amendment 1 carries the text.
 *
 * D-B2: EVERY settled resize reprints, height-only included. That is
 * the reference's measured behaviour and it is what makes DC-39's
 * height arithmetic unnecessary rather than fixed.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
	});
	return {
		body,
		writes,
		setSize: (w: number, h: number) => {
			W = w;
			H = h;
		},
	};
}

const ERASE = "\x1b[2J\x1b[H\x1b[3J";
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("R14 — the settle erases and reprints", () => {
	it("a width change emits 2J H 3J, in that order, exactly once", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.body.raw(["committed one", "committed two"]);
		h.writes.length = 0;

		h.setSize(60, 24);
		h.body.onResize();
		vi.advanceTimersByTime(100);

		const bytes = h.writes.join("");
		expect(bytes, "the erase triple is absent or out of order").toContain(ERASE);
		expect(count(bytes, "\x1b[3J"), "3J emitted more than once").toBe(1);
	});

	it("D-B2 — a HEIGHT-only change reprints too", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.body.raw(["committed one"]);
		h.writes.length = 0;

		h.setSize(80, 12);
		h.body.onResize();
		vi.advanceTimersByTime(100);

		expect(h.writes.join("")).toContain(ERASE);
	});

	it("the reprint carries the COMMITTED transcript, not just the live area", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.body.raw(["alpha row"]);
		h.body.raw(["beta row"]);
		h.body.raw(["gamma row"]);
		h.writes.length = 0;

		h.setSize(70, 24);
		h.body.onResize();
		vi.advanceTimersByTime(100);

		const bytes = h.writes.join("");
		for (const row of ["alpha row", "beta row", "gamma row"]) {
			expect(bytes, `${row} was not reprinted`).toContain(row);
		}
	});

	it("a same-size SIGWINCH emits NOTHING — the V6-1 idempotence case", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.body.raw(["committed"]);
		vi.advanceTimersByTime(100);
		h.writes.length = 0;

		h.body.onResize(); // no setSize: same geometry
		vi.advanceTimersByTime(100);

		expect(h.writes.join(""), "a same-size winch repainted").toBe("");
	});

	it("one drag storm is ONE erase — RESIZE_SETTLE_MS coalescing (G9)", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.body.raw(["committed"]);
		h.writes.length = 0;

		for (const w of [78, 76, 74, 72, 70]) {
			h.setSize(w, 24);
			h.body.onResize();
			vi.advanceTimersByTime(10); // inside the settle window
		}
		vi.advanceTimersByTime(200); // the drag stops

		expect(count(h.writes.join(""), "\x1b[3J"), "a drag storm erased more than once").toBe(1);
	});

	it("G6 — an ORDINARY frame still never emits 3J; the erase belongs to the settle alone", () => {
		const h = makeBody({ W: 80, H: 24 });
		h.body.enter();
		h.writes.length = 0;
		h.body.raw(["one"]);
		h.body.raw(["two"]);
		vi.advanceTimersByTime(100);

		const bytes = h.writes.join("");
		expect(bytes).not.toContain("\x1b[3J");
		expect(bytes).not.toContain("\x1b[2J");
	});
});
