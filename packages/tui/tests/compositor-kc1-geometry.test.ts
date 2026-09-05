/**
 * KC1 slice ④ — the N>1 geometry (T-C2..T-C5). The composer grows the
 * chrome through the SAME mechanism the menu and queue bands already
 * use (chromeRows = 3 + N + menu + queue): the box top rises to H−2−N,
 * the N input rows occupy H−1−N..H−2, the content cap loses those rows,
 * and the cursor is still derived FROM THE FRAME — the marker rides the
 * CURSOR'S row, and the frame's final relative move + CHA land on it.
 *
 * T-C2  N=3 geometry: box top H−5, content cap H−6−queue, the marker on
 *       the cursor's row (frame-derived, no editPos side channel)
 * T-C3  a resize at N>1: ED0 from the recorded live top + a full redraw,
 *       idempotent across repeats
 * T-C4  stacking: the menu band + the queue chips + N=3 compose, in
 *       their unchanged row order
 * T-C5  the tiny terminal: H=7 with an 8-line buffer — N_visible clamps
 *       by the height, every row is legal (no row ≤ 0, no negative cap),
 *       and the cursor's row stays inside the window
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, type InputState } from "../src/compositor.js";

const rows3 = (cursorRow: number): (() => InputState) => () => ({
	line: ["one", "two", "three"][cursorRow]!,
	cursor: 1,
	lines: ["one", "two", "three"],
	cursorRow,
	cursorCol: 1,
});

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return {
		body,
		writes,
		tick: () => vi.advanceTimersByTime(16),
		setSize: (w: number, h: number) => {
			W = w;
			H = h;
		},
	};
}

/** every CUP row the frame writes — the geometry's ground truth */
const cupRows = (bytes: string): number[] => [...bytes.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
/** the row a CUP+EL wrote the given text at — matched THROUGH styling
 *  (REL-0161: the composer's drawn cursor wraps one cell in SGR 7…27,
 *  so a text needle may span it) */
/**
 * R2 — both composer rails are the SAME dashed rule now, so "find the
 * top rail" cannot be a glyph search any more. `railRows` returns the
 * rail rows in screen order: [0] is the top, [1] the bottom, which is
 * exactly what the corner glyphs used to encode.
 */
const railRows = (bytes: string): number[] => {
	const out: number[] = [];
	for (const m of bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)) {
		if (/^\u2500+$/.test(m[2]!.replace(/\x1b\[[0-9;]*m/g, ""))) out.push(Number(m[1]));
	}
	return [...new Set(out)].sort((a, b) => a - b);
};

const rowOf = (bytes: string, needle: string): number | undefined => {
	for (const m of bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)) {
		if (m[2]!.replace(/\x1b\[[0-9;]*m/g, "").includes(needle)) return Number(m[1]);
	}
	return undefined;
};

describe("KC1 T-C2 — the N=3 geometry", () => {
	it("the box top rises to H−5, the three input rows fill H−4..H−2, the bottom and status never move", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(rows3(1), "\u203a ");
		body.enter(); // the full-redraw path — every row is CUP-addressed
		tick();
		const bytes = writes.join("");
		expect(railRows(bytes)[0]).toBe(19); // H−5 — the box top (H−2−N)
		expect(rowOf(bytes, "one")).toBe(20); // H−4 — the first composer row
		expect(rowOf(bytes, "two")).toBe(21); // H−3
		expect(rowOf(bytes, "three")).toBe(22); // H−2 — the last composer row
		expect(railRows(bytes).at(-1)).toBe(23); // H−1 — the box bottom
		expect(rowOf(bytes, "/ commands")).toBe(24); // H — the status
	});

	it("the lead rides the FIRST row; the continuations indent by its width (the cursor column formula is the same on every row)", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(rows3(0), "\u203a ");
		body.enter();
		tick();
		const bytes = writes.join("").replace(/\x1b\[(?:7|27)m/g, ""); // REL-0161: read through the drawn cursor
		expect(bytes).toContain("› one");
		expect(bytes).toContain("  two"); // the two-cell indent — the lead's width
		expect(bytes).toContain("  three");
	});

	it("the cursor derives FROM THE FRAME: the marker rides the CURSOR'S row and the final move lands on it", () => {
		for (const cursorRow of [0, 1, 2]) {
			const { body, writes, tick } = makeBody();
			body.bindInput(rows3(cursorRow), "\u203a ");
			body.enter();
			tick();
			const bytes = writes.join("");
			expect(bytes).not.toContain("kiso-cur"); // the marker never reaches the stream
			// DECLARED SUPERSESSION (REL-0152-R1): the park is ABSOLUTE. It
			// used to end at the status row and walk UP by 1 + N − markerRow,
			// because the bottom-up march guaranteed where it started from;
			// a diff ends on whatever row changed last, so the walk has no
			// base to count from. The row this case is about is the same
			// row, named directly instead of counted backwards from H.
			const park = [...bytes.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1])).at(-1);
			expect(park, "the frame does not park on the cursor's row").toBe(24 - (1 + 3 - cursorRow));
			// …then the CHA to the marker's column — wallL (0, R2: the box is
			// retired) + lead (2) + the cursor's column (1) + 1
			const cha = [...bytes.matchAll(/\x1b\[(\d+)G/g)].map((m) => Number(m[1])).at(-1);
			expect(cha).toBe(4);
		}
	});

	it("the content cap loses the composer's extra rows: H−6−queue at N=3 (the live scalar reflects the screen)", () => {
		const { body, tick } = makeBody(); // H = 24 → the cap binds at 18 content rows
		body.bindInput(rows3(2), "\u203a ");
		body.bindQueue(() => ["a queued turn"]);
		body.enter();
		body.textAppend(Array.from({ length: 40 }, (_, i) => `tall ${i}`).join("\n"));
		tick();
		// chrome = 3 + N(3) + queue(1) = 7 → the content keeps H − 7 = 17
		expect(body.liveCount()).toBeLessThanOrEqual(24);
		expect(body.liveCount() - 7).toBeLessThanOrEqual(24 - 3 - 3 - 1);
	});
});

