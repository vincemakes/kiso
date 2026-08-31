/**
 * R5 — THE TRANSCRIPT VIEWER (the pure layer).
 *
 * Written before the wiring, per the charter's process.
 *
 * What this surface exists for, stated once so the gates can be read
 * against it: a COMMITTED row cannot be marked, because kiso never
 * repaints it. So "which fold am I about to open" cannot be answered in
 * the live stream at all — not by an ordinal (R4a retired that), not by
 * a tint, and not by a pointer. It can only be answered on a surface
 * kiso repaints. This is that surface, and a keyboard cursor answers it
 * completely: no mouse, and therefore no drag-to-copy tax.
 */

import { describe, expect, it } from "vitest";
import {
	VIEWER_GUTTER,
	viewerFlat,
	viewerHint,
	viewerInit,
	viewerMove,
	viewerRows,
	viewerScroll,
	viewerTitle,
	viewerToggle,
	viewerToggleAll,
	type ViewerEntry,
} from "../src/transcript.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const entry = (n: number, bodyRows = 3): ViewerEntry => ({
	head: `✦ thought ${n}s · read ${n} files`,
	body: Array.from({ length: bodyRows }, (_, i) => `  read f${n}-${i}.ts (0.0s)`),
});
const ENTRIES = [entry(1), entry(2), entry(3), entry(4)];

describe("R5 A — the cursor is the answer to “which one”", () => {
	it("starts on the NEWEST fold — the one ctrl+r would have opened", () => {
		expect(viewerInit(ENTRIES).cursor).toBe(ENTRIES.length - 1);
	});

	it("↑↓ move it, and it never leaves the list", () => {
		let s = viewerInit(ENTRIES);
		s = viewerMove(ENTRIES, s, -1, 10);
		expect(s.cursor).toBe(2);
		s = viewerMove(ENTRIES, s, -99, 10);
		expect(s.cursor).toBe(0); // clamped, not wrapped
		s = viewerMove(ENTRIES, s, +99, 10);
		expect(s.cursor).toBe(ENTRIES.length - 1);
	});

	it("exactly ONE row wears the cursor, and it is the cursor's head", () => {
		const s = viewerMove(ENTRIES, viewerInit(ENTRIES), -2, 10);
		const rows = viewerRows(ENTRIES, s, 80, 10);
		const marked = rows.filter((r) => plain(r).startsWith(" ▸") || plain(r).startsWith(" ▾"));
		expect(marked).toHaveLength(1);
		expect(plain(marked[0]!)).toContain("read 2 files");
	});
});

describe("R5 B — expanding is VIEWER-LOCAL and in place", () => {
	it("⏎ opens the entry under the cursor, and its body lands under its head", () => {
		const s = viewerToggle(ENTRIES, viewerInit(ENTRIES), 20);
		const flat = viewerFlat(ENTRIES, s);
		const headAt = flat.findIndex((r) => r.head && r.entry === 3);
		expect(flat[headAt + 1]).toMatchObject({ entry: 3, head: false });
		expect(flat.filter((r) => r.entry === 3 && !r.head)).toHaveLength(3);
	});

	it("⏎ again collapses it", () => {
		let s = viewerToggle(ENTRIES, viewerInit(ENTRIES), 20);
		expect(s.open.has(3)).toBe(true);
		s = viewerToggle(ENTRIES, s, 20);
		expect(s.open.has(3)).toBe(false);
	});

	it("`a` opens every entry, and `a` again closes every entry", () => {
		let s = viewerToggleAll(ENTRIES, viewerInit(ENTRIES), 40);
		expect([...s.open].sort()).toEqual([0, 1, 2, 3]);
		s = viewerToggleAll(ENTRIES, s, 40);
		expect(s.open.size).toBe(0);
	});

	it("the state is a SET of viewer indices — no cell is named, let alone mutated", () => {
		// The compositor recomputes #committedLines from cell renders on
		// every full redraw and feeds it to the scroll floor, so a viewer
		// that expanded a committed CELL would corrupt the window
		// arithmetic for the rest of the session. The type makes that
		// impossible: the viewer only ever holds indices into its own
		// entry list.
		const s = viewerToggle(ENTRIES, viewerInit(ENTRIES), 20);
		for (const i of s.open) expect(typeof i).toBe("number");
		expect(Object.isFrozen(ENTRIES[3])).toBe(false); // (the entries are plain data...)
		expect(ENTRIES[3]!.head).toBe("✦ thought 4s · read 4 files"); // ...and untouched
	});
});

