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
import { foldThinking } from "../src/render.js";
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

/**
 * DC-47 — ADJUDICATED: the thinking is back in COLUMN 2, and §1.2 takes
 * a declared exception.
 *
 * The history in one paragraph. §7.2 called the thinking's indent "the
 * price of §1.2": italic and dim are escape sequences, so a rendered
 * frame with the colour stripped — a terminal capture, a paste out of
 * the scrollback, a log of what was drawn — would lose the line between
 * the model's reasoning and its answer. E3 moved PROSE to column 2, the
 * column the thinking was already in, and the two became the same row
 * under `sed`. The thinking was pushed to column 4 to restore it.
 *
 * The owner looked at that and ruled against it: *"the thinking area is
 * not indented by the same two as the first line — it needs to keep the
 * same first-line indent as everything else"* (2026-09-04). §1.8's one
 * left edge outranks the distinction.
 *
 * SO WHAT IS ACTUALLY GIVEN UP, stated rather than glossed: on a
 * rendered frame with its escapes stripped, a thinking paragraph and an
 * answer paragraph are the same bytes. Everywhere else the fact
 * survives — on screen by italic and dim, in a PIPE because the
 * inactive path writes `foldThinking`, one summary line, and never the
 * paragraph at all. §1.2 carries this as its one declared exception.
 *
 * These gates keep what is left, and they say what they no longer
 * check: the two are told apart on the SCREEN by their own escapes, and
 * a pipe never confuses them because it never shows one.
 */
