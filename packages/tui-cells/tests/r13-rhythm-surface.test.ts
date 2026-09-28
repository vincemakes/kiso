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
 * **The card** (Graphite §7.4). pad · head · body · foot · pad: the
 * head carries the verb, the target and — at its right end — the
 * outcome; the body sits under the target; the foot carries the key and
 * exists only while something is behind it. A call with nothing to
 * preview is the head between its pads. The preview caps at five and
 * takes the END of a shell's output (the conclusion is at the bottom)
 * and the START of everything else. The ground is the call's state.
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
import { COLOR_DARK, COLOR_LIGHT, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
// Graphite (design.md §2): the settled card's ground, as the palette writes it
// in the suite's 24-bit tier (tests/setup-env.ts).
const WASH = { light: COLOR_LIGHT.wash, dark: COLOR_DARK.wash } as const;
const washed = (r: string): boolean => r.includes(WASH.light) || r.includes(WASH.dark);
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
/** A painted card row's content after the edge and the bar (`    ▎`). */
const inner = (r: string): string => plain(r).slice(5).trim();
const isPad = (r: string): boolean => /^ {4}[\u2584\u2580]+$/.test(plain(r));
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

describe("§7.4 — the card: pad · head · body · foot · pad", () => {
	it("a shell with a long tail: the head with its outcome, the note, the last five rows, the key, the pads", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) }));
		expect(rows).toHaveLength(10);
		expect(isPad(rows[0]!) && plain(rows[0]!).includes("\u2584"), "the pad above").toBe(true);
		expect(inner(rows[1]!)).toMatch(/^SHELL +npm test +exit 0 · 90 lines · 0\.1s$/);
		expect(inner(rows[2]!), "the cut note opens a shell's preview").toBe("… 85 earlier lines");
		expect(rows.slice(3, 8).map(inner), "the LAST five rows").toEqual(["out 86", "out 87", "out 88", "out 89", "out 90"]);
		expect(inner(rows[8]!), "the foot carries the key").toBe("ctrl+o expands");
		expect(isPad(rows[9]!) && plain(rows[9]!).includes("\u2580"), "the pad below").toBe(true);
	});

	it("every row spans the width; the rows between the pads stand on the card's ground", () => {
		for (const g of ["light", "dark"] as const) {
			setGround(g);
			for (const row of render(tool({ resultText: lines(90, (i) => `out ${i}`) }))) {
				expect(visibleWidth(row), `${g}: a card row that stops short`).toBe(W);
				if (!isPad(row)) expect(washed(row), `${g}: an unwashed row inside the card`).toBe(true);
			}
		}
	});

	it("the columns: the bar at 4, the verb at 8, the target and every body row at 16", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) })).map(plain);
		for (const r of rows.slice(1, -1)) expect(r.slice(0, 5), JSON.stringify(r)).toBe("    \u258e");
		expect(rows[1]!.indexOf("SHELL")).toBe(8);
		expect(rows[1]!.indexOf("npm test")).toBe(16);
		for (const r of rows.slice(2, 8)) expect(r.search(/\S/, ) >= 0 && r.slice(5).search(/\S/) + 5, JSON.stringify(r)).toBe(16);
	});

	it("the preview caps at FIVE, one number for every tool", () => {
		setGround("light");
		for (const [label, over] of [
			["shell", { resultText: lines(40, (i) => `o${i}`) }],
			["list_dir", { name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }), resultText: lines(40, (i) => `f${i}`) }],
			["search_text", { name: "search_text", input: "TODO", inputFull: JSON.stringify({ query: "TODO" }), resultText: lines(40, (i) => `m${i}`) }],
			["failed shell", { isError: true, resultText: `exit 1\n${lines(40, (i) => `e${i}`)}` }],
		] as const) {
			const rows = render(tool(over)).map(inner);
			const content = rows.slice(2, -2).filter((r) => r !== "" && !r.startsWith("\u2026"));
			expect(content.length, `${label}: preview is ${content.length} rows`).toBeLessThanOrEqual(5);
		}
	});

	it("a SHELL previews its tail with the note above; everything else its head with the note below", () => {
		setGround("light");
		const sh = render(tool({ resultText: lines(40, (i) => `o${i + 1}`) })).map(inner);
		const shNote = sh.findIndex((r) => r.startsWith("\u2026"));
		expect(sh[shNote]).toContain("earlier lines");
		expect(shNote, "a shell's note sits ABOVE its tail").toBeLessThan(sh.findIndex((r) => /^o\d+$/.test(r)));
		expect(sh.includes("o40"), "a shell shows the END of its output").toBe(true);

		const ls = render(tool({ name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }), resultText: lines(40, (i) => `f${i + 1}`) })).map(inner);
		const lsNote = ls.findIndex((r) => r.startsWith("\u2026"));
		expect(ls[lsNote]).toContain("more lines");
		expect(lsNote, "a list's note sits BELOW its head").toBeGreaterThan(ls.map((r) => /^f\d+$/.test(r)).lastIndexOf(true));
		expect(ls.includes("f1"), "a list shows the START of its output").toBe(true);
	});

	it("E1 — a read has NO preview: its head between its pads, the key at the end of the head", () => {
		setGround("light");
		const rows = render(tool({ name: "read_file", input: "loop.ts", inputFull: JSON.stringify({ path: "loop.ts" }), resultText: lines(412, (i) => `l${i}`) }));
		expect(rows).toHaveLength(3);
		expect(isPad(rows[0]!) && isPad(rows[2]!)).toBe(true);
		expect(inner(rows[1]!)).toMatch(/^READ +loop\.ts +412 lines · 0\.1s · ctrl\+o expands$/);
	});

	it("…and so is a shell that produced nothing — with no key, nothing is behind it", () => {
		setGround("light");
		const rows = render(tool({ input: "true", inputFull: JSON.stringify({ command: "true" }), resultText: "" }));
		expect(rows).toHaveLength(3);
		expect(rows.join("")).not.toContain("ctrl+o");
	});

	it("a short output is whole: no note and no foot", () => {
		setGround("light");
		const rows = render(tool({ resultText: lines(3, (i) => `o${i + 1}`) })).map(inner);
		expect(rows.slice(2, -1)).toEqual(["o1", "o2", "o3"]);
		expect(rows.join("\n")).not.toContain("ctrl+o");
	});
});

