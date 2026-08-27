/**
 * TUI2-R2 slice ② — A, the resume picker's surface and its keys.
 *
 * The picker is the @ picker's muscle aimed at a different list: a band
 * that names itself, full-row reverse selection, filter-as-you-type,
 * ↑↓ to walk, ⏎ to take, esc to leave. Everything the user already
 * learned at the `@` transfers, which is the argument for building it
 * this way rather than inventing a second interaction.
 *
 * What is NEW is the row: a durability badge per session. The gate
 * below pins the four badges on one screen (the prototype's A-1 frame),
 * the column stability under filtering, and the ONE thing a picker must
 * never do — move the row under the cursor for a reason the user did
 * not cause.
 *
 * The declared PICKER-SURFACE class: every assertion here is about
 * frames that did not exist before this round. Nothing is moved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor.js";
import { Body } from "../src/compositor.js";
import { idColumn, sessionFilter, sessionListFooter, sessionListRow, sessionPickerRows, sessionRow, type SessionCardView } from "../src/session-picker.js";
import { visibleWidth } from "../src/components.js";
import { COLOR_ON } from "../src/render.js";

const enc = (s: string) => new TextEncoder().encode(s);
const NOW = 1_000_000_000_000;
const H = (hours: number): number => NOW - hours * 3600_000;
const D = (days: number): number => NOW - days * 86400_000;

/** The prototype's A-1 frame, as data: four badges on one screen. */
const CARDS: SessionCardView[] = [
	{ id: "tui2-dogfood", badge: "interrupted", turns: 8, updatedAt: H(1), uncertain: 0, asks: 0, outcome: null },
	{ id: "fix-auth-race", badge: "completed", turns: 14, updatedAt: H(2), uncertain: 0, asks: 0, outcome: "completed" },
	{ id: "bench-refactor", badge: "uncertain", turns: 21, updatedAt: D(3), uncertain: 1, asks: 0, outcome: null },
	{ id: "release-notes", badge: "ask", turns: 3, updatedAt: D(5), uncertain: 0, asks: 1, outcome: null },
	{ id: "wrapper-probe", badge: "completed", turns: 2, updatedAt: D(6), uncertain: 0, asks: 0, outcome: "completed" },
];

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