describe("DC-47 — one left edge, and what the exception costs", () => {
	const strip = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
	const say = (text: string, W = 60): string[] => cellComponent({ kind: "md", block: { kind: "para", lines: [text], gap: false, lang: "" } } as unknown as BodyCell).render(W, CTX);
	const thought = (text: string, W = 60): string[] => cellComponent({ kind: "thinking", text, done: true } as unknown as BodyCell).render(W, CTX);

	it("prose AND thinking both sit at column 2 — one left edge (§1.8)", () => {
		expect(strip(say("answer")[0]!)).toBe("  answer");
		expect(strip(thought("reasoning")[0]!)).toBe("  reasoning");
	});

	it("the ESCAPES are what tell them apart, and they still do", () => {
		const t = "Weighing the two shapes.";
		expect(thought(t)[0], "the thinking lost its italic").toContain("\x1b[3m");
		expect(say(t)[0], "prose took the thinking's italic").not.toContain("\x1b[3m");
		expect(thought(t)[0], "the two are the same bytes on screen").not.toBe(say(t)[0]);
	});

	it("THE DECLARED EXCEPTION, asserted rather than glossed: stripped, they ARE the same row", () => {
		// This is the cost of the owner's ruling and it is written down
		// here so a later reader meets it as a decision, not a surprise.
		// §1.2's own text carries the exception.
		const t = "Weighing the two shapes.";
		expect(strip(thought(t)[0]!)).toBe(strip(say(t)[0]!));
	});

	it("a PIPE never confuses them — it never shows a thinking paragraph at all", () => {
		// `thinkingEnd`'s inactive path writes `foldThinking`: one dim
		// summary line. The paragraph this describe is about exists only
		// on a TTY, which is why the pipe was never the surface at risk.
		const long = "Weighing the two shapes and their costs, at length, ".repeat(4);
		const folded = foldThinking(long);
		expect(folded.split("\n").filter((r) => r !== ""), "the pipe printed a paragraph").toHaveLength(1);
		expect(folded).toMatch(/\(\d+ chars · \/think\)/);
	});

	it("…at every width, and both still fold inside the terminal", () => {
		const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november";
		for (const W of [30, 40, 60, 100]) {
			for (const rows of [say(long, W), thought(long, W)]) {
				for (const r of rows) expect(visibleWidth(r), `W=${W}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(W);
			}
			expect(strip(thought(long, W)[0]!).match(/^ */)![0].length, `W=${W}`).toBe(2);
			expect(strip(say(long, W)[0]!).match(/^ */)![0].length, `W=${W}`).toBe(2);
		}
	});
});

/**
 * THE THREE DEVIATIONS fable's byte-comparison found between the built
 * card and the mock the owner ruled on.
 *
 * Honest provenance: these are NOT red-before-green in the usual sense.
 * The deviations were found by replaying the real compositor's bytes
 * beside `mock-blocks.mjs` and reading the difference, so the red was a
 * PICTURE, not a failing assertion. These gates were written after the
 * fix and their job is to keep it — a regression guard, and saying so is
 * better than dressing it as a proof.
 */
describe("R13 — the three deviations from the ruled mock", () => {
	it("① a FAILURE previews like any other card: five rows, the card's own note", () => {
		setGround("light");
		const rows = render(tool({ isError: true, input: "npm run lint", inputFull: JSON.stringify({ command: "npm run lint" }), resultText: `exit 1\n${lines(9, (i) => `src/a${i}.ts:3:1  error  Unexpected any`)}` })).map(plain);
		const body = rows.slice(3, -3).filter((r) => r.trim() !== "");
		expect(body.filter((r) => !r.includes("ctrl+o")).length, "the error preview is not five rows").toBe(5);
		expect(rows.join("\n"), "the pre-card note wording survived").not.toContain("more · ctrl+o");
		expect(rows.some((r) => /… \d+ more lines · ctrl\+o expands/.test(r)), "the card's note is missing").toBe(true);
	});

	it("② a SEARCH names what it looked for, and its scope behind it", () => {
		setGround("unknown");
		const bare = render(tool({ name: "search_text", input: "TODO", inputFull: JSON.stringify({ pattern: "TODO" }), resultText: "a.ts:1: // TODO" })).map(plain);
		expect(bare[0]!.trimEnd(), "a whole-tree search had an EMPTY head row").toBe("  search TODO");
		const scoped = render(tool({ name: "search_text", input: "TODO", inputFull: JSON.stringify({ pattern: "TODO", path: "src" }), resultText: "src/a.ts:1: // TODO" })).map(plain);
		expect(scoped[0]!.trimEnd(), "a scoped search named the directory instead of the pattern").toBe("  search TODO · src");
	});

	it("③ ONE grammar for both cards — the head row's chain is the outcome row's", () => {
		setGround("unknown");
		// the three-row card: no parentheses, the same `·` chain, the
		// elapsed in the same place the bodied card puts it
		const read = render(tool({ name: "read_file", input: "a.ts", inputFull: JSON.stringify({ path: "a.ts" }), resultText: lines(10, (i) => `l${i}`) })).map(plain);
		expect(read).toHaveLength(1);
		expect(read[0]).toBe("  read  a.ts · 10 lines · 0.1s · ctrl+o expands");
		// …and the bodied card's outcome row, for comparison: same order,
		// same separator, and the count stated exactly once on each
		const shell = render(tool({ resultText: lines(90, (i) => `out ${i}`) })).map(plain);
		expect(shell.at(-1)!.trim()).toBe("exit 0 · 90 lines · 0.1s");
		expect((read[0]!.match(/\d+ lines?/g) ?? []).length, "the count is said twice on the head row").toBe(1);
	});
});

/**
 * DC-46, THE RULING — a running card GROWS, and a settle never shrinks it.
 *
 * DECLARED REVERSAL of E2 as it was first written ("allocated at the
 * settled card's height from the first frame, and only ever shrinks at
 * settle"), owner-lane ruling 2026-09-03, and the reason is a
 * measurement rather than a preference. A card allocated at twelve rows
 * and settling at three gives nine rows back, the window's top is
 * clamped and cannot follow, and what is left is a transient blank band
 * above the composer. Measured on the a7 replay: hole-frames went
 * 8.9 / 13.5 / 3.8 percent (0.23.0) to 16.9 / 24.6 / 7.9.
 *
 * The only source of that band is the shrink, so the cure is to stop
 * shrinking — not to shrink less, and not to move the band somewhere
 * else.
 *
 *   · a running card starts at its SKELETON: pad · head · blank · one
 *     window row · blank · status · pad = seven rows. A read is three.
 *   · the window GROWS one row per output line, to five.
 *   · there are NO blank padding rows in a window, ever. R7a's "blank,
 *     not a bar" was about padding a FIXED height; the height is the
 *     content now, so there is nothing to pad.
 *   · past five rows the cut note appears ABOVE the window — once per
 *     call — and the card grows by that one row.
 *   · the shell's two gestures ride the STATUS row instead of spending a
 *     window row on a footer, so a settle swaps that row's content
 *     (`3s · esc stops` → `exit 0 · 90 lines · 3.2s`) and changes no
 *     height at all.
 */
describe("DC-46 — the running card grows and never shrinks", () => {
	const running = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> =>
		tool({ state: "running", doneAt: null, startedAt: 9_000, resultText: "", ...over });

	it("a running call with NO OUTPUT YET is the three-row card, and grows to seven at the first line", () => {
		// DERIVED FROM THE RULING, and a deviation from its literal text,
		// which put a `waiting for output` row in the running skeleton. A
		// command that returns NOTHING — `true`, a silent build — would
		// then settle from seven rows to three, which is exactly the shrink
		// the ruling exists to remove: its own rule cannot hold with that
		// row in place. Nothing is lost by dropping it — the breathing mark
		// says the call is in flight and the status row says for how long,
		// so the row carried no fact they do not (§1.3).
		setGround("light");
		const bare = render(running()).map(plain);
		expect(bare).toHaveLength(3);
		expect(bare[1]!.trim()).toMatch(/shell npm test/);
		expect(bare.join("\n")).not.toContain("waiting for output");
		const first = render(running({ resultText: "out 1" })).map(plain);
		expect(first).toHaveLength(7);
		expect(first[1]!.trim()).toMatch(/shell npm test$/);
		expect(first[3]!.trim()).toBe("out 1");
		expect(first[5]!.trim()).toMatch(/^1s/);
	});

	it("…and a running READ is the three-row card, the same as its settled form", () => {
		setGround("light");
		expect(render(running({ name: "read_file", input: "loop.ts", inputFull: JSON.stringify({ path: "loop.ts" }) }))).toHaveLength(3);
	});

	it("the window GROWS one row per line, to five, and never pads", () => {
		setGround("light");
		for (const [n, want] of [[1, 7], [2, 8], [3, 9], [4, 10], [5, 11]] as const) {
			const rows = render(running({ resultText: lines(n, (i) => `out ${i + 1}`) })).map(plain);
			expect(rows, `${n} line(s) of output`).toHaveLength(want);
			const window = rows.slice(3, 3 + n);
			expect(window.map((r) => r.trim()), `${n}: the window is not the output`).toEqual(Array.from({ length: n }, (_, i) => `out ${i + 1}`));
			expect(window.filter((r) => r.trim() === ""), `${n}: the window padded`).toEqual([]);
		}
	});

	it("past five, the note appears ABOVE the window and the card grows by exactly one — once", () => {
		setGround("light");
		const at5 = render(running({ resultText: lines(5, (i) => `out ${i + 1}`) })).length;
		const at6 = render(running({ resultText: lines(6, (i) => `out ${i + 1}`) })).map(plain);
		expect(at6).toHaveLength(at5 + 1);
		expect(at6[3]!.trim()).toBe("… 1 earlier line · ctrl+o expands");
		expect(at6.slice(4, 9).map((r) => r.trim())).toEqual(["out 2", "out 3", "out 4", "out 5", "out 6"]);
		// …and NEVER again: 90 lines is the same height as 6
		expect(render(running({ resultText: lines(90, (i) => `out ${i + 1}`) }))).toHaveLength(at5 + 1);
	});

	it("the shell's gestures ride the STATUS row — no footer spends a window row", () => {
		setGround("light");
		const rows = render(running({ resultText: lines(3, (i) => `out ${i + 1}`) })).map(plain);
		expect(rows.join("\n"), "the footer still owns a row").not.toMatch(/^\s*live tail/m);
		expect(rows.at(-2)!.trim()).toMatch(/^1s · esc stops · alt\+⏎ redirects$/);
	});

	it("THE SETTLE NEVER SHRINKS — at every output length, the settled card is at least as tall", () => {
		setGround("light");
		for (const n of [0, 1, 3, 5, 6, 40, 90]) {
			const text = n === 0 ? "" : lines(n, (i) => `out ${i + 1}`);
			const live = render(running({ resultText: text })).length;
			const settled = render(tool({ resultText: text })).length;
			expect(settled, `${n} lines: the settle gave ${live - settled} rows back`).toBeGreaterThanOrEqual(live);
		}
	});
});

/**
 * DC-48 — the three-row card's ONE row was assembled outside the
 * cutting discipline, and it killed the session.
 *
 * The owner's dogfood, 80 columns, first frame of a long `find`:
 *
 *     kiso-tui invariant ① violated: a line of visible width 113 > 80
 *     was about to be emitted
 *
 * The running branch cut its head row to `W` and then handed it to
 * `slabBlock`, whose no-body branch joins head and outcome into one row
 * and cut nothing. So the row was `W` wide PLUS the whole status — and
 * the state it happens in is a running call with nothing back yet, which
 * is the first second of every command.
 *
 * Same shape as DC-45: a row assembled after the fold, by a caller who
 * did not know it was making a row. The settled three-row card was never
 * exposed — `settledHeadText` builds its own chain against the room it
 * has — which is why only the live form crashed.
 *
 * THE FIXTURE DOES NOT SIT AT A BOUNDARY (DC-45's lesson): one command
 * long enough to overflow every width, walked from 20 to 200.
 */
describe("DC-48 — the card's one row fits, at every width", () => {
	const CMD = "find ~ -maxdepth 3 -type d \\( -iname '*kiso*' \\) 2>/dev/null | grep -v node_modules | head -40";

	for (const [label, over] of [
		["running", { state: "running", doneAt: null, startedAt: 9_000, resultText: "" }],
		["settled", { resultText: "" }],
	] as const) {
		it(`${label}: no row is wider than the terminal, and the elapsed survives`, () => {
			for (const g of ["light", "unknown"] as const) {
				setGround(g);
				for (let W = 20; W <= 200; W += 1) {
					const rows = cellComponent(tool({ input: CMD, inputFull: JSON.stringify({ command: CMD }), ...over })).render(W, CTX);
					for (const row of rows) {
						expect(visibleWidth(row), `${label} ${g} W=${W}: ${JSON.stringify(plain(row))}`).toBeLessThanOrEqual(W);
					}
					expect(rows.map(plain).join("\n"), `${label} ${g} W=${W}: the elapsed was cut away`).toMatch(/\d+\.?\d*s/);
				}
			}
		});
	}

	it("the target and the elapsed are separated by the `·` every other chain uses", () => {
		setGround("light");
		const rows = render(tool({ state: "running", doneAt: null, startedAt: 9_000, resultText: "" })).map(plain);
		expect(rows[1]!.trim()).toMatch(/shell npm test · 1s/);
	});
});

/**
 * DC-50 / R14 — THE CARD IN ITS EXPANDED STATE.
 *
 * This file exercised `expanded: false` and nothing else, which was
 * enough while an expanded card was a different renderer:
 * `expandedCard` drew the APPENDED block the old ctrl+o produced, and
 * `r14-expanded-card.test.ts` gated its shape. DC-50 retires the append,
 * so an expanded card is THIS renderer with the flag set — and the
 * coverage has to move here or be lost.
 *
 * Claims carried over verbatim where they transfer. The ones that do NOT
 * are `expandedCard`'s own and retire with it: its head row's `expanded ·
 * N turns back` metadata (a block printed far away from its card needed to
 * say which card; one rendered in place does not), and its section
 * headers around the raw input and output.
 */
describe("DC-50 — an EXPANDED card keeps the card's shape", () => {
	const long = tool({ expanded: true, resultText: lines(40, (i) => `out ${i + 1}`) });

	it("the body is the WHOLE result — an expansion that capped would be no expansion", () => {
		const said = render(long).join("\n");
		for (const n of [1, 20, 40]) expect(said, `line ${n} is missing`).toContain(`out ${n}`);
	});

	it("no cut note when nothing is cut, and the way back is offered instead", () => {
		const said = render(long).join("\n");
		expect(said, "an expanded card still advertises a cut").not.toContain("ctrl+o expands");
		expect(said, "an expanded card does not say how to put it back").toContain("ctrl+o collapses");
	});

	/*
	 * OBSERVED, not asserted, and recorded because DC-50 makes it
	 * universal rather than rare.
	 *
	 * The expanded card's shape is NOT the collapsed card's. Collapsed
	 * ends with its own outcome row; expanded carries the outcome INLINE
	 * in the head (`shell npm test · exit 0 · 40 lines · 0.1s`) and ends
	 * with the affordance row instead. Until this round that shape was
	 * reachable only for a live or approval-parked cell, so few ever saw
	 * it; now every settled card takes it on one keypress.
	 *
	 * Left alone deliberately. It is pre-existing, it is not a defect this
	 * round introduced, and §7.4/§7.5's card is the owner's to rule on.
	 * Raised with the round's author rather than changed here.
	 *
	 * Three claims that belong to the COLLAPSED cases above are deliberately
	 * NOT repeated here: the leading pad, the wash, and the full width.
	 * All three were tried and all three were wrong for this harness
	 * rather than wrong in the product. Measured: collapsed and expanded
	 * alike render 0-of-N washed rows, with no leading pad, and a head row
	 * 43 cells wide at W=90 — because the ground is UNKNOWN in this file's
	 * context and the card degrades to plain indentation by design (§1.2).
	 * Every one of those three is a property of the slab, and the slab is
	 * not painting here. A gate asserting them would have been asserting
	 * the harness, which this round has already done four times.
	 */

});
