/**
 * KC3 T-A2 — the fuzzy half, unit-tested: the case-insensitive
 * SUBSEQUENCE filter over the full relative path, the tightened
 * embedding (which characters go bold), and the deterministic rank
 * (contiguous run desc, path length asc, lexical).
 *
 * The rank is a TOTAL order on purpose. Every test below that asserts
 * an array asserts the WHOLE array — a rank that only "usually" agrees
 * with itself moves the row under the user's cursor while they type,
 * which is the one thing a picker may never do.
 */
import { describe, expect, it } from "vitest";
import { AT_CAP, atEmbed, atFilter, longestRun } from "../src/at-picker.js";

const paths = (...p: string[]) => p.map((path) => ({ path }));
const ranked = (items: { path: string }[], q: string) => atFilter(items, q).matches.map((m) => m.path);

describe("KC3 T-A2: the subsequence filter", () => {
	it("matches characters IN ORDER but not adjacently — the whole relative path is the haystack", () => {
		const items = paths("src/range.js", "src/editor.ts", "README.md");
		// "ra" is a subsequence of BOTH src/range.js (contiguous, at "ra")
		// and README.md (scattered: r…a of "readme") — a subsequence
		// filter admits both, and the RANK is what separates them.
		// src/editor.ts has no "a" at all and is excluded outright.
		expect(ranked(items, "ra")).toEqual(["src/range.js", "README.md"]);
		expect(ranked(items, "srced")).toEqual(["src/editor.ts"]);
		// the directory is part of the haystack, not a separate field
		expect(ranked(items, "src/ed")).toEqual(["src/editor.ts"]);
	});

	it("is case-insensitive in BOTH directions", () => {
		const items = paths("src/Range.js", "README.md");
		expect(ranked(items, "range")).toEqual(["src/Range.js"]);
		expect(ranked(items, "RANGE")).toEqual(["src/Range.js"]);
		expect(ranked(items, "readme")).toEqual(["README.md"]);
	});

	it("a character that is not there at all excludes the path", () => {
		expect(ranked(paths("src/range.js"), "raz")).toEqual([]);
		// order matters — "ar" is not a subsequence of "range" before "a"
		expect(ranked(paths("abc"), "cb")).toEqual([]);
	});

	it("an EMPTY query lists everything", () => {
		const items = paths("b.js", "a.js", "deep/nested/c.js");
		expect(ranked(items, "")).toEqual(["a.js", "b.js", "deep/nested/c.js"]);
	});

	it("no items — no matches, and nothing throws", () => {
		expect(atFilter([], "anything")).toEqual({ matches: [], capped: false });
		expect(atFilter([], "")).toEqual({ matches: [], capped: false });
	});
});

describe("KC3 T-A2: the tightened embedding (which characters go bold)", () => {
	it("`ra` against src/range.js emboldens the CONTIGUOUS ra, not the r of src", () => {
		// a naive left-greedy walk takes r@1 (of "src") and a@5 — the two-
		// pass tightening slides them right onto "ra" at 4,5
		expect(atEmbed("src/range.js", "ra")).toEqual([4, 5]);
	});

	it("a prefix query still lands on the prefix — tightening never overshoots", () => {
		expect(atEmbed("src/range.js", "src")).toEqual([0, 1, 2]);
	});

	it("scattered queries keep their scattered indices", () => {
		expect(atEmbed("src/range.js", "sj")).toEqual([0, 10]);
	});

	it("an empty query embeds nothing; a non-match embeds null", () => {
		expect(atEmbed("a.js", "")).toEqual([]);
		expect(atEmbed("a.js", "z")).toBeNull();
	});

	it("the run length is derived from the SAME embedding the panel emboldens", () => {
		const [m] = atFilter(paths("src/range.js"), "ra").matches;
		expect(m!.hit).toEqual([4, 5]);
		expect(m!.run).toBe(2);
		expect(longestRun(m!.hit)).toBe(m!.run);
	});

	it("longestRun counts CONSECUTIVE indices only", () => {
		expect(longestRun([])).toBe(0);
		expect(longestRun([3])).toBe(1);
		expect(longestRun([1, 2, 3])).toBe(3);
		expect(longestRun([0, 5, 6])).toBe(2);
		expect(longestRun([0, 2, 4])).toBe(1);
	});
});

describe("KC3 T-A2: the deterministic rank", () => {
	it("key 1 — a contiguous hit beats a scattered one", () => {
		// "ra" is solid in range.js; in rebar.js it is r…a
		expect(ranked(paths("src/rebar.js", "src/range.js"), "ra")).toEqual(["src/range.js", "src/rebar.js"]);
	});

	it("key 1 beats key 2 — a longer path with a solid run outranks a short scattered one", () => {
		const items = paths("r/a.js", "deep/dir/range.js");
		// r/a.js is shorter but its hit is scattered (r@0, a@2);
		// range.js carries the solid "ra"
		expect(ranked(items, "ra")).toEqual(["deep/dir/range.js", "r/a.js"]);
	});

	it("key 2 — equal runs, the SHORTER path wins", () => {
		const items = paths("vendor/copy/of/range.js", "range.js");
		expect(ranked(items, "range")).toEqual(["range.js", "vendor/copy/of/range.js"]);
	});

	it("key 3 — equal run AND equal length fall to the lexical order", () => {
		expect(ranked(paths("b/range.js", "a/range.js"), "range")).toEqual(["a/range.js", "b/range.js"]);
	});

	it("the order does NOT depend on the source's iteration order", () => {
		const forward = paths("src/rebar.js", "src/range.js", "range.js");
		const backward = [...forward].reverse();
		expect(ranked(forward, "ra")).toEqual(ranked(backward, "ra"));
		expect(ranked(forward, "ra")).toEqual(["range.js", "src/range.js", "src/rebar.js"]);
	});

	it("the rank is STABLE across repeated calls — the row under the cursor never moves on its own", () => {
		const items = paths("a/x.ts", "b/x.ts", "c/x.ts", "xx.ts");
		const once = ranked(items, "x");
		expect(ranked(items, "x")).toEqual(once);
		expect(ranked(items, "x")).toEqual(once);
	});
});

describe("KC3 T-A5: the cap is surfaced, never silent", () => {
	it("at or under the cap — nothing is dropped and `capped` is false", () => {
		const items = Array.from({ length: AT_CAP }, (_, i) => ({ path: `f${i}.ts` }));
		const out = atFilter(items, "");
		expect(out.capped).toBe(false);
		expect(out.matches.length).toBe(AT_CAP);
	});

	it("one over the cap — the extra entry is what makes the truncation KNOWABLE", () => {
		const items = Array.from({ length: AT_CAP + 1 }, (_, i) => ({ path: `f${i}.ts` }));
		const out = atFilter(items, "");
		expect(out.capped).toBe(true);
		expect(out.matches.length).toBe(AT_CAP);
	});

	it("the cap applies to the SOURCE list, so a narrow query still reports it", () => {
		const items = [...Array.from({ length: AT_CAP }, (_, i) => ({ path: `f${i}.ts` })), { path: "zzz.ts" }];
		const out = atFilter(items, "f1.ts");
		expect(out.capped).toBe(true);
	});
});