describe("R5 C — the cursor stays visible", () => {
	it("moving above the window scrolls to it", () => {
		let s = { ...viewerInit(ENTRIES), top: 3 };
		s = viewerMove(ENTRIES, s, -3, 2);
		expect(s.top).toBeLessThanOrEqual(s.cursor);
	});

	it("with everything open, the cursor's head is inside the window", () => {
		const rowsN = 5;
		let s = viewerToggleAll(ENTRIES, viewerInit(ENTRIES), rowsN);
		for (let i = 0; i < ENTRIES.length; i += 1) {
			s = viewerMove(ENTRIES, s, -1, rowsN);
			const flat = viewerFlat(ENTRIES, s);
			const at = flat.findIndex((r) => r.head && r.entry === s.cursor);
			expect(at).toBeGreaterThanOrEqual(s.top);
			expect(at).toBeLessThan(s.top + rowsN);
		}
	});

	it("scrolling never runs off either end", () => {
		const s = viewerInit(ENTRIES);
		expect(viewerScroll(ENTRIES, s, -99, 3).top).toBe(0);
		const flat = viewerFlat(ENTRIES, s).length;
		expect(viewerScroll(ENTRIES, s, +99, 3).top).toBe(Math.max(0, flat - 3));
	});
});

describe("R5 D — invariant ① holds on every viewer row", () => {
	it("every row is ONE row, no wider than W, at every width from 40 to 120", () => {
		const long: ViewerEntry[] = [
			{
				head: "✦ thought 43s · read 14 files · listed 5 directories · ran 11 searches · edited 2 files",
				body: ["  read packages/tui/src/compositor.ts (0.3s) · 3120 lines · ctrl+r expands", "  ran npm run check --workspaces --if-present (exit 0, 91.2s)"],
			},
		];
		for (let W = 40; W <= 120; W += 1) {
			const s = viewerToggle(long, viewerInit(long), 10);
			for (const row of viewerRows(long, s, W, 10)) {
				expect(plain(row).length, `W=${W}`).toBeLessThanOrEqual(W);
				expect(row, `W=${W}`).not.toMatch(/[\n\r]/);
			}
		}
	});

	it("the window never yields more rows than it was given", () => {
		const s = viewerToggleAll(ENTRIES, viewerInit(ENTRIES), 4);
		expect(viewerRows(ENTRIES, s, 80, 4)).toHaveLength(4);
	});

	it("the gutter is reserved, so an entry rendered at W−3 can never overflow", () => {
		expect(VIEWER_GUTTER).toBe(3);
		const wide: ViewerEntry[] = [{ head: "x".repeat(80 - VIEWER_GUTTER), body: [] }];
		for (const row of viewerRows(wide, viewerInit(wide), 80, 5)) expect(plain(row).length).toBeLessThanOrEqual(80);
	});
});

