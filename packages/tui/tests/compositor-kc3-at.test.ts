/**
 * KC3 T-A3 — the @ panel's FRAME.
 *
 * The picker rides the menu-rows band, which is what makes its
 * geometry free: chromeRows already counts that band, the content cap
 * already shrinks by it, the box top already rises above it. These
 * tests prove that it really is the same band (the rows land exactly
 * where the slash menu's do), that the two columns and the selection
 * band render as drawn, that the counter tells the truth about the
 * whole list rather than the visible window, and that the window
 * trails the selection past five matches.
 *
 * The last describe is the anchor that matters most: with NO picker
 * bound — every scenario that is not an @ scenario — the frame is
 * BYTE-IDENTICAL to the same frame built without any of this code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body, type InputState } from "../src/compositor.js";
import { atFilter, atPanelRows } from "../src/at-picker.js";

const one = (line: string): (() => InputState) => () => ({ line, cursor: line.length });

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
}

/** the @ state the editor would hand over, built through the REAL
 *  filter so the rank/highlight under test is the shipped one */
const atState = (paths: string[], query: string, selected = 0, capped = false) => {
	const { matches } = atFilter(
		paths.map((path) => ({ path })),
		query,
	);
	return () => ({ matches, selected, capped });
};

/** Matched characters are individually wrapped in SGR spans, so a path
 *  is NEVER a contiguous substring of the frame. Every text assertion
 *  below reads the stripped row instead. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** every CUP-addressed row the frame wrote, as { row, text } with the
 *  SGR removed — the frame's visible ground truth */
const rowsOf = (bytes: string): { row: number; text: string }[] =>
	[...bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)].map((m) => ({ row: Number(m[1]), text: strip(m[2]!) }));

const rowOf = (bytes: string, needle: string): number | undefined => rowsOf(bytes).find((r) => r.text.includes(needle))?.row;

const FILES = ["src/range.js", "src/ranger.ts", "docs/range-notes.md", "lib/range.ts", "a/range.js", "z/range.js", "q/range.js"];

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.NO_COLOR; // the palette must be ON — these assert SGR bytes
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

