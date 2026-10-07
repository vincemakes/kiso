/**
 * Graphite P1 — the /resume picker as a table, the selected row opened
 * (owner, 2026-09-30: option B, revision 2; eight rows from a 30-row
 * terminal, five below; the turns column kept; interrupted in blue).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor.js";
import { Body } from "../src/compositor.js";
import { PickInput } from "../src/pick-input.js";
import { visibleWidth } from "../src/components.js";
import { palette, setGround } from "../src/lines.js";
import { RESUME_FILTER_HINT, resumeVisible, resumeWindow, scopeSessions, sessionFilter, sessionPickerRows, sessionStarted, sessionStateWord, type SessionCardView } from "../src/session-picker.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);
const HERE = "/home/me/kiso";
const M = 60_000;

const card = (id: string, title: string, badge: SessionCardView["badge"], mins: number, turns: number | null, extra: Partial<SessionCardView> = {}): SessionCardView => ({
	id,
	title,
	badge,
	turns,
	updatedAt: NOW - mins * M,
	uncertain: 0,
	asks: 0,
	outcome: badge === "completed" ? "completed" : null,
	workspace: HERE,
	profileName: "ds",
	...extra,
});
// titles in Chinese as well as English: most real sessions are titled in Chinese (escaped — the tree stays CJK-free)
const ZH_LONG = "\u538b\u7f29\u4e4b\u540e\u7f13\u5b58\u547d\u4e2d\u7387\u4e3a\u4ec0\u4e48\u4f1a\u6389\uff1f\u5148\u67e5\u8bf7\u6c42\u5934\u518d\u67e5\u524d\u7f00";
const ZH_SHORT = "\u5ba1\u6279\u9762\u677f\u91cd\u6784";
const CARDS: SessionCardView[] = [
	card("2026-09-30T09-31-07-71c1", "fix the flaky resize test in the PTY pool", "interrupted", 12, 14),
	card("2026-09-30T08-44-02-d1f0", "tighten the copy on the models page", "completed", 80, 5, { workspace: "/home/me/site", profileName: "op" }),
	card("2026-09-30T07-51-40-9a2c", "add /name so a session can be called something", "completed", 120, 9),
	card("2026-09-30T04-12-55-3e07", ZH_LONG, "ask", 300, 3, { asks: 1 }),
	card("2026-09-29T08-20-13-b812", ZH_SHORT, "completed", 1560, 22),
	card("2026-09-28T21-02-44-6d4f", "bench T5 long session against 0.44", "failed", 2000, 40, { outcome: "max_turns" }),
	card("2026-09-27T10-40-09-2a91", "release notes", "completed", 4320, 6),
	card("2026-09-24T16-18-30-c7e2", "move the sidecar writes behind one lock", "uncertain", 8640, 11, { uncertain: 1 }),
	card("2026-09-16T11-05-51-58ab", "explain the compaction thresholds", "completed", 20160, 2),
	card("2026-09-12T11-05-51-aaaa", "an old one", "unknown", 30000, null, { workspace: null, outcome: "no summary", profileName: null }),
];
const view = (all: boolean, query = "", selected = 0) => {
	const s = scopeSessions(CARDS, HERE, all);
	const matches = sessionFilter(s.cards, query);
	return { cards: s.cards, matches, selected: Math.min(selected, Math.max(0, matches.length - 1)), scope: s.scope, query };
};

let home: string | undefined;
beforeEach(() => {
	home = process.env.HOME;
	process.env.HOME = "/home/me";
	setGround("light");
});
afterEach(() => {
	if (home === undefined) delete process.env.HOME;
	else process.env.HOME = home;
	setGround("unknown");
});

describe("P1 — the table", () => {
	it("the columns line up: every row's age ends in the same cell, CJK titles included", () => {
		const rows = sessionPickerRows(view(false), 80, NOW, 24).map(plain);
		// the rows (not the opened one, not the header or the key row)
		const table = [rows[1]!, ...rows.slice(3, -1)];
		const ends = table.map((r) => visibleWidth(r.replace(/\s+\d+ turns?\s*$/, "")));
		expect(new Set(ends).size, JSON.stringify(table)).toBe(1);
		expect(table.find((r) => r.includes(ZH_SHORT))).toMatch(/1d {2}22 turns$/);
	});

	it("a finished session says nothing in the state column; the others say a word in their colour", () => {
		const p = palette();
		const rows = sessionPickerRows(view(false, "", 7), 100, NOW, 30);
		const row = (needle: string): string => rows.find((r) => plain(r).includes(needle))!;
		expect(sessionStateWord(CARDS[2]!)).toBe("");
		expect(plain(row("add /name"))).toMatch(/something {3,}2h/);
		expect(row("flaky resize")).toContain(`${p.blue}interrupted${p.reset}`);
		expect(row(ZH_LONG.slice(0, 4))).toContain(`${p.gold}1 ask${p.reset}`);
		expect(row("sidecar writes")).toContain(`${p.gold}1 uncertain${p.reset}`);
		expect(row("bench T5")).toContain(`${p.red}max turns${p.reset}`);
	});

	it("the selected row is bold on the selection bar; the opened row under it says the note, when it started, its profile", () => {
		const p = palette();
		const rows = sessionPickerRows(view(false, "", 0), 80, NOW, 24);
		expect(rows[1]!.startsWith(p.askEdge)).toBe(true);
		expect(rows[1]).toContain(`${p.bold}fix the flaky resize test in the PTY pool`);
		expect(rows[2]!.startsWith(p.askEdge)).toBe(true);
		expect(plain(rows[2]!)).toContain(`  interrupted mid-run — resumes exactly · started ${sessionStarted(CARDS[0]!.id)} · profile ds`);
		expect(rows[2]).toContain(`${p.blue}interrupted mid-run${p.reset}`);
		// the text of the selected row starts where every other row's does
		expect(plain(rows[1]!).indexOf("fix")).toBe(2);
		expect(plain(rows[3]!).indexOf("add")).toBe(2);
	});

	it("the id joins the opened row where it fits, and a foreign session's workspace in the every-workspace view", () => {
		// this workspace: the flaky test (0), then /name (1) — its opened row is the band's fourth
		const narrow = plain(sessionPickerRows(view(false, "", 1), 80, NOW, 24)[3]!);
		expect(narrow).toContain("completed clean · started");
		expect(narrow).not.toContain(CARDS[2]!.id);
		const wide = plain(sessionPickerRows(view(false, "", 1), 120, NOW, 24)[3]!);
		expect(wide).toContain(`· ${CARDS[2]!.id}`);
		const all = plain(sessionPickerRows(view(true, "", 1), 120, NOW, 24)[3]!);
		expect(all).toContain("· profile op · ~/site · 2026-09-30T08-44-02-d1f0");
	});

	it("sessionStarted reads the id's UTC stamp and says it in local time; any other id has none", () => {
		const t = new Date(Date.UTC(2026, 8, 30, 9, 31, 7));
		const two = (n: number): string => String(n).padStart(2, "0");
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		expect(sessionStarted("2026-09-30T09-31-07-71c1")).toBe(`${months[t.getMonth()]} ${t.getDate()} ${two(t.getHours())}:${two(t.getMinutes())}`);
		expect(sessionStarted("tui2-dogfood")).toBeNull();
	});

	it("typed letters light up in gold in the title; the band says how many match", () => {
		const p = palette();
		const rows = sessionPickerRows(view(false, "flaky", 0), 80, NOW, 24);
		expect(plain(rows[0]!)).toMatch(/resume · this workspace · 1 of 8 match/);
		expect(rows[1]).toContain(`${p.bold}${p.gold}f${p.reset}`);
		expect(rows[1]).toContain(`${p.bold}${p.gold}y${p.reset}`);
		const zh = sessionPickerRows(view(false, "\u7f13\u5b58", 0), 80, NOW, 24);
		expect(zh[1]).toContain(`${p.bold}${p.gold}\u7f13${p.reset}`);
	});

	it("a CJK title is cut by cells with an ellipsis, never past its column", () => {
		const rows = sessionPickerRows(view(false), 56, NOW, 24).map(plain);
		const zh = rows.find((r) => r.includes(ZH_LONG.slice(0, 4)))!;
		expect(zh).toContain("…");
		expect(visibleWidth(zh)).toBeLessThanOrEqual(56);
	});

	it("the every-workspace view adds where a row is from: blank for here, the last directory, unknown", () => {
		const rows = sessionPickerRows(view(true, "", 0), 80, NOW, 30).map(plain);
		expect(rows.find((r) => r.includes("tighten the copy"))).toMatch(/…\/site {2,}1h/);
		expect(rows.find((r) => r.includes("add /name"))).not.toMatch(/…\//);
	});
});

describe("P1 — the window", () => {
	it("eight rows from a 30-row terminal, five below", () => {
		expect([resumeVisible(24), resumeVisible(29), resumeVisible(30), resumeVisible(60)]).toEqual([5, 5, 8, 8]);
		expect(sessionPickerRows(view(false), 80, NOW, 24)).toHaveLength(1 + 5 + 1 + 1);
		expect(sessionPickerRows(view(false), 80, NOW, 30)).toHaveLength(1 + 8 + 1 + 1);
	});

	it("scroll-off: the selection is always shown, and never on an edge row while more lies past it", () => {
		for (const visible of [5, 8]) {
			for (let total = 1; total <= 20; total += 1) {
				for (let s = 0; s < total; s += 1) {
					const { first, count } = resumeWindow(total, s, visible);
					const at = `visible=${visible} total=${total} s=${s}`;
					expect(count, at).toBe(Math.min(total, visible));
					expect(s >= first && s < first + count, at).toBe(true);
					if (first > 0) expect(s, at).not.toBe(first);
					if (first + count < total) expect(s, at).not.toBe(first + count - 1);
				}
			}
		}
	});

	it("more-marks: a dim ↑ / ↓ in column 0 of the edge rows when the list goes on; column 1 empty", () => {
		const p = palette();
		const rows = sessionPickerRows(view(true, "", 6), 80, NOW, 24);
		const marked = rows.filter((r) => /^[↑↓] /.test(plain(r)));
		expect(marked.map((r) => plain(r)[0])).toEqual(["↑", "↓"]);
		for (const r of marked) expect(r.startsWith(p.dim)).toBe(true);
		// at the list's top there is nothing above
		expect(sessionPickerRows(view(true, "", 0), 80, NOW, 24).some((r) => plain(r).startsWith("↑"))).toBe(false);
	});
});

describe("P1 — the key row and the empty views", () => {
	it("says the keys and where the selection stands; tab counts what the other view adds", () => {
		expect(plain(sessionPickerRows(view(false, "", 1), 80, NOW, 24).at(-1)!)).toMatch(/^ {2}↑↓ move · ⏎ resumes · tab 2 more elsewhere · esc +2\/8$/);
		expect(plain(sessionPickerRows(view(true, "", 1), 80, NOW, 24).at(-1)!)).toMatch(/tab this workspace · esc +2\/10$/);
	});

	it("narrow, the keys give way from the scope's, then the arrows'; enter and esc stay", () => {
		const at = (W: number): string => plain(sessionPickerRows(view(false, "", 0), W, NOW, 24).at(-1)!);
		expect(at(50)).toMatch(/^ {2}↑↓ move · ⏎ resumes · esc +1\/8$/);
		expect(at(30)).toMatch(/^ {2}⏎ resumes · esc +1\/8$/);
	});

	it("nothing matching says what was typed; an empty workspace says so", () => {
		expect(plain(sessionPickerRows(view(false, "zzq"), 80, NOW, 24)[1]!)).toBe("  nothing matches “zzq”");
		const s = scopeSessions(CARDS, "/somewhere/new", false);
		const rows = sessionPickerRows({ cards: s.cards, matches: s.cards, selected: 0, scope: s.scope }, 80, NOW, 24).map(plain);
		expect(rows[1]).toBe("  no session from this workspace yet");
		expect(rows.at(-1)).toMatch(/tab 10 more elsewhere/);
	});
});

describe("P1 — invariant ①", () => {
	it("every row fits, W 20..200, three grounds, both heights, both scopes, a filter", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) {
				for (const [all, query, sel, height] of [
					[false, "", 0, 24],
					[true, "", 7, 30],
					[true, "e", 3, 24],
					[false, "zzq", 0, 24],
				] as const) {
					for (const r of sessionPickerRows(view(all, query, sel), W, NOW, height)) expect(visibleWidth(r), `${g} W=${W} ${JSON.stringify(plain(r))}`).toBeLessThanOrEqual(W);
				}
			}
		}
	});
});

describe("P1 — the input while the picker is up", () => {
	const frame = (type: string, pick = true): string => {
		vi.useFakeTimers();
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		try {
			const writes: string[] = [];
			const editor = new Editor(() => {});
			if (pick) editor.beginPick(() => CARDS, () => {}, HERE);
			const body = new Body({ active: () => true, height: () => 24, width: () => 100, editCol: () => 1, write: (s) => writes.push(s) });
			body.bindInput(() => editor.dockState(), "› ");
			body.bindPick(() => editor.pickState());
			body.enter();
			vi.advanceTimersByTime(16);
			if (type !== "") {
				writes.length = 0;
				editor.feed(enc(type));
				body.render();
				vi.advanceTimersByTime(16);
			}
			return plain(writes.join(""));
		} finally {
			vi.useRealTimers();
			delete (process.stdout as { rows?: number }).rows;
			delete (process.stdout as { columns?: number }).columns;
			delete (process.stdout as { isTTY?: boolean }).isTTY;
		}
	};

	it("the empty input says what typing there does — while the picker is up, and only then (owner's 2026-09-29 empty input stands elsewhere)", () => {
		expect(frame("")).toContain(RESUME_FILTER_HINT);
		expect(frame("", false)).not.toContain(RESUME_FILTER_HINT);
	});

	it("the hint goes the moment a letter is typed", () => {
		const out = frame("f");
		expect(out).toContain("f");
		expect(out).not.toContain(RESUME_FILTER_HINT);
	});

	it("the controller's band estimate is the rows the band draws", () => {
		let line = "";
		const noop = (): void => {};
		const pick = new PickInput({ line: () => line, clear: noop, reflow: noop, render: noop, syncMouse: noop });
		pick.begin(() => CARDS, noop, HERE);
		for (const q of ["", "e", "zzq"]) {
			line = q;
			for (const H of [24, 30]) expect(pick.rows(H), `q=${q} H=${H}`).toBe(sessionPickerRows(pick.state()!, 80, NOW, H).length);
		}
		pick.toggleScope();
		line = "";
		for (const H of [24, 30]) expect(pick.rows(H)).toBe(sessionPickerRows(pick.state()!, 80, NOW, H).length);
	});
});
