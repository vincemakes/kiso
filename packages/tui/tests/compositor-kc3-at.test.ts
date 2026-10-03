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
		const rails = [...bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K\x1b\[2m\u2500+\x1b\[0m/g)].map((m) => Number(m[1]));
		expect(rails[0]).toBe(21); // H−3, unmoved
		expect(rails.at(-1)).toBe(23);
		expect(rowOf(bytes, "/ commands")).toBe(24);
		// two matches + the counter = three rows, immediately above the box
		// MOVED (Graphite P2, the band-shape class — DECLARED): the counter
		// rides the KEY row's right edge now (`  ↑↓ move · tab inserts · esc
		// … 1/2`), the /resume shape; the band still grows upward from the
		// box top, its named hairline on top
		expect(rowOf(bytes, "files \u00b7 2")).toBe(17);
		expect(rowOf(bytes, "range.ts")).toBe(18);
		expect(rowOf(bytes, "range.js")).toBe(19);
		expect(rowOf(bytes, "tab inserts")).toBe(20);
		expect(rowsOf(bytes).find((r) => r.row === 20)!.text).toMatch(/ 1\/2$/);
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
		// chrome = 3 + 1 input + 7 band rows (the named hairline, 5 windowed,
		// the key row — Graphite P2)
		expect(body.liveCount()).toBeLessThanOrEqual(24 - 3 - 1 - 7);
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
		// DECLARED REVERSAL (Graphite P2, owner-approved 2026-10-03) of the
		// em dash: the folder is a COLUMN one gap after the widest name in
		// the list, so a long list reads as a table; never the far edge,
		// which was VD-9's complaint
		expect(row).toContain("range.js  src/");
		// DECLARED SUPERSESSION (R2, design §2.1 — nothing dim ever sits on
		// the wash): the qualifier is still dim on an UNSELECTED row and no
		// longer dim inside the selection bar, where grey-on-grey is 3.91:1
		// on the light ground. So the byte assertion moves to the row that
		// is not the cursor's, and the selected row is asserted for what it
		// must NOT contain.
		expect(bytes).not.toContain("\x1b[7m\x1b[2m"); // never dim ON the bar
		const un = atPanelRows(atState(["src/range.js", "lib/range.ts"], "ra")(), 40);
		expect(un.find((r) => !r.startsWith("\x1b[7m") && r.includes("src/"))).toContain("  \x1b[2msrc/\x1b[0m"); // an unselected row keeps it
	});

	it("the MATCHED characters of the name are bold gold — one span per run — the rest are not", () => {
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
		// MOVED (Graphite P2 — DECLARED): what the person typed is GOLD as
		// well as bold (off a known ground, as here, the warn tint stands in,
		// as /resume's title does), and a run of hits is ONE span, not a span
		// per letter. The selected name is bold throughout, so on the bar
		// "the rest" keeps the bold and loses only the gold; the unselected
		// row is the plain case.
		expect(bytes).toContain("\x1b[0m\x1b[7m\x1b[1m\x1b[33mra\x1b[0m\x1b[7m\x1b[1mnge.js");
		const un = atPanelRows(atState(["src/range.js", "src/range.ts"], "ra", 1)(), 40);
		expect(un.find((r) => r.includes("nge.js"))).toContain("  \x1b[0m\x1b[1m\x1b[33mra\x1b[0mnge.js\x1b[0m");
	});

	// DECLARED REVERSAL (Graphite P2, owner-approved 2026-10-03): a hit in
	// the folder IS drawn. The person typed those letters; a column that
	// hides why a row matched leaves "why is this here?" unanswered. The
	// folder's other letters stay dim.
	it("a hit that lands in the DIRECTORY is drawn gold — the rest of the folder stays quiet", () => {
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
		expect(bytes).toContain("\x1b[1m\x1b[33mdo\x1b[0m\x1b[7mcs/"); // on the bar: no dim (unknown ground)
		const un = atPanelRows(atState(["docs/range-notes.md", "docs/x.md"], "do")(), 40);
		expect(un.find((r) => r.includes("range-notes.md"))).toContain("\x1b[0m\x1b[1m\x1b[33mdo\x1b[0m\x1b[2mcs/\x1b[0m");
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
		// MOVED (Graphite P2): the counter is the key row's right edge
		expect(rowsOf(writes.join("")).find((r) => r.text.includes("tab inserts"))!.text).toMatch(/ 7\/7$/);
	});

	it("at most FIVE match rows render however many match", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(FILES, "ra"));
		body.enter();
		tick();
		const bytes = writes.join("");
		// (Graphite P2: five from a terminal under 30 rows, eight from 30)
		const band = rowsOf(bytes).filter((r) => r.text.includes("range") || r.text.includes("tab inserts"));
		expect(band.length).toBe(6); // 5 matches + the key row, out of 7 that match
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
		expect(rowsOf(bytes).find((r) => r.text.includes("tab inserts"))!.text).toMatch(new RegExp(` ${matches.length}/${matches.length}$`));
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

	// MOVED (Graphite P2): the horizon rides the band's name now
	it("a CAPPED source says so in the band's name — the horizon is admitted, never hidden", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra", 0, true));
		body.enter();
		tick();
		expect(writes.join("")).toContain("files \u00b7 1 \u00b7 first 2000 only");
	});

	it("an UNCAPPED source says nothing about a cap", () => {
		const { body, writes, tick } = makeBody();
		body.bindInput(one("@ra"), "\u203a ");
		body.bindAt(atState(["src/range.js"], "ra"));
		body.enter();
		tick();
		expect(writes.join("")).not.toContain("first 2000");
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
		// R8: the rows dropped the leading `/` — the byte-identity subject
		// of this case is untouched; only the needle moves.
		expect(frame(menu)).toContain("mode ");
	});
});
