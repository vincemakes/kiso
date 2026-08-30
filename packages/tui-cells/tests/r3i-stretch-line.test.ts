/**
 * R3i phase 1 — THE STRETCH LINE, the turn's one working row.
 *
 * These gates are written BEFORE the function they guard (the charter's
 * rule for a commit-semantics round: the gate is the specification, and
 * a specification written after the code is a description).
 *
 * The line has three phases and one job: to be, at every instant, the
 * row the settle will keep.
 *
 *   thinking   ✧ thinking 4s                        moving, present
 *   acting     ✶ reading 6 files · running 4 shell commands
 *   settled    ✦ thought 9s · read 6 files · ran 4 shell commands · ctrl+r
 *
 * G1 is the gate that makes that sentence true and would have caught
 * the drift the v9 review found: the live rows had been written by hand
 * and said `searching 1 pattern` where the settle says `ran 1 search` —
 * the NOUN changing at the settle — and `running 4 shells`, which is
 * verbatim the R3g defect the previous round removed.
 *
 * G2 is the gate for the ladder. "The trouble clause gives way never"
 * was unimplementable: at W=64 a long clause overflowed after the
 * counts had already cut to a bare "…", and invariant ① throws on that
 * row in the product. Everything gives way except the KEY, because a
 * fold with no key is work with no way back to it.
 *
 * G3 is law 1.2 and law 1.3 together: colour is emphasis, never
 * information, so every fact on this row must survive having its
 * escapes stripped — which is also the only form that survives a pipe.
 */

import { describe, expect, it } from "vitest";
import { stretchLine, type StretchTerms } from "../src/components.js";
import { visibleWidth } from "../src/width.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const TERMS: StretchTerms = {
	thoughtSeconds: 9,
	calls: [
		["read_file", 6],
		["list_dir", 1],
		["shell", 4],
	],
	targets: [],
	trouble: [],
};

describe("R3i G1 — the line you watch is the line you keep", () => {
	it("live and settled differ in the MARK, the TENSE and the KEY — and in nothing else", () => {
		const live = plain(stretchLine({ ...TERMS, phase: "acting" }, 120)[0]!);
		const settled = plain(stretchLine({ ...TERMS, phase: "settled" }, 120)[0]!);
		// the same nouns, in the same order, at both tenses. The terms are
		// split on the separator rather than pattern-matched, so the
		// helper cannot quietly disagree with the row it is reading.
		const nouns = (row: string): string[] =>
			row
				.replace(/^\S+ /, "")
				.split(" · ")
				.filter((t) => /^\D+ \d+ /.test(t))
				.map((t) => t.replace(/^\D+ \d+ /, ""));
		expect(nouns(live)).toEqual(nouns(settled));
		expect(live).toContain("reading 6 files");
		expect(settled).toContain("read 6 files");
		expect(live).toContain("running 4 shell commands");
		expect(settled).toContain("ran 4 shell commands");
	});

	it("the noun NEVER changes at the settle — one table, two tenses", () => {
		for (const [name, singular, plural] of [
			["read_file", "file", "files"],
			["list_dir", "directory", "directories"],
			["search_text", "search", "searches"],
			["shell", "shell command", "shell commands"],
			["edit_file", "file", "files"],
			["write_file", "file", "files"],
		] as const) {
			for (const [n, noun] of [
				[1, singular],
				[3, plural],
			] as const) {
				const t: StretchTerms = { thoughtSeconds: 0, calls: [[name, n]], targets: [], trouble: [] };
				expect(plain(stretchLine({ ...t, phase: "acting" }, 120)[0]!)).toContain(`${n} ${noun}`);
				expect(plain(stretchLine({ ...t, phase: "settled" }, 120)[0]!)).toContain(`${n} ${noun}`);
			}
		}
	});

	it("`4 shells` never appears — the R3g defect cannot come back through the live tense", () => {
		const t: StretchTerms = { thoughtSeconds: 0, calls: [["shell", 4]], targets: [], trouble: [] };
		for (const phase of ["acting", "settled"] as const) {
			expect(plain(stretchLine({ ...t, phase }, 120)[0]!)).not.toMatch(/\d+ shells\b/);
		}
	});

	// DECLARED SUPERSESSION (R4a, owner ruling 2026-08-30) — THE FOLD ROW
	// PRINTS NO KEY.
	//
	// R3i made the key the thing that never gives way, and the settled
	// line's one distinguishing mark. R4 then printed an ordinal beside
	// it (`ctrl+r 3`) so a row could name its own target, and the owner's
	// objection landed: a number you cannot type is not a selector. The
	// reference implementation, checked rather than assumed, prints
	// nothing on the row either — its expansion lives in a MODE you
	// enter, where a pointer reaches every fold including the ones that
	// have scrolled away.
	//
	// So no phase carries a key now. What still separates the settled
	// line is what it always said: the past TENSE, and the bold mark.
	// `ctrl+r` still works and is taught in the keys sheet (`?`), which
	// is where the reference teaches its own binding too.
	it("no phase prints a key — the settled line is distinguished by its TENSE", () => {
		for (const phase of ["settled", "acting", "thinking"] as const) {
			expect(plain(stretchLine({ ...TERMS, phase }, 120)[0]!)).not.toContain("ctrl+r");
		}
		expect(plain(stretchLine({ ...TERMS, phase: "settled" }, 120)[0]!)).toContain("read");
	});

	it("`thought Ns` is the SETTLED lead; a live stretch says what it is doing", () => {
		expect(plain(stretchLine({ ...TERMS, phase: "settled" }, 120)[0]!)).toMatch(/^\S+ thought 9s/);
		expect(plain(stretchLine({ ...TERMS, phase: "acting" }, 120)[0]!)).not.toContain("thought");
		expect(plain(stretchLine({ thoughtSeconds: 4, calls: [], targets: [], trouble: [], phase: "thinking" }, 120)[0]!)).toContain("thinking 4s");
	});

	it("a zero thought term is dropped, at every phase (R3b's rule, still)", () => {
		const t: StretchTerms = { thoughtSeconds: 0, calls: [["read_file", 2]], targets: [], trouble: [] };
		expect(plain(stretchLine({ ...t, phase: "settled" }, 120)[0]!)).not.toContain("thought 0s");
	});
});