describe("§1.6 / §7.5 — the ground is the state, and only the outcome WORD takes colour", () => {
	it("settled, failed, running and waiting each stand on their own ground", () => {
		setGround("light");
		expect(render(tool({ resultText: "ok" }))[1]).toContain(COLOR_LIGHT.washDone);
		expect(render(tool({ isError: true, resultText: "exit 1\nboom" }))[1]).toContain(COLOR_LIGHT.washFail);
		expect(render(tool({ state: "running", doneAt: null, startedAt: 9_000, resultText: "" }))[1]).toContain(COLOR_LIGHT.washRun);
		expect(render(tool({ state: "approval", doneAt: null, resultText: "" }))[1]).toContain(COLOR_LIGHT.washAsk);
	});

	it("a failure colours its outcome word and nothing else on the head row", () => {
		setGround("light");
		const head = render(tool({ isError: true, resultText: `exit 1\n${lines(9, (i) => `e${i}`)}` }))[1]!;
		expect(head).toContain(`${COLOR_LIGHT.red}exit 1`);
		// the bar is the state's edge colour (the failure colour, on a failed
		// card); between the verb and the outcome word nothing is coloured
		const between = head.slice(head.indexOf("SHELL"), head.indexOf(`${COLOR_LIGHT.red}exit 1`));
		expect(between, "the target took the failure colour").not.toContain(COLOR_LIGHT.red);
	});

	it("a success's outcome word is the success colour", () => {
		setGround("light");
		expect(render(tool({ resultText: "ok" }))[1]).toContain(`${COLOR_LIGHT.green}exit 0`);
	});
});

