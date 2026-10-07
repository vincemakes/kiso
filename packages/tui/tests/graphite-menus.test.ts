/**
 * Graphite P2 — the command list and the file picker take /resume's shape
 * (owner, 2026-10-03, approved with two changes: the selected command keeps
 * its gold `›`, and the list is not grouped).
 *
 * Both bands now: name themselves with their count (`commands · 18`,
 * `files · 7 of 2000 match`), window at eight rows from a 30-row terminal
 * and five below with a more-mark in column 0, draw what the person typed
 * in gold, and close with one key row carrying the counter at its right
 * edge. The file picker's folder is a column laid over the widest NAME in
 * the whole list, so it never moves while the person types.
 *
 * Two defects found on the way are gated here too: the command list cut
 * its descriptions with a cutter that counts escape bytes as cells (a row
 * lost 19 cells per 24-bit colour and could end in a bare ESC), and the
 * name column was measured in code units, so a wide name broke the folder
 * column.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Editor, MENU_ITEMS } from "../src/editor.js";
import { atFilter, atPanelRows, bandKeyRow, type AtPanelState } from "../src/at-picker.js";
import { visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** every CUP-addressed row the frame wrote, LAST write per row winning,
 *  with its bytes and its visible text */
function screenRows(bytes: string): Map<number, { raw: string; text: string }> {
	const out = new Map<number, { raw: string; text: string }>();
	for (const m of bytes.matchAll(/\x1b\[(\d+);1H\x1b\[0K((?:[^\x1b]|\x1b\[[0-9;]*m)*)/g)) out.set(Number(m[1]), { raw: m[2]!, text: plain(m[2]!) });
	return out;
}

/** An escape that is not the start of a CSI or OSC sequence — what a cut
 *  landing inside a colour leaves behind. */
const BARE_ESC = /\x1b(?![[\]])/;

function drive(typed: string, opts: { W?: number; H?: number; files?: string[]; downs?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	Object.defineProperty(process.stdout, "rows", { value: H, configurable: true });
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	const ed = new Editor(() => body.render());
	body.bindInput(() => ed.dockState(), "› ");
	body.bindMenu(() => ed.menuState());
	body.bindAt(() => ed.atState());
	if (opts.files !== undefined) ed.bindAtItems(() => opts.files!.map((path) => ({ path })));
	body.enter();
	ed.feed(enc(typed));
	for (let i = 0; i < (opts.downs ?? 0); i += 1) ed.feed(enc("\x1b[B"));
	body.render();
	vi.advanceTimersByTime(16);
	const bytes = writes.join("");
	const rows = [...screenRows(bytes).entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
	const head = rows.findIndex((r) => /^─{3} (commands|files) /.test(r.text));
	// the key row closes the band: its counter is the one thing a narrow row keeps
	const band = head < 0 ? [] : rows.slice(head, rows.findIndex((r, i) => i > head && / \d+\/\d+\s*$/.test(r.text)) + 1);
	return { bytes, band, ed };
}

const ZH = "\u5ba1\u6279\u9762\u677f"; // four wide characters, eight cells (escaped: the tree stays CJK-free)

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.NO_COLOR;
	process.env.COLORTERM = "truecolor"; // 24-bit: the 19-byte colours the cut defect needed
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	setGround("light");
});
afterEach(() => {
	vi.useRealTimers();
	setGround("unknown");
	delete process.env.COLORTERM;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
	delete (process.stdout as { rows?: number }).rows;
});

describe("Graphite P2 — the command list", () => {
	it("a description is cut by CELLS: a cut row fills W−1 and ends in …, and never leaves a bare ESC", () => {
		for (const W of [48, 60, 80]) {
			const { band } = drive("/", { W, H: 30 });
			const rows = band.slice(1, -1);
			expect(rows.length, `W=${W}`).toBe(8);
			for (const r of rows) {
				expect(r.raw, `W=${W}: a bare ESC in ${JSON.stringify(r.raw)}`).not.toMatch(BARE_ESC);
				expect(visibleWidth(r.text), `W=${W}: ${r.text}`).toBeLessThanOrEqual(W);
			}
			// the cut rows reach the margin: not one cell short per escape byte
			const cut = rows.filter((r) => r.text.trimEnd().endsWith("…"));
			if (W < 80) expect(cut.length, `W=${W}: nothing was cut`).toBeGreaterThan(0);
			for (const r of cut) expect(visibleWidth(r.text.trimEnd()), `W=${W}: ${r.text}`).toBe(W - 1);
		}
	});

	it("the typed prefix is gold and bold; the band names its count", () => {
		const p = palette();
		const { bytes, band } = drive("/mo");
		expect(bytes).toContain(`${p.bold}${p.gold}mo${p.reset}`);
		const n = MENU_ITEMS.filter((m) => m.name.startsWith("/mo")).length;
		expect(band[0]!.text).toMatch(new RegExp(`^─{3} commands · ${n} of ${MENU_ITEMS.length} match ─+$`));
		expect(drive("/").band[0]!.text).toMatch(new RegExp(`^─{3} commands · ${MENU_ITEMS.length} ─+$`));
	});

	it("the selected command keeps the gold › in column 1 (owner, 2026-10-03), the edge cell in column 0", () => {
		const p = palette();
		const { band } = drive("/", { downs: 1 });
		const sel = band.slice(1, -1).filter((r) => r.raw.includes(p.askEdge));
		expect(sel.length).toBe(1);
		expect(sel[0]!.raw.startsWith(`${p.askEdge} ${p.washAsk}`)).toBe(true);
		expect(sel[0]!.raw).toContain(`${p.gold}›${p.fgEnd}`);
		expect(sel[0]!.text).toMatch(new RegExp(`^ ›${MENU_ITEMS[1]!.name.slice(1)} `));
	});

	it("one list, not grouped: the rows are the commands in the editor's order", () => {
		const { band } = drive("/", { H: 30 });
		const names = band.slice(1, -1).map((r) => r.text.slice(2).trim().split(/\s+/)[0]);
		expect(names).toEqual(MENU_ITEMS.slice(0, 8).map((m) => m.name.slice(1)));
	});

	it("the description column is laid over the WHOLE list: typing never moves it", () => {
		const col = (typed: string): number => {
			const row = drive(typed).band.find((r) => r.text.includes("switch the approval tier"))!;
			return row.text.indexOf("switch the approval tier");
		};
		expect(col("/mo")).toBe(col("/"));
		expect(col("/mode")).toBe(col("/"));
	});
});

describe("Graphite P2 — the file picker", () => {
	const FILES = ["src/range.js", "docs/range-notes.md", `${ZH}/ra.md`, `lib/${ZH}ra.ts`, "a/b/c/deep/range.ts", "notes.md"];

	it("the folder is a column: every folder starts in one cell, the widest name in the list (in cells) setting it", () => {
		const { band } = drive("@ra", { files: FILES });
		const rows = band.slice(1, -1);
		expect(rows.length).toBe(5);
		// `range-notes.md` (14 cells) is the widest name in the WHOLE list
		const starts = rows.map((r) => {
			const dir = FILES.find((f) => r.text.includes(f.slice(0, f.lastIndexOf("/") + 1)) && r.text.includes(f.slice(f.lastIndexOf("/") + 1)))!;
			return visibleWidth(r.text.slice(0, r.text.lastIndexOf(dir.slice(0, dir.lastIndexOf("/") + 1))));
		});
		expect(new Set(starts)).toEqual(new Set([2 + 14 + 2]));
	});

	it("a wide name sets the column by its cells, not its code units", () => {
		const files = ["src/abcdef.ts", `lib/${ZH}.ts`]; // 9 cells vs 11 cells (7 code units)
		const { band } = drive("@", { files });
		const rows = band.slice(1, -1);
		const at = (dir: string): number => {
			const r = rows.find((x) => x.text.includes(dir))!;
			return visibleWidth(r.text.slice(0, r.text.indexOf(dir)));
		};
		expect(at("src/")).toBe(2 + 11 + 2);
		expect(at("lib/")).toBe(at("src/"));
	});

	it("the letters typed are gold in the name AND the folder; the rest of the folder stays dim", () => {
		const p = palette();
		// docs/x.md ranks first (the shorter path): range-notes.md is the unselected row
		const state: AtPanelState = { ...atFilter([{ path: "docs/range-notes.md" }, { path: "docs/x.md" }], "do"), selected: 0, query: "do", total: 2 };
		const row = atPanelRows(state, 80).find((r) => r.includes("range-notes.md"))!;
		expect(row).toContain(`${p.bold}${p.gold}do${p.reset}${p.dim}cs/${p.reset}`);
	});

	it("the window: eight rows from a 30-row terminal, five below; a dim more-mark in column 0", () => {
		const p = palette();
		const matches = atFilter(Array.from({ length: 12 }, (_, i) => ({ path: `d${String(i).padStart(2, "0")}/range.ts` })), "ra").matches;
		const at = (selected: number, height: number) => atPanelRows({ matches, selected, capped: false, query: "ra", total: 40 }, 80, height);
		expect(at(0, 30).length).toBe(1 + 8 + 1);
		expect(at(0, 29).length).toBe(1 + 5 + 1);
		const top = at(0, 24);
		expect(top[5]!.startsWith(`${p.dim}↓${p.reset} `)).toBe(true); // more below
		expect(top.slice(1, 5).some((r) => r.includes("↑"))).toBe(false);
		const bottom = at(11, 24);
		expect(bottom[1]!.startsWith(`${p.dim}↑${p.reset} `)).toBe(true); // more above
		expect(plain(bottom.at(-1)!)).toMatch(/ 12\/12$/);
	});

	it("the band names its count, the matches of the whole list, and the horizon when the list was capped", () => {
		const matches = atFilter([{ path: "src/range.js" }], "ra").matches;
		const head = (s: Partial<AtPanelState>) => plain(atPanelRows({ matches, selected: 0, capped: false, ...s }, 80)[0]!);
		expect(head({ query: "", total: 7 })).toMatch(/^─{3} files · 7 ─+$/);
		expect(head({ query: "ra", total: 7 })).toMatch(/^─{3} files · 1 of 7 match ─+$/);
		expect(head({ query: "ra", total: 2000, capped: true })).toMatch(/^─{3} files · 1 of 2000 match · first 2000 only ─+$/);
	});
});

describe("Graphite P2 — the key row", () => {
	it("the counter sits at the right margin; the keys give way from the front when the row is narrow", () => {
		const keys = ["↑↓ move", "tab inserts", "esc"];
		const row = (W: number) => plain(bandKeyRow(keys, 2, 12, W));
		expect(row(80)).toMatch(/^ {2}↑↓ move · tab inserts · esc +3\/12$/);
		expect(visibleWidth(row(80))).toBe(79);
		expect(row(28)).toMatch(/^ {2}tab inserts · esc +3\/12$/);
		expect(row(14)).toMatch(/^ {2}esc +3\/12$/);
		expect(row(8).trim()).toBe("3/12");
		for (let W = 4; W <= 160; W += 1) expect(visibleWidth(row(W)), `W=${W}`).toBeLessThanOrEqual(W);
	});
});

describe("Graphite P2 — the width walk", () => {
	it("every band row fits its width and carries no bare ESC, W 20..160 on three grounds", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 160; W += 7) {
				for (const typed of ["/", "/mo", "@ra"]) {
					// #checked throws on any row wider than W
					const { band } = drive(typed, { W, files: ["src/range.js", `lib/${ZH}ra.ts`, "a/very/deep/folder/that/goes/on/range.ts"] });
					expect(band.length, `${g} W=${W} ${typed}`).toBeGreaterThan(2);
					for (const r of band) {
						expect(r.raw, `${g} W=${W} ${typed}`).not.toMatch(BARE_ESC);
						expect(visibleWidth(r.text), `${g} W=${W} ${typed}: ${r.text}`).toBeLessThanOrEqual(W);
					}
				}
			}
		}
	});
});