describe("R5 E — the state survives the palette being off (law 1.3)", () => {
	it("the MARKS carry open/closed, not the colour", () => {
		const s = viewerToggle(ENTRIES, viewerInit(ENTRIES), 20);
		const rows = viewerRows(ENTRIES, s, 80, 20).map(plain);
		expect(rows.some((r) => r.startsWith(" ▾"))).toBe(true); // the open one
		expect(rows.some((r) => r.trimStart().startsWith("│"))).toBe(true); // its body
		const closed = viewerRows(ENTRIES, viewerInit(ENTRIES), 80, 20).map(plain);
		expect(closed.some((r) => r.startsWith(" ▸"))).toBe(true);
		expect(closed.some((r) => r.trimStart().startsWith("│"))).toBe(false);
	});

	it("an OPEN entry keeps its ▾ after the cursor moves away", () => {
		// The first draft printed a blank for any head that was not under
		// the cursor, so an expanded entry stopped saying it was expanded
		// the moment you moved off it — the state lived in the cursor
		// rather than in the row. Caught by looking at the screen, not by
		// a gate, which is why this one exists.
		let s = viewerToggle(ENTRIES, viewerInit(ENTRIES), 20); // open the newest
		s = viewerMove(ENTRIES, s, -3, 20); // ...and walk away from it
		const rows = viewerRows(ENTRIES, s, 80, 20).map(plain);
		expect(rows.filter((r) => r.startsWith(" ▾"))).toHaveLength(1); // still open, still says so
		expect(rows.filter((r) => r.startsWith(" ▸"))).toHaveLength(1); // and the cursor is elsewhere
		expect(rows.findIndex((r) => r.startsWith(" ▸"))).toBeLessThan(rows.findIndex((r) => r.startsWith(" ▾")));
	});

	it("the hint says what ⏎ will do NOW, and the title counts the folds", () => {
		const shut = viewerInit(ENTRIES);
		expect(viewerHint(shut, ENTRIES)).toContain("⏎ expands");
		expect(viewerHint(viewerToggle(ENTRIES, shut, 20), ENTRIES)).toContain("⏎ collapses");
		expect(viewerTitle(ENTRIES)).toBe("transcript · 4 folds");
		expect(viewerTitle([entry(1)])).toBe("transcript · 1 fold");
	});
});

// ─── the wired surface ───────────────────────────────────────────────

