/**
 * R13 — one rhythm, one surface: no folding, no one-lining.
 *
 * Every call settles into a CARD and goes into the scrollback as it
 * stands. Three registers, three shapes: the human's words are reverse
 * video, the machine's work is a card, the model's words are plain.
 *
 * **D1, one rhythm.** W11 spaced by HEIGHT — one-row siblings packed
 * tight, anything multi-row breathed — so a reader could not tell where
 * the next blank would fall, and a cell that grew from one row to five
 * moved everything around it. That last part is the mechanism behind
 * two closed defects (R7a; R12 Round 2 §3), both of them "the settle
 * shifted the screen". One blank between any two elements, whatever
 * their height, makes a settle change content and never position BY
 * CONSTRUCTION — which is what R7a's one-row stand-in was simulating.
 *
 * **The card.** pad · head · blank · preview · blank · outcome · pad,
 * every row at column 2. A call with nothing to preview is three rows
 * with the outcome riding its head row. The preview caps at five and
 * takes the END of a shell's output (the conclusion is at the bottom)
 * and the START of everything else.
 *
 * **What this reverses**, each by name, because a round that quietly
 * undoes four of them is a round nobody can review: VD-5's one-lining
 * (0.22.0 already reversed it for the shell alone), R3i's folded
 * stretch line, W13's rollup group, TUI2-R1 (B)'s exploration row, and
 * R8a's four-column body indent — the last only where a surface is
 * painted, because off the surface the indent IS the fact.
 *
 * The degradation does not move: on an unknown ground nothing paints
 * and the block is exactly what it is today (r9-slab holds that gate
 * and its discriminator).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bodySpacing, cellComponent, type BodyCell, type FrameCtx, type MdBlock } from "../src/components.js";
import { renderBlock } from "../src/md.js";
import { setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
const WASH = { light: "\x1b[48;5;255m", dark: "\x1b[48;5;236m" } as const;
const washed = (r: string): boolean => r.includes(WASH.light) || r.includes(WASH.dark);
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const W = 90;

const tool = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> =>
	({
		kind: "tool",
		state: "done",
		isError: false,
		added: 0,
		removed: 0,
		startedAt: 0,
		doneAt: 100,
		reason: null,
		rolled: null,
		verdict: null,
		expanded: false,
		diff: null,
		turn: 0,
		name: "shell",
		input: "npm test",
		inputFull: JSON.stringify({ command: "npm test" }),
		resultText: "",
		...over,
	}) as Extract<BodyCell, { kind: "tool" }>;
const render = (c: Extract<BodyCell, { kind: "tool" }>): string[] => cellComponent(c).render(W, CTX);
const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

describe("D1 — one blank between any two elements, whatever their height", () => {
	it("a one-row pair gets a blank, where W11 packed it tight", () => {
		expect(bodySpacing(["one row"], ["another"])).toEqual(["", "another"]);
	});

	it("the spacing is a CONSTANT: one blank for every pair of heights", () => {
		const shapes: readonly string[][] = [["a"], ["a", "b"], ["a", "b", "c", "d", "e"]];
		for (const prev of shapes) {
			for (const next of shapes) {
				expect(bodySpacing(prev, next).length, `${prev.length}→${next.length}`).toBe(next.length + 1);
			}
		}
	});

	it("W11's own exceptions are kept: the body's first cell, and a prev that drew nothing", () => {
		expect(bodySpacing(null, ["first"])).toEqual(["first"]);
		expect(bodySpacing([], ["after nothing"])).toEqual(["after nothing"]);
		expect(bodySpacing(["prev"], [])).toEqual([]);
	});
});

describe("the card — pad · head · blank · preview · blank · outcome · pad", () => {
	it("a shell with a long tail is TWELVE rows in that order", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) })).map(plain);
		// pad · head · blank · note+5 · blank · outcome · pad. The cut note
		// is a row of its own and is NOT counted against the preview's cap
		// of five — it is kiso's sentence about the result, not a line of
		// it (shellTail's rule since R9 P2, and mock-blocks.mjs's `block()`).
		expect(rows).toHaveLength(12);
		expect(rows[0]!.trim(), "no pad above").toBe("");
		expect(rows[1]!.trim()).toBe("shell npm test");
		expect(rows[2]!.trim(), "no blank under the head").toBe("");
		expect(rows[3]!.trim(), "the cut note opens a shell's preview").toBe("… 85 earlier lines · ctrl+o expands");
		expect(rows.slice(4, 9).map((r) => r.trim()), "the LAST five rows").toEqual(["out 86", "out 87", "out 88", "out 89", "out 90"]);
		expect(rows[9]!.trim(), "a blank above the outcome").toBe("");
		expect(rows[10]!.trim()).toMatch(/^exit 0 · 90 lines · /);
		expect(rows.at(-1)!.trim(), "no pad below").toBe("");
	});

	it("EVERY row of the card is washed, pads included, and spans the width", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			for (const row of render(tool({ resultText: lines(90, (i) => `out ${i}`) }))) {
				expect(washed(row), `${g}: an unwashed row inside the card`).toBe(true);
				expect(visibleWidth(row), `${g}: a card row that stops short`).toBe(W);
			}
		}
	});

	it("E4 — every row sits at COLUMN 2: the head, the preview, the note and the outcome", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) })).map(plain);
		for (const [i, row] of rows.entries()) {
			if (row.trim() === "") continue;
			expect(row.match(/^ */)![0].length, `row ${i} is not at column 2: ${JSON.stringify(row)}`).toBe(2);
		}
	});

	it("the preview caps at FIVE, one number for every tool", () => {
		setGround("light");
		for (const [label, over] of [
			["shell", { resultText: lines(40, (i) => `o${i}`) }],
			["list_dir", { name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }), resultText: lines(40, (i) => `f${i}`) }],
			["search_text", { name: "search_text", input: "TODO", inputFull: JSON.stringify({ query: "TODO" }), resultText: lines(40, (i) => `m${i}`) }],
			["failed shell", { isError: true, resultText: `exit 1\n${lines(40, (i) => `e${i}`)}` }],
		] as const) {
			const rows = render(tool(over)).map(plain);
			const content = rows.slice(3, -3).filter((r) => r.trim() !== "" && !r.includes("ctrl+o expands"));
			expect(content.length, `${label}: preview is ${content.length} rows`).toBeLessThanOrEqual(5);
		}
	});

	it("a SHELL previews its tail with the note above; everything else its head with the note below", () => {
		setGround("light");
		const sh = render(tool({ resultText: lines(40, (i) => `o${i + 1}`) })).map(plain);
		const shNote = sh.findIndex((r) => r.includes("ctrl+o expands"));
		const shFirst = sh.findIndex((r) => /o\d+/.test(r));
		expect(sh[shNote]).toContain("earlier lines");
		expect(shNote, "a shell's note sits ABOVE its tail").toBeLessThan(shFirst);
		expect(sh.some((r) => r.trim() === "o40"), "a shell shows the END of its output").toBe(true);

		const ls = render(tool({ name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }), resultText: lines(40, (i) => `f${i + 1}`) })).map(plain);
		const lsNote = ls.findIndex((r) => r.includes("ctrl+o expands"));
		const lsLast = ls.map((r) => /f\d+/.test(r)).lastIndexOf(true);
		expect(ls[lsNote]).toContain("more lines");
		expect(lsNote, "a list's note sits BELOW its head").toBeGreaterThan(lsLast);
		expect(ls.some((r) => r.trim() === "f1"), "a list shows the START of its output").toBe(true);
	});

	it("E1 — a read has NO preview: three rows, the outcome riding the head", () => {
		setGround("light");
		const rows = render(tool({ name: "read_file", input: "loop.ts", inputFull: JSON.stringify({ path: "loop.ts" }), resultText: lines(412, (i) => `l${i}`) })).map(plain);
		expect(rows).toHaveLength(3);
		expect(rows[0]!.trim()).toBe("");
		expect(rows[1]!.trim()).toMatch(/^read {2}loop\.ts .*412 lines.*ctrl\+o expands$/);
		expect(rows[2]!.trim()).toBe("");
	});

	it("…and so is a shell that produced nothing", () => {
		setGround("light");
		expect(render(tool({ input: "true", inputFull: JSON.stringify({ command: "true" }), resultText: "" }))).toHaveLength(3);
	});

	it("a failure tints only the outcome word; the card takes no tint", () => {
		setGround("light");
		const rows = render(tool({ isError: true, resultText: `exit 1\n${lines(9, (i) => `e${i}`)}` }));
		expect(rows[1], "the head row is tinted").not.toContain("\x1b[38;5;124m");
		expect(rows.at(-2), "the outcome word is not tinted").toContain("\x1b[38;5;124m");
	});
});