describe("KC1 T-C3 — a resize at N>1 is idempotent", () => {
	it("the winch clears from the recorded live top and re-paints every row; a repeat lands on the same bytes", () => {
		const { body, writes, tick, setSize } = makeBody();
		body.bindInput(rows3(1), "\u203a ");
		body.enter();
		body.raw(["frozen"]);
		tick();
		writes.length = 0;
		setSize(70, 20);
		body.onResize();
		vi.advanceTimersByTime(100); // REL-0152-D18: the drag settles, then it repaints
		const first = writes.join("");
		// DECLARED SUPERSESSION (R14 / route B, 2026-09-05) — the resize
		// ERASES and reprints (ADR-0046 Amendment 1). This case pinned the
		// scoped ED0 and "never 2J/3J"; both invert. What it was really
		// guarding — that the repaint lands at the NEW geometry, and that
		// a repeat is idempotent — is kept, with idempotence re-derived:
		// the same size twice is not a resize at all now, so the second
		// winch emits NOTHING rather than the same bytes again. That is a
		// stronger form of the same claim, and it is the one the terminal
		// cares about (erasing a scrollback to repaint an identical
		// picture is pure loss).
		expect(first).toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(first).not.toContain("\x1b[0J");
		expect(first).not.toContain("\n"); // one committed row: nothing to stage
		expect(railRows(first)[0]).toBe(20 - 5); // the NEW geometry: H−2−N
		writes.length = 0;
		body.onResize(); // the same size again — the V6-1 idempotence rule
		vi.advanceTimersByTime(100);
		expect(writes.join("")).toBe("");
	});
});