describe("KC3 T-A3: the panel rides the menu-rows band", () => {
	it("the rows STACK ABOVE the box top; the box, the input row and the status never move", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("look at @ra"), "\u203a ");
		body.bindAt(atState(["src/range.js", "lib/range.ts"], "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		// the band is the MENU's band: it grows upward from the box top,
		// which is exactly why the picker inherits the geometry for free
		// R2: both rails are the same rule, so they are found by ORDER —
		// rowOf returns the first, and the bottom is the last. The BAND's
		// header is a dashed rule too now, so the match demands an
		// UNBROKEN run to the reset — a labelled rule is the band, not
		// the box.
		const rails = [...bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K\x1b\[2m\u254c+\x1b\[0m/g)].map((m) => Number(m[1]));
		expect(rails[0]).toBe(21); // H−3, unmoved
		expect(rails.at(-1)).toBe(23);
		expect(rowOf(bytes, "/ commands")).toBe(24);
		// two matches + the counter = three rows, immediately above the box
		expect(rowOf(bytes, "range.ts")).toBe(18);
		expect(rowOf(bytes, "range.js")).toBe(19);
		expect(rowOf(bytes, "(1/2)")).toBe(20);
	});

	it("the band shrinks the live content cap, exactly as the menu's does", () => {
		const { body, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(FILES, "ra"));
		body.enter();
		// MOVED ASSERTION, the markdown-render class (TUI2-MD ⑤): the fixture
		// gains its list markers. Assistant body text is markdown now, and N
		// consecutive PROSE lines are ONE paragraph that REFLOWS — so the old
		// fixture no longer produces N rows, which is what this test needs. A
		// list is the same shape in the new model: one open block, one row per
		// item, no reflow. The assertions themselves are unchanged.
		body.textAppend(Array.from({ length: 40 }, (_, i) => `- tall ${i}`).join("\n"));
		tick();
		// chrome = 3 + 1 input + 6 band rows (5 windowed + counter)
		expect(body.liveCount()).toBeLessThanOrEqual(24 - 3 - 1 - 6);
	});

	it("the picker WINS the shared band — a menu bound at the same time never renders", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindMenu(() => ({ items: [{ name: "/mode", desc: "switch the approval tier" }], selected: 0 }));
		body.bindAt(atState(["src/range.js"], "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(rowOf(bytes, "range.js")).toBeDefined();
		expect(strip(bytes)).not.toContain("/mode");
	});
});

describe("KC3 T-A3: the two columns and the selection band", () => {
	it("the NAME is left, the DIRECTORY dim on the right", () => {
		const { body, writes, tick } = makeBody({ W: 40 });
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		const row = rowsOf(bytes).find((r) => r.text.includes("range.js"))!.text;
		// MOVED (R1.5 slice 8, the picker-row class — DECLARED THIS ROUND):
		// the directory is ADJACENT to the name, not pushed to the far edge
		// (VD-9). On a 100-column terminal the old layout put `src/` some
		// eighty columns from the `parser.ts` it qualifies, and the eye had
		// to cross the row to read one fact. Still after the name, still
		// dim — only the distance changed.
		expect(row.indexOf("range.js")).toBeLessThan(row.indexOf("src/"));
		expect(row).toContain("range.js  \u2014 src/");
		// DECLARED SUPERSESSION (R2, design §2.1 — nothing dim ever sits on
		// the wash): the qualifier is still dim on an UNSELECTED row and no
		// longer dim inside the selection bar, where grey-on-grey is 3.91:1
		// on the light ground. So the byte assertion moves to the row that
		// is not the cursor's, and the selected row is asserted for what it
		// must NOT contain.
		expect(bytes).not.toContain("\x1b[7m\x1b[2m"); // never dim ON the bar
		const un = atPanelRows(atState(["src/range.js", "lib/range.ts"], "ra")(), 40);
		expect(un.find((r) => !r.startsWith("\x1b[7m") && r.includes("\u2014"))).toContain("\x1b[2m  \u2014 src/\x1b[0m"); // an unselected row keeps it
	});

	it("the MATCHED characters of the name are bold, the rest are not", () => {
		const { body, writes, tick } = makeBody({ W: 40 });
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		// "ra" of "range.js" — the two matched chars each wrapped in bold.
		// MOVED (R1.5 slice 8, the picker-row class): the SELECTED row is a
		// full-width inverse bar now, and a bold span inside it closes with
		// SGR 0, which would punch a hole in the bar — so the bar re-opens
		// after each inner span. The bolding itself is unchanged, and the
		// unselected row's bytes are exactly what they were.
		expect(bytes).toContain("\x1b[1mr\x1b[0m\x1b[7m\x1b[1ma\x1b[0m\x1b[7mnge.js");
	});

	it("a hit that lands in the DIRECTORY is not emboldened — that column is uniformly quiet", () => {
		const { body, writes, tick } = makeBody({ W: 40 });
		body.bindInput(one("@do"), "\u203a ");
		body.bindAt(atState(["docs/range-notes.md"], "do"));
		body.enter();
		tick();
		const bytes = writes.join("");
		// MOVED (same class): the qualifier now rides beside the name.
		// R2 (§2.1): dim is dropped inside the bar, so the SPAN is asserted
		// whole and unbroken rather than dim — bolding is what this case is
		// about, and the row still must not embolden the directory.
		expect(bytes).toContain("  \u2014 docs/\x1b[0m"); // whole, unbroken
		expect(bytes).not.toContain("\x1b[1mdo\x1b[0m\x1b[7mcs/"); // never emboldened
	});

	// MOVED (R1.5 slice 8, the picker-row class — DECLARED THIS ROUND): the
	// selection is a FULL-ROW bar rather than a two-cell marker. The old
	// marker was one character of highlight in an eighty-column row and the
	// walkthrough could barely find it (VD-9); the bar is the W16 chip
	// mechanism the user chip already uses. Mono discipline holds — reverse
	// video, no new colour. "Exactly one band per frame" is unchanged and
	// still asserted.
	it("the SELECTED row is a full-width inverse bar; the others carry two spaces", () => {
		const { body, writes, tick } = makeBody({ W: 40 });
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["a/range.js", "z/range.js"], "ra", 1));
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(bytes).toContain("\x1b[7m ");
		expect(bytes).toContain("\x1b[27m");
		// exactly ONE selection band — plus the composer's drawn cursor
		// (REL-0161), which also closes with a 27m
		expect(bytes.split("\x1b[27m").length - 1).toBe(2);
	});

	it("a path with no directory renders name-only — no empty right column", () => {
		const { body, writes, tick } = makeBody({ W: 40 });
		body.bindInput(one("@re"), "\u203a ");
		body.bindAt(atState(["README.md"], "re"));
		body.enter();
		tick();
		expect(writes.join("")).toContain("ADME.md");
	});
});