describe("THE DEGRADATION — with no ground, the card keeps its content and loses its surface", () => {
	it("no surface, no pads, no blank rows", () => {
		setGround("unknown");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) }));
		const joined = rows.join("");
		expect(joined, "reverse video is not a fallback for a card").not.toContain("\x1b[7m");
		expect(joined).not.toMatch(/\x1b\[48;/);
		expect(rows.map(plain).filter((r) => r.trim() === ""), "an unpainted blank is §1.3's empty mark").toEqual([]);
		expect(rows.some((r) => /[\u2584\u2580]/.test(plain(r)))).toBe(false);
	});

	it("the head at the content edge, the body four columns under it, opened by `└` (R8a)", () => {
		setGround("unknown");
		const rows = render(tool({ resultText: lines(90, (i) => `out ${i + 1}`) })).map(plain);
		expect(rows[0]!.indexOf("SHELL")).toBe(6);
		expect(rows[1]!.trimEnd()).toBe("      \u2514 \u2026 85 earlier lines");
		for (const r of rows.filter((r) => /out \d+/.test(r))) expect(r.match(/^ */)![0].length, JSON.stringify(r)).toBe(8);
	});
});

/**
 * Graphite §1.8 — ONE CONTENT EDGE: every block begins at column 4.
 *
 * Columns 0–2 are the mark column. The person's block is the one element
 * that spans the width: its bar in column 0, its text at the edge. What
 * tells the registers apart is not the column — it is each block's own
 * mark: the person's `▌`, the thinking's `THINK` label, a card's bar and
 * verb (§1.2).
 */
describe("§1.8 — one content edge: prose, thinking and the person's words begin at column 4", () => {
	const md = (block: MdBlock, W = 60): string[] => cellComponent({ kind: "md", block } as unknown as BodyCell).render(W, CTX);

	it("a paragraph sits at column 4 and folds in the room that leaves", () => {
		const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
		const rows = md({ kind: "para", lines: [long], gap: false, lang: "" }).map(plain);
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) {
			expect(r.match(/^ */)![0].length, `not at column 4: ${JSON.stringify(r)}`).toBe(4);
			expect(visibleWidth(r), `folded past the width: ${JSON.stringify(r)}`).toBeLessThanOrEqual(60);
		}
	});

	it("…and never wider than 92 columns, however wide the terminal (§7.15)", () => {
		const long = "word ".repeat(80).trim();
		for (const r of md({ kind: "para", lines: [long], gap: false, lang: "" }, 200).map(plain)) expect(visibleWidth(r)).toBeLessThanOrEqual(4 + 92);
	});

	it("every kind of block moves together, EXACTLY to the edge — its own indents are its own", () => {
		const blocks: MdBlock[] = [
			{ kind: "heading", lines: ["## Findings"], gap: false, lang: "" },
			{ kind: "list", lines: ["- one", "- two"], gap: false, lang: "" },
			{ kind: "quote", lines: ["> a quoted line"], gap: false, lang: "" },
			{ kind: "fence-line", lines: ["const x = 1;"], gap: false, lang: "ts" },
			{ kind: "table", lines: ["| a | b |", "|---|---|", "| 1 | 2 |"], gap: false, lang: "" },
			{ kind: "rule", lines: ["---"], gap: false, lang: "" },
		];
		for (const b of blocks) {
			const before = renderBlock(b, 60 - 4).map(plain);
			const after = md(b).map(plain);
			expect(after, `${b.kind}: the block did not move to the edge`).toEqual(before.map((r) => (r === "" ? r : `    ${r}`)));
			expect(after.some((r) => r.trim() !== ""), `${b.kind} rendered nothing`).toBe(true);
		}
	});

	it("a block's own leading blank stays EMPTY — §1.3 forbids an indented blank", () => {
		const rows = md({ kind: "para", lines: ["hi"], gap: true, lang: "" });
		expect(rows[0]).toBe("");
	});
});

/**
 * Graphite §1.2 — THINKING AND THE ANSWER ARE TOLD APART IN PLAIN BYTES.
 *
 * DC-47's declared exception retires: both sit at the content edge, and
 * the thinking block opens with its `THINK` label, which a stripped frame
 * keeps. The answer carries no label (§1.5) — it is the unmarked block.
 */