describe("R3i G1b — one call names its TARGET, not its count", () => {
	it("a stretch with exactly one call says what it acted on", () => {
		const t: StretchTerms = { thoughtSeconds: 2, calls: [["read_file", 1]], targets: ["editor.ts"], trouble: [] };
		const row = plain(stretchLine({ ...t, phase: "settled" }, 120)[0]!);
		expect(row).toContain("read editor.ts");
		expect(row).not.toContain("1 file");
	});

	it("two calls go back to counts — the rule is the one-ness, not the shape", () => {
		const t: StretchTerms = { thoughtSeconds: 2, calls: [["read_file", 2]], targets: ["a.ts", "b.ts"], trouble: [] };
		expect(plain(stretchLine({ ...t, phase: "settled" }, 120)[0]!)).toContain("read 2 files");
	});

	it("...and so does one call with no target to name", () => {
		const t: StretchTerms = { thoughtSeconds: 2, calls: [["read_file", 1]], targets: [], trouble: [] };
		expect(plain(stretchLine({ ...t, phase: "settled" }, 120)[0]!)).toContain("read 1 file");
	});
});

describe("R3i G2 — the ladder: everything gives way except the key", () => {
	const LONG: StretchTerms = {
		thoughtSeconds: 9,
		calls: [
			["read_file", 20],
			["list_dir", 3],
			["search_text", 6],
			["shell", 4],
		],
		targets: [],
		trouble: [["failed", 1, "npm run check --workspaces --all · exit 1"]],
	};

	it("ONE row, never wider than W, at every width from 4 to 160", () => {
		for (const words of [undefined, "any idea what the flaky gate is?"]) {
			for (let W = 4; W <= 160; W += 1) {
				const rows = stretchLine({ ...LONG, phase: "settled", ...(words !== undefined ? { words } : {}) }, W);
				expect(rows).toHaveLength(1);
				expect(visibleWidth(rows[0]!), `W=${W} words=${String(words)}`).toBeLessThanOrEqual(W);
				expect(rows[0]!).not.toMatch(/[\n\r]/); // invariant ①b
			}
		}
	});

	// R4a: the key is retired (see the supersession above), so what this
	// sweep now holds is the invariant the key used to ride inside —
	// every width produces exactly ONE row that fits.
	it("every width from 20 to 160 produces one row that fits", () => {
		for (let W = 20; W <= 160; W += 1) {
			const rows = stretchLine({ ...LONG, phase: "settled" }, W);
			expect(rows, `W=${W}`).toHaveLength(1);
			expect(visibleWidth(rows[0]!), `W=${W}`).toBeLessThanOrEqual(W);
			expect(rows[0]!, `W=${W}`).not.toMatch(/[\n\r]/);
		}
	});

	/**
	 * The ORDER is a property, not a fact about three hand-picked
	 * widths: as W shrinks, each thing must be gone before the next
	 * thing is touched. Sweeping proves the order without anyone having
	 * to know which width is the hinge — and a hand-picked width is
	 * exactly how the first draft of this gate went wrong (it asserted
	 * the words survive at W=160 where they genuinely do not fit).
	 */
	it("the give-way ORDER: words, then nouns, then counts, then the clause — never the key", () => {
		const t = { ...LONG, phase: "settled" as const, words: "the human's own words" };
		let lastWords = 160;
		let firstCountCut = 0;
		let firstClauseCut = 0;
		for (let W = 160; W >= 24; W -= 1) {
			const row = plain(stretchLine(t, W)[0]!);
			if (row.includes("the human's own words")) lastWords = W;
			const countsCut = /·\s*\S*…/.test(row.split("1 failed")[0] ?? "");
			const clauseCut = /1 failed[^·]*…/.test(row);
			if (countsCut && firstCountCut === 0) firstCountCut = W;
			if (clauseCut && firstClauseCut === 0) firstClauseCut = W;
			// R4a: the key is gone; the ORDER is the property that survives,
			// and it is what the three assertions below prove.
		}
		// the words are gone by the time a count is cut...
		expect(firstCountCut).toBeLessThan(lastWords);
		// ...and a count is cut before the clause is touched.
		expect(firstClauseCut).toBeLessThan(firstCountCut);
	});

	it("there is a band where the nouns compact and NOTHING is cut", () => {
		// The property, not a width: somewhere between "it all fits" and
		// "something has to go" there must be a range where the ladder's
		// first rung — the cheap word — is enough on its own. Swept, so
		// nobody has to know where that range is.
		const t = { thoughtSeconds: 9, calls: [["list_dir", 3]] as const, targets: [], trouble: [], phase: "settled" as const };
		const band: number[] = [];
		for (let W = 24; W <= 60; W += 1) {
			const row = plain(stretchLine(t, W)[0]!);
			if (row.includes("dirs") && !row.includes("…")) band.push(W);
		}
		expect(band.length).toBeGreaterThan(0);
		// and above the band the full word stands
		expect(plain(stretchLine(t, 60)[0]!)).toContain("listed 3 directories");
	});

	it("the clause is the LAST thing to give way", () => {
		const narrow = plain(stretchLine({ ...LONG, phase: "settled" }, 48)[0]!);
		expect(narrow).toContain("1 failed"); // the clause is still there...
		// R4a: "...and so is the key" retired with the key itself.
		expect(narrow).toContain("…"); // ...because the counts gave way
	});
});