beforeEach(() => {
	delete process.env.NO_COLOR;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("TUI2-R2 ② — the picker band (the picker-surface class)", () => {
	it("the band NAMES itself `sessions`, carries a row per card and the counter — the prototype's A-1 frame", () => {
		const rows = sessionPickerRows({ cards: CARDS, matches: CARDS, selected: 0 }, 80, NOW);
		expect(strip(rows[0]!)).toMatch(/^\u2500{3} sessions \u2500+$/); // R2: the label rides the rule
		expect(rows).toHaveLength(1 + 5 + 1); // header + the five rows + the counter
		expect(strip(rows.at(-1)!)).toBe("  (1/5)");
		const body = rows.slice(1, -1).map(strip);
		expect(body[0]).toContain("▌ tui2-dogfood");
		expect(body[0]).toContain("1h · 8 turns · interrupted mid-run — resumes exactly");
		expect(body[1]).toContain("✓ fix-auth-race");
		expect(body[1]).toContain("2h · 14 turns · completed clean");
		expect(body[2]).toContain("? bench-refactor");
		expect(body[2]).toContain("3d · 21 turns · 1 uncertain — needs your verdict");
		expect(body[3]).toContain("◌ release-notes");
		expect(body[3]).toContain("5d · 3 turns · 1 ask pending");
		expect(body[4]).toContain("✓ wrapper-probe");
	});

	it("the four badges wear the functional set and NOTHING else — ✓ green, ✗ red, ▌ bold, ? warn, ◌ dim", () => {
		const rows = sessionPickerRows({ cards: CARDS, matches: CARDS, selected: 99 }, 80, NOW).slice(1, -1);
		expect(rows[0]).toContain(`${COLOR_ON.bold}▌${COLOR_ON.reset}`);
		expect(rows[1]).toContain(`${COLOR_ON.green}✓${COLOR_ON.reset}`);
		expect(rows[2]).toContain(`${COLOR_ON.warn}?${COLOR_ON.reset}`);
		expect(rows[3]).toContain(`${COLOR_ON.dim}◌${COLOR_ON.reset}`);
	});

	it("the selection is a FULL-ROW reverse bar spanning the whole width (the R1.5 ⑧ shape), and exactly one row wears it", () => {
		const W = 80;
		const rows = sessionPickerRows({ cards: CARDS, matches: CARDS, selected: 0 }, W, NOW).slice(1, -1);
		expect(rows[0]!.startsWith(COLOR_ON.rv)).toBe(true);
		expect(rows[0]!.endsWith(COLOR_ON.rvEnd)).toBe(true);
		expect(visibleWidth(rows[0]!)).toBe(W); // the bar spans the row, not two cells of it
		expect(rows.filter((r) => r.startsWith(COLOR_ON.rv))).toHaveLength(1);
		// the bar is never punctured: no SGR 0 survives without the bar
		// being re-opened right after it (the atRow composition rule)
		const inner = rows[0]!.slice(COLOR_ON.rv.length, -COLOR_ON.rvEnd.length);
		for (const m of inner.matchAll(/\x1b\[0m/g)) {
			expect(inner.slice(m.index! + 4, m.index! + 4 + COLOR_ON.rv.length)).toBe(COLOR_ON.rv);
		}
	});

	it("every row fits W — invariant ① can never fire from this band, at any width", () => {
		for (const W of [40, 60, 80, 100, 120]) {
			for (const sel of [0, 2, 4]) {
				for (const row of sessionPickerRows({ cards: CARDS, matches: CARDS, selected: sel }, W, NOW)) {
					expect(visibleWidth(row), `W=${W} sel=${sel}: ${JSON.stringify(strip(row))}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});

	it("the id COLUMN is computed over every card, not the filtered subset — the columns never jump while typing", () => {
		const col = idColumn(CARDS);
		const all = strip(sessionRow(CARDS[2]!, false, 80, NOW, col));
		const filtered = sessionFilter(CARDS, "ben");
		const one = strip(sessionRow(filtered[0]!, false, 80, NOW, idColumn(CARDS)));
		expect(one).toBe(all); // same card, same columns, filtered or not
	});

	it("the filter is the @ picker's subsequence + rank; an empty query is the LIST, not a search", () => {
		expect(sessionFilter(CARDS, "").map((c) => c.id)).toEqual(CARDS.map((c) => c.id)); // the caller's order survives
		expect(sessionFilter(CARDS, "ben").map((c) => c.id)).toEqual(["bench-refactor"]);
		expect(sessionFilter(CARDS, "BEN").map((c) => c.id)).toEqual(["bench-refactor"]); // case-insensitive
		expect(sessionFilter(CARDS, "zzz")).toEqual([]);
		// a contiguous run outranks a scattered subsequence, always
		expect(sessionFilter(CARDS, "re").map((c) => c.id)[0]).toBe("release-notes");
	});

	it("an empty match set says so and counts (0/0) — never a confident row that is not there", () => {
		const rows = sessionPickerRows({ cards: CARDS, matches: [], selected: 0 }, 80, NOW);
		expect(strip(rows[1]!)).toContain("no session matches");
		expect(strip(rows.at(-1)!)).toBe("  (0/0)");
	});

	it("slice ③'s printed row is the SAME projection with no bar and no indent — one definition, two surfaces", () => {
		const col = idColumn(CARDS);
		// DC-16: the listing keeps the ID and the picker row does not. The
		// SHARED projection is still the point — the two cannot drift about
		// what a session IS — but "share the projection" is not "be the
		// same row": a listing is the surface you read to copy an id OUT
		// of, which `/resume <id>` and the filter's id haystack both
		// assume exists. So the printed row is the picker's row plus a dim
		// id tail, and that is what is asserted.
		// The id tail takes its width FROM the row, so the shared projection
		// is asserted at the budget it actually gets: the printed row at W
		// is the picker's row at W minus the tail, plus the tail.
		const tailW = 2 + CARDS[0]!.id.length;
		const listed = strip(sessionListRow(CARDS[0]!, 80, NOW, col));
		const picked = strip(sessionRow(CARDS[0]!, false, 80 - tailW + 2, NOW, col)).slice(2);
		expect(listed).toBe(`${picked}  ${CARDS[0]!.id}`);
		expect(strip(sessionListFooter(7, 80))).toBe("7 sessions · kiso resume picks interactively");
		expect(strip(sessionListFooter(1, 80))).toBe("1 session · kiso resume picks interactively");
	});
});

describe("TUI2-R2 ② — the picker's KEYS (the editor's third band occupant)", () => {
	it("↑↓ walk the SELECTION (never the composer's line, never the history), and clamp at both ends", () => {
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {});
		expect(editor.pickState()!.selected).toBe(0);
		editor.feed(enc("\x1b[B"));
		expect(editor.pickState()!.selected).toBe(1);
		editor.feed(enc("\x1b[A"));
		editor.feed(enc("\x1b[A")); // past the top — stays
		expect(editor.pickState()!.selected).toBe(0);
		for (let i = 0; i < 10; i += 1) editor.feed(enc("\x1b[B"));
		expect(editor.pickState()!.selected).toBe(CARDS.length - 1);
		expect(editor.line()).toBe(""); // the walk never touched the buffer
	});

	it("typing FILTERS — the buffer is the query, and the selection clamps into the shorter list", () => {
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {});
		editor.feed(enc("\x1b[B\x1b[B\x1b[B")); // selection 3
		editor.feed(enc("ben"));
		const st = editor.pickState()!;
		expect(editor.line()).toBe("ben");
		expect(st.matches.map((c) => c.id)).toEqual(["bench-refactor"]);
		expect(st.selected).toBe(0); // clamped — never a selection past the end
	});

	it("⏎ takes the SELECTED session's id — the picker closes and the id goes to the caller", () => {
		let picked: string | null | undefined;
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, (id) => {
			picked = id;
		});
		editor.feed(enc("\x1b[B")); // fix-auth-race
		editor.feed(enc("\r"));
		expect(picked).toBe("fix-auth-race");
		expect(editor.pickState()).toBeNull(); // closed
	});

	it("⏎ on an EMPTY match set takes nothing — the picker stays up rather than inventing a pick", () => {
		let calls = 0;
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {
			calls += 1;
		});
		editor.feed(enc("zzzz\r"));
		expect(calls).toBe(0);
		expect(editor.pickState()).not.toBeNull();
	});

	it("esc leaves with NOTHING picked — the caller learns null and exits 0", () => {
		let picked: string | null | undefined = "unset";
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, (id) => {
			picked = id;
		});
		editor.feed(enc("\x1b"));
		expect(picked).toBeNull();
		expect(editor.pickState()).toBeNull();
	});

	it("the picker owns `?` and `@` while it is up — no keys sheet, no file picker inside a session filter", () => {
		const editor = new Editor(() => {});
		editor.bindAtItems(() => [{ path: "src/parser.ts" }]);
		editor.beginPick(() => CARDS, () => {});
		editor.feed(enc("?"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("?"); // it is a character in a query, nothing more
		editor.feed(enc("@"));
		expect(editor.atState()).toBeNull();
	});

	it("the compositor renders the picker in the band above the composer — the menu's channel, the picker's rows", () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {});
		const body = new Body({ active: () => true, height: () => 24, width: () => 100, editCol: () => 1, write: (s) => writes.push(s) });
		body.bindInput(() => editor.dockState(), "\u203a ");
		body.bindPick(() => editor.pickState());
		body.enter();
		vi.advanceTimersByTime(16);
		const bytes = strip(writes.join(""));
		expect(bytes).toContain("sessions");
		expect(bytes).toContain("tui2-dogfood");
		expect(bytes).toContain("(1/5)");
		vi.useRealTimers();
	});
});

/**
 * DC-13 — the filter searches what the ROW SHOWS.
 *
 * The id left the row this round (the owner's ruling: title only). The
 * filter kept searching the id alone, which is the worst kind of search:
 * typing what you can SEE returns nothing, and typing an id you cannot
 * see narrows the list for a reason the screen never explains.
 */
describe("DC-13 — the filter searches the title, and still accepts an id", () => {
	const TITLED: SessionCardView[] = [
		{ id: "a1b2c3", title: "refactor the bench harness", badge: "completed", turns: 3, updatedAt: NOW, uncertain: 0, asks: 0, outcome: "completed" },
		{ id: "d4e5f6", title: "dogfood the tui", badge: "interrupted", turns: 2, updatedAt: NOW, uncertain: 0, asks: 0, outcome: null },
	];

	it("matches on the TITLE — the text the row actually carries", () => {
		expect(sessionFilter(TITLED, "bench").map((c) => c.id)).toEqual(["a1b2c3"]);
		expect(sessionFilter(TITLED, "dogfood").map((c) => c.id)).toEqual(["d4e5f6"]);
	});

	it("still matches on the ID — `kiso sessions` prints ids, and a pasted one must work", () => {
		expect(sessionFilter(TITLED, "d4e5").map((c) => c.id)).toEqual(["d4e5f6"]);
	});

	it("a TITLE hit outranks an id hit at the same run length — the title is what was being read", () => {
		const both: SessionCardView[] = [
			{ ...TITLED[0]!, id: "zzdog", title: "unrelated words" },
			{ ...TITLED[1]!, id: "qqqqqq", title: "dog walking notes" },
		];
		expect(sessionFilter(both, "dog")[0]!.id).toBe("qqqqqq");
	});

	it("a card with no title at all falls back to its id, in the filter as on the row", () => {
		const untitled: SessionCardView[] = [{ id: "wrapper-probe", badge: "completed", turns: 1, updatedAt: NOW, uncertain: 0, asks: 0, outcome: "completed" }];
		expect(sessionFilter(untitled, "wrap")).toHaveLength(1);
	});

	it("an empty query is not a search — it is the list, in the caller's order", () => {
		expect(sessionFilter(TITLED, "").map((c) => c.id)).toEqual(["a1b2c3", "d4e5f6"]);
	});
});