describe("§1.2 / §7.2 — the THINK label is what tells thinking from the answer", () => {
	const strip = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
	const say = (text: string, W = 60): string[] => cellComponent({ kind: "md", block: { kind: "para", lines: [text], gap: false, lang: "" } } as unknown as BodyCell).render(W, CTX);
	const thought = (text: string, W = 60, over: Record<string, unknown> = {}): string[] =>
		cellComponent({ kind: "thinking", text, done: true, ...over } as unknown as BodyCell).render(W, CTX);

	it("prose AND thinking both sit at column 4 — one edge (§1.8)", () => {
		expect(strip(say("answer")[0]!)).toBe("    answer");
		expect(strip(thought("reasoning")[1]!)).toBe("    reasoning");
	});

	it("the thinking opens with its label; stripped, the two are NOT the same rows", () => {
		const t = "Weighing the two shapes.";
		expect(strip(thought(t)[0]!)).toBe("    THINK");
		expect(thought(t).map(strip)).not.toEqual(say(t).map(strip));
	});

	it("the label carries the measured seconds, and none when the block has no clock", () => {
		expect(strip(thought("r", 60, { startedAt: 1_000, doneAt: 6_200 })[0]!)).toBe("    THINK 5.2s");
		expect(strip(thought("r")[0]!), "a replayed block has no clock").toBe("    THINK");
	});

	it("while the block streams the label twinkles in the mark column; settled, the column is empty (§4.2)", () => {
		const live = cellComponent({ kind: "thinking", text: "r", done: false } as unknown as BodyCell).render(60, CTX);
		expect(strip(live[0]!)).toMatch(/^ {2}[✧✦✶✸✺] THINK$/);
		expect(strip(thought("r")[0]!)).toMatch(/^ {4}THINK/);
	});

	it("the escapes still differ on screen too: italic thinking, plain prose", () => {
		const t = "Weighing the two shapes.";
		expect(thought(t)[1], "the thinking lost its italic").toContain("\x1b[3m");
		expect(say(t)[0], "prose took the thinking's italic").not.toContain("\x1b[3m");
	});

	it("a PIPE never shows a thinking paragraph at all", () => {
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
			expect(strip(thought(long, W)[1]!).match(/^ */)![0].length, `W=${W}`).toBe(4);
			expect(strip(say(long, W)[0]!).match(/^ */)![0].length, `W=${W}`).toBe(4);
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
		const rows = render(tool({ isError: true, input: "npm run lint", inputFull: JSON.stringify({ command: "npm run lint" }), resultText: `exit 1\n${lines(9, (i) => `src/a${i}.ts:3:1  error  Unexpected any`)}` })).map(inner);
		const body = rows.slice(2, -2).filter((r) => r !== "" && !r.startsWith("\u2026"));
		expect(body.length, "the error preview is not five rows").toBe(5);
		expect(rows.some((r) => /^… \d+ more lines$/.test(r)), "the card's note is missing").toBe(true);
		expect(rows.at(-2), "the key is on the foot").toBe("ctrl+o expands");
	});

	it("② a SEARCH names what it looked for, and its scope behind it", () => {
		setGround("unknown");
		const bare = render(tool({ name: "search_text", input: "TODO", inputFull: JSON.stringify({ pattern: "TODO" }), resultText: "a.ts:1: // TODO" })).map(plain);
		expect(bare[0]!, "a whole-tree search had an EMPTY head row").toMatch(/^ {6}SEARCH  TODO {2,}/);
		const scoped = render(tool({ name: "search_text", input: "TODO", inputFull: JSON.stringify({ pattern: "TODO", path: "src" }), resultText: "src/a.ts:1: // TODO" })).map(plain);
		expect(scoped[0]!, "a scoped search named the directory instead of the pattern").toMatch(/^ {6}SEARCH  TODO · src {2,}/);
	});

	it("③ ONE grammar for every card — the outcome is the same `·` chain at the head row's end", () => {
		setGround("unknown");
		const read = render(tool({ name: "read_file", input: "a.ts", inputFull: JSON.stringify({ path: "a.ts" }), resultText: lines(10, (i) => `l${i}`) })).map(plain);
		expect(read).toHaveLength(1);
		expect(read[0]).toMatch(/^ {6}READ {4}a\.ts +10 lines · 0\.1s · ctrl\+o expands$/);
		const shell = render(tool({ resultText: lines(90, (i) => `out ${i}`) })).map(plain);
		expect(shell[0]).toMatch(/ exit 0 · 90 lines · 0\.1s$/);
		expect((read[0]!.match(/\d+ lines?/g) ?? []).length, "the count is said twice on the head row").toBe(1);
	});
});