describe("KC3 T-A3: the counter and the windowing", () => {
	it("the counter reports the selection's place in the WHOLE list, not the window", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(FILES, "ra", 6));
		body.enter();
		tick();
		expect(writes.join("")).toContain("(7/7)");
	});

	it("at most FIVE match rows render however many match", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(FILES, "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		const band = rowsOf(bytes).filter((r) => r.text.includes("range") || r.text.includes("(1/7)"));
		expect(band.length).toBe(6); // 5 matches + the counter, out of 7 that match
	});

	it("the window TRAILS the selection — selecting the last match scrolls it into view", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		const { matches } = atFilter(
			FILES.map((path) => ({ path })),
			"ra",
		);
		body.bindAt(() => ({ matches, selected: matches.length - 1, capped: false }));
		body.enter();
		tick();
		const bytes = writes.join("");
		expect(rowOf(bytes, `(${matches.length}/${matches.length})`)).toBeDefined();
		// a row identifies a match by BOTH its columns — several of these
		// fixtures share the basename "range.js", so the directory is what
		// tells them apart (which is the whole reason the column exists)
		const shows = (path: string): boolean => {
			const cut = path.lastIndexOf("/");
			const [dir, name] = [path.slice(0, cut + 1), path.slice(cut + 1)];
			return rowsOf(bytes).some((r) => r.text.includes(name) && r.text.includes(dir));
		};
		expect(shows(matches[matches.length - 1]!.path)).toBe(true); // the last is on screen
		expect(shows(matches[0]!.path)).toBe(false); // the first has scrolled off
	});

	it("a CAPPED source says so in the counter — the horizon is admitted, never hidden", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra", 0, true));
		body.enter();
		tick();
		expect(writes.join("")).toContain("first 2000 files only");
	});

	it("an UNCAPPED source says nothing about a cap", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra"));
		body.enter();
		tick();
		expect(writes.join("")).not.toContain("first 2000 files only");
	});

	it("every band row fits the width — the #checked invariant holds at a narrow terminal", () => {
		for (const W of [24, 40, 80, 120]) {
			const { body, tick } = makeBody({ W });
			body.bindInput(one("@ra"), "\u203a ");
			body.bindAt(atState([...FILES, "vendor/deeply/nested/copy/of/range.js"], "ra", 3));
			body.enter();
			// #checked throws on any row wider than W — reaching here is the assertion
			expect(() => tick()).not.toThrow();
		}
	});
});

describe("KC3 T-A3: N=1 byte identity on every non-@ scenario", () => {
	/** the same frame, built twice: once with no picker bound at all,
	 *  once with a picker bound that reports itself CLOSED */
	const frame = (bind: (b: Body) => void): string => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("hello world"), "\u203a ");
		bind(body);
		body.enter();
		body.textAppend("a line of body text");
		tick();
		return writes.join("");
	};

	it("no picker bound → the frame is what it was before KC3", () => {
		const bytes = frame(() => {});
		expect(bytes.length).toBeGreaterThan(100); // the comparison is not two empty strings
		expect(bytes).toBe(frame((b) => b.bindAt(() => null)));
	});

	it("a CLOSED picker adds not one byte — the menu band is empty exactly as before", () => {
		const withMenu = (b: Body) => b.bindMenu(() => null);
		expect(frame(withMenu)).toBe(
			frame((b) => {
				withMenu(b);
				b.bindAt(() => null);
			}),
		);
	});

	it("the slash MENU still renders untouched while a closed picker is bound", () => {
		const menu = (b: Body) => b.bindMenu(() => ({ items: [{ name: "/mode", desc: "switch the approval tier" }], selected: 0 }));
		expect(frame(menu)).toBe(
			frame((b) => {
				menu(b);
				b.bindAt(() => null);
			}),
		);
		expect(frame(menu)).toContain("/mode");
	});
});