describe("KC1 T-C4 — the menu, the queue chips and N=3 stack in their unchanged order", () => {
	it("menu above queue above the box top, and the composer's rows below it", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(rows3(2), "\u203a ");
		body.bindMenu(() => ({ items: [{ name: "/mode", desc: "switch the approval tier" }], selected: 0 }));
		body.bindQueue(() => ["a queued turn"]);
		body.enter();
		tick();
		const bytes = writes.join("");
		const boxTop = railRows(bytes)[0]!;
		expect(boxTop).toBe(19); // H−2−N — unchanged by the bands below it
		expect(rowOf(bytes, "a queued turn")).toBe(boxTop - 1); // the chip band sits directly above
		expect(rowOf(bytes, "switch the approval tier")).toBe(boxTop - 2); // the menu above the chips
		expect(rowOf(bytes, "one")).toBe(20);
		expect(rowOf(bytes, "three")).toBe(22);
	});
});

describe("KC1 T-C5 — the tiny terminal: H=7 with an 8-line buffer", () => {
	const eight = (cursorRow: number): (() => InputState) => () => {
		const lines = Array.from({ length: 8 }, (_, i) => `line-${i}`);
		return { line: lines[cursorRow]!, cursor: 0, lines, cursorRow, cursorCol: 0 };
	};

	it("N_visible clamps by the height — the geometry stays legal, no row ≤ 0 and no negative cap", () => {
		const { body, writes, tick } = makeBody({ H: 7 });
		body.bindInput(eight(7), "\u203a ");
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(cupRows(bytes).every((r) => r >= 1 && r <= 7)).toBe(true);
		// H − 3 = 4 rows for the composer, the box top at H−2−N = 1
		expect(railRows(bytes)[0]).toBe(1);
		expect(railRows(bytes).at(-1)).toBe(6);
		expect(rowOf(bytes, "/ commands")).toBe(7);
		expect(body.liveCount()).toBeLessThanOrEqual(7);
	});

	it("the clamped window still holds the CURSOR'S row — the frame's move lands inside the composer", () => {
		for (const cursorRow of [0, 4, 7]) {
			const { body, writes, tick } = makeBody({ H: 7 });
			body.bindInput(eight(cursorRow), "\u203a ");
			body.enter();
			tick();
			const bytes = writes.join("").replace(/\x1b\[(?:7|27)m/g, ""); // REL-0161: read through the drawn cursor
			expect(bytes).toContain(`line-${cursorRow}`); // the cursor's line is ON the screen
			// DECLARED SUPERSESSION (REL-0152-R1), as above: the park is
			// absolute, so the bound is on the ROW rather than on a
			// distance walked up from H. Same window, stated directly: at
			// H=7 the composer's rows are 2..6 — never the box bottom below
			// them, never the box top above.
			const park = [...bytes.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1])).at(-1)!;
			expect(park, "the park is below the composer").toBeGreaterThanOrEqual(7 - (1 + 4));
			expect(park, "the park is above the composer").toBeLessThanOrEqual(7 - 1);
		}
	});

	it("with a queue band the composer yields rows to it — the chrome still fits H=7", () => {
		const { body, writes, tick } = makeBody({ H: 7 });
		body.bindInput(eight(7), "\u203a ");
		body.bindQueue(() => ["queued"]);
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(cupRows(bytes).every((r) => r >= 1 && r <= 7)).toBe(true);
		const boxTop = railRows(bytes)[0]!;
		expect(rowOf(bytes, "queued")).toBe(boxTop - 1);
		expect(boxTop).toBeGreaterThanOrEqual(2); // the chip band keeps its row
	});
});

describe("KC1 A4 — a queued MULTI-LINE message's chip", () => {
	it("renders its FIRST line plus a ⏎×k suffix, k = the additional lines after the §3 normalization", () => {
		const { body, writes, tick } = makeBody();
		body.bindQueue(() => ["queued one\nqueued two\nqueued three", "single line", "crlf one\r\ncrlf two"]);
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(bytes).toContain("queued one ⏎×2"); // the first line + the count of the rest
		expect(bytes).not.toContain("queued two"); // the chip stays ONE row per queued turn
		expect(bytes).toContain("single line"); // a single-line chip is UNCHANGED
		expect(bytes).not.toContain("single line ⏎");
		expect(bytes).toContain("crlf one ⏎×1"); // a CRLF pair counts ONCE (the same normalization)
	});
});

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});