/**
 * DC-46, THE RULING — a running card GROWS, and a settle never shrinks it
 * (owner-lane, 2026-09-03; measured on the a7 replay). Graphite keeps it:
 *
 *   · a running call with nothing back is its head between its pads;
 *   · the window grows one row per output line, to five, and never pads;
 *   · past five the cut note appears ABOVE the window — once;
 *   · the shell's gestures ride the HEAD row's right end, where the
 *     settled outcome will stand, so the settle swaps words and ground;
 *   · the one row a settle may add is the foot, and only when rows are
 *     hidden.
 */
describe("DC-46 — the running card grows and never shrinks", () => {
	const running = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> =>
		tool({ state: "running", doneAt: null, startedAt: 9_000, resultText: "", ...over });

	it("a running call with NO OUTPUT YET is its head between its pads, and grows at the first line", () => {
		setGround("light");
		const bare = render(running());
		expect(bare).toHaveLength(3);
		expect(inner(bare[1]!)).toMatch(/^\S+ SHELL +npm test +running · 1s/);
		const first = render(running({ resultText: "out 1" }));
		expect(first).toHaveLength(4);
		expect(inner(first[2]!)).toBe("out 1");
	});

	it("…and a running READ is its head between its pads, the same as its settled form", () => {
		setGround("light");
		expect(render(running({ name: "read_file", input: "loop.ts", inputFull: JSON.stringify({ path: "loop.ts" }) }))).toHaveLength(3);
	});

	it("the window GROWS one row per line, to five, and never pads", () => {
		setGround("light");
		for (const n of [1, 2, 3, 4, 5]) {
			const rows = render(running({ resultText: lines(n, (i) => `out ${i + 1}`) }));
			expect(rows, `${n} line(s) of output`).toHaveLength(3 + n);
			expect(rows.slice(2, 2 + n).map(inner), `${n}: the window is not the output`).toEqual(Array.from({ length: n }, (_, i) => `out ${i + 1}`));
		}
	});

	it("past five, the note appears ABOVE the window and the card grows by exactly one — once", () => {
		setGround("light");
		const at5 = render(running({ resultText: lines(5, (i) => `out ${i + 1}`) })).length;
		const at6 = render(running({ resultText: lines(6, (i) => `out ${i + 1}`) }));
		expect(at6).toHaveLength(at5 + 1);
		expect(inner(at6[2]!)).toBe("\u2026 1 earlier line");
		expect(at6.slice(3, 8).map(inner)).toEqual(["out 2", "out 3", "out 4", "out 5", "out 6"]);
		expect(render(running({ resultText: lines(90, (i) => `out ${i + 1}`) }))).toHaveLength(at5 + 1);
	});

	it("the shell's gestures ride the HEAD row's right end — no window row is spent on them", () => {
		setGround("light");
		const rows = render(running({ resultText: lines(3, (i) => `out ${i + 1}`) }));
		expect(inner(rows[1]!)).toMatch(/running · 1s · esc stops · alt\+⏎ redirects$/);
	});

	it("THE SETTLE NEVER SHRINKS — at every output length, the settled card is at least as tall", () => {
		setGround("light");
		for (const n of [0, 1, 3, 5, 6, 40, 90]) {
			const text = n === 0 ? "" : lines(n, (i) => `out ${i + 1}`);
			const live = render(running({ resultText: text })).length;
			const settled = render(tool({ resultText: text })).length;
			expect(settled, `${n} lines: the settle gave ${live - settled} rows back`).toBeGreaterThanOrEqual(live);
			expect(settled - live, `${n} lines: the settle added more than the foot`).toBeLessThanOrEqual(1);
		}
	});
});

