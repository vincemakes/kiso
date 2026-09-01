/**
 * R8 — THE COMMAND BAND OPENS ON THE KEY THE BANNER ADVERTISES.
 *
 * The banner says `/ commands`, and until now a bare `/` produced
 * nothing: you had to already know a command's first letter to be
 * shown the list of commands. The reason was real — the band drew
 * EVERY match and folded long descriptions over as many rows as they
 * needed, so eleven commands would have buried the composer — so the
 * fix is a window, and the trigger stops rationing.
 *
 * Owner-ruled 2026-09-01, after a side-by-side against two other
 * agents: both open on the bare sigil, both window, both align the
 * description column, and neither repeats the sigil on the rows.
 *
 * The band had NO gate of its own before this file — every existing
 * menu assertion is on `menuState()`, the data. These are on the
 * bytes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor, MENU_ITEMS } from "../src/editor.js";
import { Screen } from "./helpers/screen.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function band(typed: string, downs = 0, W = 92, H = 20): string[] {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const ed = new Editor(() => body.render());
	body.bindInput(() => ed.dockState(), "› ");
	body.bindMenu(() => ed.menuState());
	body.enter();
	ed.feed(enc(typed));
	for (let i = 0; i < downs; i += 1) ed.feed(enc("\x1b[B"));
	body.render();
	const s = new Screen(W, H);
	s.feed(writes.join(""));
	const rows = s.rows.map((r) => r.join("").replace(/\s+$/, ""));
	const head = rows.findIndex((r) => r.includes("commands ─"));
	if (head < 0) return [];
	const end = rows.findIndex((r, i) => i > head && r.startsWith("──"));
	return rows.slice(head, end < 0 ? rows.length : end);
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("R8 — a bare / opens the list", () => {
	it("the band is on screen with one keystroke", () => {
		const rows = band("/");
		expect(rows.length, "a bare / drew no band").toBeGreaterThan(1);
		expect(rows[1]).toContain("mode");
	});

	it("every command is reachable — the filter is not narrowing on the sigil", () => {
		// the DATA still carries the slash; only the rows drop it
		const ed = new Editor(() => {});
		ed.feed(enc("/"));
		expect(ed.menuState()?.items.length).toBe(MENU_ITEMS.length);
	});
});

describe("R8 — the band is a window", () => {
	it("five rows and a counter, never eleven", () => {
		const rows = band("/");
		expect(rows.length, "the band is not 1 header + 5 rows + 1 counter").toBe(7);
		expect(plain(rows[6]!).trim()).toBe(`(1/${MENU_ITEMS.length})`);
	});

	it("the window follows the selection, and the counter follows with it", () => {
		const rows = band("/", 6);
		expect(plain(rows[6]!).trim()).toBe(`(7/${MENU_ITEMS.length})`);
		const marked = rows.findIndex((r) => plain(r).startsWith("▸"));
		expect(marked, "the selected row scrolled out of its own window").toBeGreaterThan(0);
		expect(marked).toBeLessThan(6);
	});

	it("a list that FITS carries no counter — over rows you can all see, it says nothing", () => {
		const rows = band("/re"); // resume, rewrap
		expect(rows.length).toBe(3); // header + two
		expect(rows.join("\n")).not.toMatch(/\(\d+\/\d+\)/);
	});

	it("the height is the window's, at every width", () => {
		for (const W of [50, 70, 92, 140]) {
			expect(band("/", 0, W).length, `W=${W}`).toBe(7);
		}
	});
});

describe("R8 — the rows are a table, and the sigil is not on them", () => {
	it("no row repeats the / that is already on the input line", () => {
		const rows = band("/").slice(1, 6);
		// NOT vacuous: an empty band would pass a loop over nothing, and
		// the pre-ruling tree draws exactly that for a bare `/`.
		expect(rows.length, "there were no rows to check").toBe(5);
		for (const r of rows) {
			const name = plain(r).slice(2).replace(/\s.*$/, "");
			expect(name.startsWith("/"), `the row's name carries a slash: ${JSON.stringify(plain(r))}`).toBe(false);
			expect(name.length, "the row has no name at all").toBeGreaterThan(0);
		}
	});

	it("the descriptions start in ONE column, and it does not move as the window scrolls", () => {
		// after the 2-cell gutter, a row is `<name><padding><desc>`; the
		// description's column is where the run of spaces ends.
		const descColumn = (row: string): number => {
			const t = plain(row).slice(2);
			const m = /^\S+ +/.exec(t);
			expect(m, `row is not name + padding + desc: ${JSON.stringify(t)}`).not.toBeNull();
			return 2 + m![0].length;
		};
		const top = band("/").slice(1, 6);
		const scrolled = band("/", 6).slice(1, 6);
		expect(top.length + scrolled.length, "there were no rows to check").toBe(10);
		const columns = new Set([...top, ...scrolled].map(descColumn));
		expect([...columns], "the description column moves").toHaveLength(1);
		// and the column really is the widest command, not an accident
		const widest = MENU_ITEMS.reduce((n, m) => Math.max(n, m.name.length - 1), 0);
		expect([...columns][0]).toBe(2 + widest + 1);
	});

	it("a long description is CUT, never folded — a fold would break the window", () => {
		const rows = band("/", 0, 46);
		expect(rows.length).toBe(7);
		expect(rows.slice(1, 6).some((r) => plain(r).includes("…")), "nothing was cut at W=46").toBe(true);
	});
});