import { afterEach, beforeEach, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";
import { viewerCommand } from "../src/editor.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 90;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const screen = (): string[] => {
		const s = new Screen(W, H);
		s.feed(writes.join(""));
		return s.rows.map((r) => r.join("").replace(/\s+$/, ""));
	};
	return { body, writes, screen, tick: () => vi.advanceTimersByTime(30) };
}
const stretch = (b: Body, i: number): void => {
	b.thinkingAppend(`thinking ${i}`);
	b.thinkingEnd();
	b.toolStart("read_file", `r${i}`, { path: `f${i}.ts` });
	b.toolRunning(`r${i}`);
	b.toolResult(`r${i}`, { content: "one\ntwo\nthree\nfour\nfive", isError: false });
	b.textAppend(`narrating ${i}.\n`);
	b.textEnd();
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("R5 F — ZERO LITTER (the blocker gate: this is what buys the primary screen)", () => {
	// FALSIFIABILITY NOTE, recorded because the first draft of this gate
	// was NOT falsifiable and passed with the overlay wiring deliberately
	// cut. Opening the viewer on a quiet session emits no LF whatever the
	// flag says — the band is capped to the content cap, so the live
	// region never grows and #emitScroll has nothing to scroll. The flag
	// earns its keep only when content COMMITS while the overlay is up:
	// that is what advances #committedLines, and #emitScroll's floor with
	// it. So the gate streams a turn into an open viewer, which is also
	// the case fable's trap (ii) names.
	const openAndStream = (H: number) => {
		const h = makeBody({ H });
		h.body.enter();
		h.body.userLine("x");
		for (let i = 0; i < 6; i += 1) stretch(h.body, i);
		h.body.endTurn(1);
		h.tick();
		h.body.viewerToggleMode();
		h.tick();
		h.writes.length = 0; // from here: only what happens WHILE it is up
		h.body.userLine("y");
		for (let i = 6; i < 12; i += 1) stretch(h.body, i);
		h.body.endTurn(1);
		h.tick();
		return h;
	};

	it("a turn that STREAMS while the viewer is open pushes nothing into the scrollback", () => {
		const h = openAndStream(14);
		// The LF at the last row IS the scroll mechanism. One of them is a
		// row gone into the terminal's scrollback, and the scrollback is
		// not ours to take back — which is the whole reason kiso can live
		// on the primary screen at all.
		expect(h.writes.join("")).not.toContain("\n");
	});

	it("...and the withheld rows are paid on CLOSE, not lost", () => {
		const h = openAndStream(14);
		const before = h.writes.join("");
		expect(before).not.toContain("\n");
		h.body.viewerToggleMode(); // close
		h.tick();
		const after = h.writes.join("").slice(before.length);
		// the turn that arrived while it was up is on screen now
		expect(h.screen().join("\n")).toContain("f11.ts");
		expect(after.length).toBeGreaterThan(0);
	});

	it("the screen returns to what it was when nothing happened meanwhile", () => {
		const { body, screen, tick } = makeBody({ H: 24 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		const before = screen();

		body.viewerToggleMode();
		tick();
		body.viewerKey("toggle");
		tick();
		expect(screen()).not.toEqual(before); // it really did take the region...

		body.viewerToggleMode();
		tick();
		expect(screen()).toEqual(before); // ...and gave every row back
	});
});

describe("R5 G — the viewer is the live region's occupant, and says so", () => {
	it("the band names itself and carries its keys", () => {
		const { body, screen, tick } = makeBody({ H: 24 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		body.viewerToggleMode();
		tick();
		const shown = screen().join("\n");
		expect(shown).toContain("transcript ·");
		expect(shown).toContain("↑↓ move");
		expect(shown).toContain("esc closes");
	});

	it("liveCount counts the viewer's rows — the scalar agrees with the screen", () => {
		const { body, tick } = makeBody({ H: 24 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 6; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		body.viewerToggleMode();
		tick();
		expect(body.liveCount()).toBeLessThanOrEqual(24);
		expect(body.viewerOpen()).toBe(true);
	});

	it("it lists the SAME set ctrl+r walks — one source of truth", () => {
		const { body, screen, tick } = makeBody({ H: 30 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		body.viewerToggleMode();
		tick();
		const shown = screen().join("\n");
		for (const i of [0, 1, 2]) expect(shown).toContain(`f${i}.ts`);
	});
});

describe("R5 H — the viewer never mutates a committed cell (fable's trap i)", () => {
	it("expanding in the viewer leaves liveCount and the committed geometry alone", () => {
		const { body, tick } = makeBody({ H: 30 });
		body.enter();
		body.userLine("x");
		for (let i = 0; i < 3; i += 1) stretch(body, i);
		body.endTurn(1);
		tick();
		const before = body.liveCount();

		body.viewerToggleMode();
		body.viewerKey("all"); // every entry open, in the viewer
		tick();
		body.viewerToggleMode(); // close
		tick();

		// If the viewer had expanded the CELLS, the committed line count
		// would have changed and with it the scroll floor — for the rest
		// of the session.
		expect(body.liveCount()).toBe(before);
	});
});

describe("R5 I — the key table", () => {
	it("maps the arrows, the vi keys, and both ways out", () => {
		expect(viewerCommand("\x1b[A")).toBe("up");
		expect(viewerCommand("k")).toBe("up");
		expect(viewerCommand("\x1b[B")).toBe("down");
		expect(viewerCommand("\r")).toBe("toggle");
		expect(viewerCommand(" ")).toBe("toggle");
		expect(viewerCommand("a")).toBe("all");
		expect(viewerCommand("\x1b")).toBe("close");
		expect(viewerCommand("q")).toBe("close");
		expect(viewerCommand("\x0f")).toBe("close"); // the key that opens it puts it away
	});

	it("anything unrecognised is SWALLOWED, never typed into the composer behind it", () => {
		for (const stray of ["z", "\x1b[Z", "hello", "\x03"]) expect(viewerCommand(stray)).toBeNull();
	});
});