/**
 * DC-48 — a card's head row is ONE row at every width (the owner's
 * dogfood: a 113-column row at 80 columns killed the session). THE
 * FIXTURE DOES NOT SIT AT A BOUNDARY (DC-45's lesson): one command long
 * enough to overflow every width, walked from 20 to 200.
 */
describe("DC-48 — the card's rows fit, at every width", () => {
	const CMD = "find ~ -maxdepth 3 -type d \\( -iname '*kiso*' \\) 2>/dev/null | grep -v node_modules | head -40";

	for (const [label, over] of [
		["running", { state: "running", doneAt: null, startedAt: 9_000, resultText: "" }],
		["settled", { resultText: "" }],
		["settled with a body", { resultText: lines(40, (i) => `row ${i} ${"x".repeat(i * 3)}`) }],
	] as const) {
		it(`${label}: no row is wider than the terminal, and the elapsed survives`, () => {
			for (const g of ["light", "unknown"] as const) {
				setGround(g);
				for (let W = 20; W <= 200; W += 1) {
					const rows = cellComponent(tool({ input: CMD, inputFull: JSON.stringify({ command: CMD }), ...over })).render(W, CTX);
					for (const row of rows) expect(visibleWidth(row), `${label} ${g} W=${W}: ${JSON.stringify(plain(row))}`).toBeLessThanOrEqual(W);
					expect(rows.map(plain).join("\n"), `${label} ${g} W=${W}: the elapsed was cut away`).toMatch(/\d+\.?\d*s/);
				}
			}
		});
	}

	it("a long target elides in its MIDDLE before the outcome is touched", () => {
		setGround("light");
		const path = "packages/runtime/src/deeply/nested/directory/structure/recovery-plan.ts";
		const head = inner(cellComponent(tool({ name: "read_file", input: path, inputFull: JSON.stringify({ path }), resultText: lines(9, (i) => `l${i}`) })).render(60, CTX)[1]!);
		expect(head).toMatch(/packages\/\S*…\S*\.ts/);
		expect(head).toMatch(/9 lines · 0\.1s/);
	});
});

/**
 * DC-50 / R14 — THE CARD IN ITS EXPANDED STATE is the same card: the
 * whole body, no cut note, and `ctrl+o collapses` on the foot. One
 * skeleton in both states, so the global switch changes a card's content
 * and never its shape (§7.4).
 */
describe("DC-50 — an EXPANDED card keeps the card's shape", () => {
	const long = tool({ expanded: true, resultText: lines(40, (i) => `out ${i + 1}`) });

	it("the body is the WHOLE result — an expansion that capped would be no expansion", () => {
		const said = render(long).join("\n");
		for (const n of [1, 20, 40]) expect(said, `line ${n} is missing`).toContain(`out ${n}`);
	});

	it("no cut note, and the way back is on the foot — once", () => {
		const rows = render(long).map(plain);
		expect(rows.join("\n"), "an expanded card still advertises a cut").not.toContain("ctrl+o expands");
		expect(rows.filter((r) => r.includes("ctrl+o collapses")).length, "the affordance is stated once").toBe(1);
		expect(rows.at(-1)!.trim()).toBe("ctrl+o collapses");
	});

	it("ONE SKELETON — the head row is the same in both states; only the body and the foot's words differ", () => {
		for (const g of ["light", "unknown"] as const) {
			setGround(g);
			const expandedHead = render(long).map(plain).find((r) => r.includes("npm test"))!;
			const collapsedHead = render(tool({ resultText: lines(40, (i) => `out ${i + 1}`) })).map(plain).find((r) => r.includes("npm test"))!;
			expect(expandedHead, g).toBe(collapsedHead);
		}
	});
});
