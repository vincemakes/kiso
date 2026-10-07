/**
 * 0.40.0 — the session picker opens on THIS workspace.
 *
 * A picker over every session ever run lists another project's work
 * beside this one's, newest first, and the one you meant is below the
 * fold. The scope is the recorded workspace (history — where the session
 * started), compared with the running one; `tab` flips to all; the title
 * always says which is showing and how many each holds; the text filter
 * runs inside the scope. A session with no recorded workspace is never
 * "here" — unknown history shows under ALL only, labelled.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import { scopeSessions, scopeTitle, sessionListFooter, sessionListHeader, sessionListUnknownLine, sessionPickerRows, type SessionCardView } from "../src/session-picker.js";

const enc = (s: string) => new TextEncoder().encode(s);
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = 1_000_000_000_000;
const HERE = "/home/me/proj";

const card = (id: string, title: string, workspace: string | null | undefined, profileName: string | null = null): SessionCardView => ({
	id,
	title,
	badge: "completed",
	turns: 2,
	updatedAt: NOW - 3600_000,
	uncertain: 0,
	asks: 0,
	outcome: "completed",
	...(workspace !== undefined ? { workspace } : {}),
	profileName,
});

const CARDS: SessionCardView[] = [
	card("a", "fix the parser", HERE, "deep"),
	card("b", "draft the post", "/home/me/blog"),
	card("c", "tune the retry", HERE),
	card("d", "an old session", null),
];

let home: string | undefined;
beforeEach(() => {
	home = process.env.HOME;
	process.env.HOME = "/home/me";
	delete process.env.NO_COLOR;
});
afterEach(() => {
	if (home === undefined) delete process.env.HOME;
	else process.env.HOME = home;
});

describe("0.40.0 — the scope rule", () => {
	it("CURRENT is the sessions that started here; unknown history is never here", () => {
		const { cards, scope } = scopeSessions(CARDS, HERE, false);
		expect(cards.map((c) => c.id)).toEqual(["a", "c"]);
		expect(scope).toEqual({ here: HERE, all: false, inHere: 2, total: 4, unknown: 1 });
	});

	it("ALL is every session", () => {
		const { cards, scope } = scopeSessions(CARDS, HERE, true);
		expect(cards.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
		expect(scope.all).toBe(true);
	});

	it("0.40.1 (owner's ruling): nothing from here does NOT fall back to all — the default view is this workspace only", () => {
		const { cards, scope } = scopeSessions(CARDS, "/somewhere/new", false);
		expect(cards).toHaveLength(0);
		expect(scope.all).toBe(false);
		expect(scopeTitle(scope)).toBe("resume · this workspace · 0 of 4");
	});

	// Graphite P1 (owner, 2026-09-30) — RE-DERIVED: 0.40.1's row counting
	// the sessions with no workspace above the list is folded into the key
	// row's count of what tab adds; they are still never listed under CURRENT
	it("0.40.1: sessions with no recorded workspace are never listed under CURRENT; the key row counts them with the rest", () => {
		const { cards, scope } = scopeSessions(CARDS, HERE, false);
		const rows = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 100, NOW).map(strip);
		expect(rows.join("\n")).not.toContain("an old session");
		expect(rows.join("\n")).not.toContain("older session");
		expect(rows.at(-1)).toContain("tab 2 more elsewhere"); // b (another workspace) and d (none)
		// under ALL they are listed, and say where they are from: unknown
		const all = scopeSessions(CARDS, HERE, true);
		const allRows = sessionPickerRows({ cards: all.cards, matches: all.cards, selected: 0, scope: all.scope }, 100, NOW).map(strip);
		expect(allRows.find((r) => r.includes("an old session"))).toMatch(/an old session\s+unknown\s+1h/);
		expect(allRows.at(-1)).toContain("tab this workspace");
	});

	it("0.40.1: an empty CURRENT view says so in a row, rather than an empty band", () => {
		const { cards, scope } = scopeSessions(CARDS, "/somewhere/new", false);
		const rows = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 100, NOW).map(strip);
		expect(rows.some((r) => r.includes("no session from this workspace yet"))).toBe(true);
	});

	it("the title names the command, the scope and its counts; a filter says how many match (the key moved to the key row)", () => {
		expect(scopeTitle(scopeSessions(CARDS, HERE, false).scope)).toBe("resume · this workspace · 2 of 4");
		expect(scopeTitle(scopeSessions(CARDS, HERE, true).scope)).toBe("resume · every workspace · 4");
		expect(scopeTitle(null)).toBe("resume");
		expect(scopeTitle(scopeSessions(CARDS, HERE, false).scope, { matches: 1, of: 2 })).toBe("resume · this workspace · 1 of 2 match");
		expect(scopeTitle(scopeSessions(CARDS, HERE, true).scope, { matches: 3, of: 4 })).toBe("resume · every workspace · 3 of 4 match");
		expect(scopeTitle(null, { matches: 0, of: 4 })).toBe("resume · 0 of 4 match");
	});
});

describe("0.40.0 — the rows under each scope", () => {
	it("CURRENT: the opened row carries the profile, and nothing names a workspace (every row is from here)", () => {
		const { cards, scope } = scopeSessions(CARDS, HERE, false);
		const rows = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 100, NOW).map(strip);
		expect(rows[0]).toContain("this workspace · 2 of 4");
		expect(rows[1]).toContain("fix the parser");
		expect(rows[2]).toContain("· profile deep");
		expect(rows.join("\n")).not.toContain("~/proj");
		expect(rows.join("\n")).not.toContain("\u2026/proj");
	});

	it("ALL: a foreign row names where it came from, an unknown one says so, a row from here is blank there", () => {
		const { cards, scope } = scopeSessions(CARDS, HERE, true);
		const rows = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 100, NOW).map(strip);
		expect(rows.find((r) => r.includes("draft the post"))).toContain("\u2026/blog");
		expect(rows.find((r) => r.includes("an old session"))).toContain("unknown");
		expect(rows.find((r) => r.includes("tune the retry"))).not.toMatch(/~\/|\u2026\//);
		// a wide terminal writes the path out, home as ~
		const wide = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 120, NOW).map(strip);
		expect(wide.find((r) => r.includes("draft the post"))).toContain("~/blog");
	});

	it("a long foreign path gives way first: the age and turns stay, the path shortens to its last directory", () => {
		// found by the PTY leg: the tag rode inside the meta span, and a long
		// temp path took the age and the turn count off the row with it
		const long = card("e", "a far away task", "/private/var/folders/rr/ssmz3cxj5rv4xlp6dtdbmt800000gn/T/kiso-ws-pty-abc123/beta", "deep");
		const { cards, scope } = scopeSessions([...CARDS, long], HERE, true);
		const row = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 80, NOW)
			.map(strip)
			.find((r) => r.includes("a far away task"))!;
		expect(row).toMatch(/1h {2}2 turns$/);
		expect(row).toContain("\u2026/beta");
		expect(row).not.toContain("/private/var");
	});

	it("the workspace never costs the state — the state is the row's action", () => {
		// found by the TTY listing gate: "workspace unknown" took the room of
		// "1 uncertain — needs your verdict" at 80 columns. Graphite P1: the
		// workspace column gives way before the state column, and the whole
		// note is on the opened row
		const urgent: SessionCardView = { ...card("u", "refactor the bench", null, "deep"), badge: "uncertain", uncertain: 1, outcome: null };
		const { cards, scope } = scopeSessions([urgent, ...CARDS], HERE, true);
		for (const W of [40, 56, 80]) {
			const rows = sessionPickerRows({ cards, matches: cards, selected: 0, scope }, W, NOW).map(strip);
			expect(rows[1], `W=${W}`).toContain("1 uncertain");
			expect(rows[2], `W=${W}`).toContain("1 uncertain");
		}
		expect(strip(sessionPickerRows({ cards, matches: cards, selected: 0, scope }, 80, NOW)[2]!)).toContain("1 uncertain \u2014 needs your verdict");
	});

	it("an unscoped picker (no workspace passed) is named and offers no tab", () => {
		const rows = sessionPickerRows({ cards: CARDS, matches: CARDS, selected: 0 }, 80, NOW).map(strip);
		expect(rows[0]).toMatch(/^─{3} resume ─+$/);
		expect(rows.at(-1)).not.toContain("tab");
	});
});

describe("0.40.0 — the keys", () => {
	it("tab flips CURRENT ↔ ALL even when CURRENT is empty (no fallback left to be stuck in)", () => {
		const e = new Editor(() => {});
		e.beginPick(() => CARDS, () => {}, "/somewhere/new");
		expect(e.pickState()!.matches).toEqual([]);
		e.feed(enc("\t"));
		expect(e.pickState()!.matches).toHaveLength(4);
	});

	it("tab flips CURRENT ↔ ALL; the filter runs inside the scope", () => {
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {}, HERE);
		expect(editor.pickState()!.matches.map((c) => c.id)).toEqual(["a", "c"]);
		editor.feed(enc("\t"));
		expect(editor.pickState()!.matches.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
		editor.feed(enc("post"));
		expect(editor.pickState()!.matches.map((c) => c.id)).toEqual(["b"]);
		editor.feed(enc("\t"));
		// back in CURRENT the same query matches nothing from here — the filter never reaches past the scope
		expect(editor.pickState()!.matches).toEqual([]);
		expect(editor.pickState()!.scope?.all).toBe(false);
	});

	it("tab is not typed into the query", () => {
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {}, HERE);
		editor.feed(enc("\t\t"));
		expect(editor.pickState()!.matches.map((c) => c.id)).toEqual(["a", "c"]);
	});

	it("an unscoped picker has no scope and tab does not flip anything", () => {
		const editor = new Editor(() => {});
		editor.beginPick(() => CARDS, () => {});
		expect(editor.pickState()!.scope).toBeNull();
		expect(editor.pickState()!.matches).toHaveLength(4);
	});
});

describe("0.40.1 — `kiso sessions` unknown-workspace line", () => {
	it("one line counts the sessions without a workspace, and names the flag", () => {
		expect(strip(sessionListUnknownLine(116, 100))).toBe("116 older sessions without a workspace · --all");
		expect(strip(sessionListUnknownLine(1, 100))).toBe("1 older session without a workspace · --all");
		expect(sessionListUnknownLine(0, 100)).toBe("");
	});
});

describe("0.40.0 — `kiso sessions` header", () => {
	it("names the scope and both counts; the footer keeps today's words", () => {
		expect(strip(sessionListHeader(2, 4, false, 100))).toBe("2 of 4 sessions from this workspace \u00b7 --all lists every one");
		expect(strip(sessionListHeader(0, 4, false, 100))).toBe("0 of 4 sessions from this workspace \u00b7 --all lists every one");
		expect(strip(sessionListHeader(2, 4, true, 100))).toBe("all 4 sessions");
		expect(strip(sessionListFooter(4, 100))).toBe("4 sessions \u00b7 kiso resume picks interactively");
	});
});