describe("THE DEGRADATION — with no ground, the card does not exist", () => {
	it("no surface, no pads, no inner blanks: R8a's shape, byte for byte", () => {
		setGround("unknown");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) }));
		const joined = rows.join("");
		expect(joined, "reverse video is not a fallback for a card").not.toContain("\x1b[7m");
		expect(joined).not.toContain("\x1b[49m");
		expect(rows.map(plain).filter((r) => r.trim() === ""), "an unpainted blank is §1.3's empty mark").toEqual([]);
	});

	it("and R8a's four-column body indent SURVIVES there — off the surface the indent is the fact", () => {
		setGround("unknown");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) })).map(plain);
		const body = rows.filter((r) => /out \d+/.test(r));
		expect(body.length).toBeGreaterThan(0);
		for (const r of body) expect(r.match(/^ */)![0].length, `unpainted body row not at column 4: ${JSON.stringify(r)}`).toBe(4);
	});
});

/**
 * ONE LEFT EDGE.
 *
 * The card's rows sit at column 2 (E4 above). If the model's answer sat
 * at column 0 and the human's words started at column 1, the page would
 * have three left edges for three registers — which is the opposite of
 * what "one rhythm" means. E3 moves prose to column 2 and D4 widens the
 * chip's inner pad to two, so every register begins in the same column
 * and the registers are told apart by SURFACE, which is §1.6's whole
 * argument.
 *
 * The banner does not move: it is not a body element, it is the opening,
 * and its own tier table owns its columns.
 */