describe("R3i G3 — every fact survives the escapes being stripped", () => {
	it("the trouble clause is WORDS: which call, and what happened", () => {
		const t: StretchTerms = {
			thoughtSeconds: 9,
			calls: [["read_file", 20]],
			targets: [],
			trouble: [["denied", 1, "write .env"]],
		};
		const row = plain(stretchLine({ ...t, phase: "settled" }, 100)[0]!);
		expect(row).toContain("1 denied: write .env");
	});

	it("failed, denied and interrupted are DIFFERENT words — the reason is not a colour", () => {
		const kinds: ["failed" | "denied" | "interrupted", string][] = [
			["failed", "1 failed"],
			["denied", "1 denied"],
			["interrupted", "1 interrupted"],
		];
		for (const [kind, expected] of kinds) {
			const t: StretchTerms = { thoughtSeconds: 1, calls: [["read_file", 2]], targets: [], trouble: [[kind, 1, "x"]] };
			expect(plain(stretchLine({ ...t, phase: "settled" }, 100)[0]!)).toContain(expected);
		}
	});

	it("two failures in one stretch are counted, not repeated", () => {
		const t: StretchTerms = { thoughtSeconds: 1, calls: [["read_file", 9]], targets: [], trouble: [["failed", 2, "npm test"]] };
		const row = plain(stretchLine({ ...t, phase: "settled" }, 100)[0]!);
		expect(row).toContain("2 failed");
		expect((row.match(/failed/g) ?? []).length).toBe(1);
	});
});
