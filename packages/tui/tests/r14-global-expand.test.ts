/**
 * DC-50 / R14 — ctrl+o IS A GLOBAL SWITCH, AND FLIPPING IT REPRINTS.
 *
 * What it was: a walk. The key toggled the newest un-committed tool
 * cell in place, and once those ran out it walked a ring of committed
 * cells and APPENDED an expansion block for the next one — because
 * ADR-0046 §3 said history is never rewritten, so a committed card
 * could not be re-rendered and the only way to show its body was to
 * print a copy further down. The ring needed `#opened` bookkeeping to
 * avoid repeating itself, `#lastAppend` to stop a held key printing the
 * same four rows three times (DC-35), and the owner still met a screen
 * where one card's body sat twice, far apart, in different shapes.
 *
 * What it is: one boolean. ctrl+o flips it; every SETTLED card renders
 * according to it — expanded is the full body with `ctrl+o collapses`,
 * collapsed is the five-line preview with `ctrl+o expands` — and the
 * flip is the SAME reprint a resize does (`2J H 3J`, then the session
 * from the model). Amendment 1 is what makes this possible: once the
 * terminal's scrollback is ours to erase, a committed card can be
 * re-rendered, so there is no reason to append a copy of it.
 *
 * A RUNNING card is not governed by the switch. Its height is E2/DC-43's
 * business — it grows from its own content — and a global "show
 * everything" must not reach into a card whose content is still
 * arriving.
 *
 * The viewer (ctrl+r) is untouched and the two coexist: ctrl+o changes
 * how the transcript is PRINTED, ctrl+r opens a surface for walking
 * back through it. §9 says so.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const BODY = 14; // rows of tool output — comfortably over CAP_PREVIEW

function harness(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const screen = new Screen(W, H);
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => {
			writes.push(s);
			screen.feed(s);
		},
	});
	return { body, screen, writes };
}

/** Three settled tool cards, each with a body longer than the preview. */
function threeCards(body: Body, tag: string): string[][] {
	const bodies: string[][] = [];
	for (let n = 1; n <= 3; n += 1) {
		const rows = Array.from({ length: BODY }, (_, i) => `${tag}${n}L${String(i + 1).padStart(2, "0")}`);
		bodies.push(rows);
		body.toolStart("shell", `c${n}`, { command: `echo ${tag}${n}` });
		body.toolRunning(`c${n}`);
		body.toolResult(`c${n}`, { content: rows.join("\n"), isError: false });
		vi.advanceTimersByTime(30);
	}
	return bodies;
}