describe("E3 · D4 — one left edge: prose, the chip and the card all begin at column 2", () => {
	const md = (block: MdBlock, W = 60): string[] => cellComponent({ kind: "md", block } as unknown as BodyCell).render(W, CTX);

	it("a paragraph sits at column 2 and folds in the room that leaves", () => {
		const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
		const rows = md({ kind: "para", lines: [long], gap: false, lang: "" }).map(plain);
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) {
			expect(r.match(/^ */)![0].length, `not at column 2: ${JSON.stringify(r)}`).toBe(2);
			expect(visibleWidth(r), `folded past the width: ${JSON.stringify(r)}`).toBeLessThanOrEqual(60);
		}
	});

	it("every kind of block moves together, EXACTLY two columns — its own indents are its own", () => {
		// a delta, not an absolute: a list bullet already sits two columns
		// in by the md renderer's own structure (the `- ` ruling), and a
		// fence has its rail. E3 says the BLOCK moves right by two; what
		// each block does inside itself is not this round's business.
		const blocks: MdBlock[] = [
			{ kind: "heading", lines: ["## Findings"], gap: false, lang: "" },
			{ kind: "list", lines: ["- one", "- two"], gap: false, lang: "" },
			{ kind: "quote", lines: ["> a quoted line"], gap: false, lang: "" },
			{ kind: "fence-line", lines: ["const x = 1;"], gap: false, lang: "ts" },
			{ kind: "table", lines: ["| a | b |", "|---|---|", "| 1 | 2 |"], gap: false, lang: "" },
			{ kind: "rule", lines: ["---"], gap: false, lang: "" },
		];
		for (const b of blocks) {
			const before = renderBlock(b, 60 - 2).map(plain);
			const after = md(b).map(plain);
			expect(after, `${b.kind}: the block did not move by two`).toEqual(before.map((r) => (r === "" ? r : `  ${r}`)));
			expect(after.some((r) => r.trim() !== ""), `${b.kind} rendered nothing`).toBe(true);
		}
	});

	it("a block's own leading blank stays EMPTY — §1.3 forbids an indented blank", () => {
		const rows = md({ kind: "para", lines: ["hi"], gap: true, lang: "" });
		expect(rows[0]).toBe("");
	});

	it("the chip's text starts at column 2 as well, and the band still spans the width", () => {
		for (const W of [40, 64, 90]) {
			const rows = cellComponent({ kind: "user", text: "go on then" } as BodyCell).render(W, CTX);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!), `W=${W}: the band stops short`).toBe(W);
			expect(plain(rows[0]!).match(/^ */)![0].length, `W=${W}`).toBe(2);
			expect(plain(rows[0]!)).toMatch(/ {2}$/);
		}
	});

	it("…and the chip folds in the room its two pads leave", () => {
		const W = 40;
		const rows = cellComponent({ kind: "user", text: "alpha bravo charlie delta echo foxtrot golf" } as BodyCell).render(W, CTX);
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) expect(visibleWidth(r), JSON.stringify(r)).toBe(W);
	});
});