const held = (s: Screen): string[] => s.allLines();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DC-50 — one switch, every settled card", () => {
	it("ONE press expands all three cards; the whole body of each is on the terminal", () => {
		const h = harness({ H: 200 }); // tall enough that nothing has to scroll
		h.body.enter();
		const bodies = threeCards(h.body, "A");
		vi.advanceTimersByTime(100);

		// The preview is the card's TAIL — `└ … 9 earlier lines · ctrl+o
		// expands` over the last five rows — so what a collapsed card
		// hides is its BEGINNING. (Asserted the other way round first,
		// which made the case red for the wrong reason: A1L14 is exactly
		// the row a collapsed card DOES show.)
		const before = held(h.screen);
		expect(before.some((l) => l.includes("A1L01")), "a collapsed card already showed its whole body").toBe(false);
		expect(before.some((l) => l.includes("A1L14")), "the collapsed card lost its preview").toBe(true);

		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);

		const after = held(h.screen);
		for (const rows of bodies) {
			for (const row of rows) {
				expect(after.some((l) => l.includes(row)), `${row} is missing after the expand`).toBe(true);
			}
		}
	});

	it("a SECOND press collapses all three again", () => {
		const h = harness({ H: 200 });
		h.body.enter();
		threeCards(h.body, "B");
		vi.advanceTimersByTime(100);
		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);
		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);

		const after = held(h.screen);
		expect(after.some((l) => l.includes("B1L01")), "the second press did not collapse").toBe(false);
		// and the cards are still there in their collapsed form
		expect(after.some((l) => l.includes("B1L14")), "the collapse took the card away entirely").toBe(true);
	});

	it("the flip IS a reprint — the erase triple, exactly once", () => {
		const h = harness({ H: 200 });
		h.body.enter();
		threeCards(h.body, "C");
		vi.advanceTimersByTime(100);
		h.writes.length = 0;

		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);

		const bytes = h.writes.join("");
		expect(bytes).toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(bytes.split("\x1b[3J").length - 1, "the flip erased more than once").toBe(1);
	});

	it("every row stands EXACTLY ONCE after a flip — the terminal holds one rendering", () => {
		const h = harness({ H: 24 }); // short: most of it must live in the scrollback
		h.body.enter();
		const bodies = threeCards(h.body, "D");
		vi.advanceTimersByTime(100);
		h.body.toggleExpanded();
		vi.advanceTimersByTime(200);

		const lines = held(h.screen);
		const all = bodies.flat();
		const doubled = all.filter((row) => lines.filter((l) => l.includes(row)).length > 1);
		const missing = all.filter((row) => !lines.some((l) => l.includes(row)));
		expect(doubled, `${doubled.length} rows stand twice`).toEqual([]);
		expect(missing, `${missing.length} rows are gone`).toEqual([]);
	});

	it("a RUNNING card is NOT governed by the switch", () => {
		const h = harness({ H: 200 });
		h.body.enter();
		h.body.toolStart("shell", "r1", { command: "sleep" });
		h.body.toolRunning("r1");
		h.body.toolProgress("r1", Array.from({ length: BODY }, (_, i) => `RUN${String(i + 1).padStart(2, "0")}`).join("\n"));
		vi.advanceTimersByTime(50);
		const before = held(h.screen).join("\n");

		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);
		const after = held(h.screen).join("\n");

		// the running card's own window rule (E2/DC-43) decides its height;
		// the switch must not have added its tail.
		const head = "RUN01";
		expect(after.includes(head), "the switch reached into a running card").toBe(before.includes(head));
	});
});

/**
 * CARRIED ITEM #1 (route-b-carried-items.md), re-derived for route B.
 *
 * The claim withdrawn from 0.24.2 was "an append never touches the rows
 * above it", asserted byte-for-byte at H=200 where the block fits and
 * nothing scrolls. There is no append any more, so the claim that
 * survives is the one the reprint has to make instead: the REPRINT
 * REPRODUCES those rows. Same fixture, same non-vacuity guard, a
 * different — and stronger — assertion, because a reprint could in
 * principle put anything there.
 */
describe("DC-50 — the reprint reproduces what was above the card", () => {
	it("collapse → expand → collapse leaves the rows above byte-identical", () => {
		const h = harness({ H: 200 });
		h.body.enter();
		// content ABOVE the card, so there is something to reproduce
		for (const line of ["above one", "above two", "above three", "above four", "above five"]) h.body.raw([line]);
		threeCards(h.body, "E");
		vi.advanceTimersByTime(100);

		const rowsAbove = (): string[] => {
			const lines = held(h.screen);
			const card = lines.findIndex((l) => l.includes("E1L01"));
			return lines.slice(0, card);
		};
		const first = rowsAbove();
		// NON-VACUITY: a byte-identical comparison over an empty region is
		// a green test that proves nothing, and on a 200-row screen with a
		// short transcript that is the DEFAULT outcome, not an edge case.
		expect(first.filter((l) => l.trim() !== "").length, "there was nothing above the card to reproduce").toBeGreaterThan(3);

		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);
		h.body.toggleExpanded();
		vi.advanceTimersByTime(100);

		expect(rowsAbove()).toEqual(first);
	});
});
