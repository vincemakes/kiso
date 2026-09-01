/**
 * R8a — A TOOL BLOCK'S ROWS ARE INDENTED, NOT GUTTERED.
 *
 * `│ ` on every row of a call's output drew a bar down the left of the
 * screen, several rows tall, under every multi-row result. The owner
 * pointed at it repeatedly and asked for the corner form instead.
 *
 * The bar was carrying something real — "these rows are the call's
 * output, not prose" — and law 1.2 requires that survive a pipe, so it
 * moves into the INDENT: four columns, one deeper than prose and than
 * the header row, which is a fact in plain bytes. `└` stays as the mark
 * that OPENS a block, exactly once, on its first row WITH CONTENT; the
 * in-block notes (`+N earlier rows`, `waiting for output`, the collapse
 * footer) take the same indent with no glyph, because a second `└`
 * inside one block is one mark meaning two things (§4.1).
 *
 * NOT in scope, and gated here so it stays that way: the diff's `│` is
 * a SCOPE mark, which §1.1 keeps.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cellComponent, exploreRows, type BodyCell, type FrameCtx } from "../src/components.js";


const CTX: FrameCtx = { spinnerI: 0, now: 13_000, height: 30 };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const ORIG_TTY: boolean | undefined = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => setTTY(ORIG_TTY ?? false));

/** the canonical factory, from tui2-r1-live-tail.test.ts */
function tool(over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): BodyCell {
	return {
		kind: "tool", name: "shell", input: "npm test", inputFull: JSON.stringify({ command: "npm test" }),
		childRoles: [], state: "done", isError: false, resultText: "one\ntwo\nthree",
		diff: null, added: 0, removed: 0, startedAt: 1_000, doneAt: 3_400,
		done: true, expanded: false, turn: 0, rolled: null, reason: null, verdict: null,
		...over,
	} as BodyCell;
}
const body = (cell: BodyCell, W = 80): string[] => cellComponent(cell).render(W, CTX).slice(1).map(plain).filter((r) => r.trim() !== "");

describe("R8a — no bar, and exactly one corner", () => {
	it("a multi-row output carries no vertical bar at all", () => {
		const rows = body(tool({ expanded: true }));
		expect(rows.length).toBeGreaterThan(2);
		for (const r of rows) expect(r, `a bar survived: ${JSON.stringify(r)}`).not.toMatch(/^\s*│/);
	});

	it("the corner opens the block ONCE — never on a note, never twice", () => {
		for (const cell of [tool({ expanded: true }), tool({ state: "running", resultText: "building…" }), tool({ state: "running", resultText: "" }), tool({ isError: true, resultText: "e1\ne2\ne3\ne4\ne5" })]) {
			const rows = body(cell);
			const corners = rows.filter((r) => r.trimStart().startsWith("└"));
			expect(corners.length, `corners: ${JSON.stringify(rows)}`).toBe(1);
			expect(rows.indexOf(corners[0]!), "the corner is not the block's first row").toBe(0);
		}
	});

	it("the corner never lands on a row with nothing on it", () => {
		// a leading blank output line used to take the corner
		const rows = body(tool({ expanded: true, resultText: "\n\nfirst real line\nsecond" }));
		const corner = rows.find((r) => r.trimStart().startsWith("└"))!;
		expect(corner.replace(/^\s*└\s*/, ""), "the corner marks an empty row").not.toBe("");
	});
});

describe("R8a — the indent is the fact, and it survives a pipe", () => {
	it("with the palette OFF, an output row is still four columns in and prose is two", () => {
		setTTY(false); // the palette is OFF — a pipe, which is where §1.2 is tested
		const rows = body(tool({ expanded: true }));
		// every row of the block sits at column 4 — the corner takes two
		// of those columns, so the text starts in the same place either way
		for (const r of rows) {
			expect(r.startsWith("    ") || r.startsWith("  └ "), `not the block indent: ${JSON.stringify(r)}`).toBe(true);
		}
	});

	it("the text column is the same on the corner row and the rows under it", () => {
		const rows = body(tool({ expanded: true }));
		const col = (r: string): number => r.length - r.replace(/^(?: {4}| {2}└ )/, "").length;
		expect(new Set(rows.map(col)).size, "the block's rows do not share one text column").toBe(1);
		expect(col(rows[0]!)).toBe(4);
	});
});

describe("R8a — the notes join the block", () => {
	it("the collapse footer is an indented note, not a second corner", () => {
		const rows = body(tool({ expanded: true }));
		const last = rows[rows.length - 1]!;
		expect(last).toContain("ctrl+r collapses");
		expect(last.startsWith("    ")).toBe(true);
	});

	it("the rollup's expansion opens with a corner and closes with a note", () => {
		const rows = exploreRows([{ name: "read_file", subjects: ["a.ts", "b.ts"] }, { name: "search_text", subjects: ["x"] }], 80).map(plain);
		expect(rows[0]!.startsWith("  └ ")).toBe(true);
		expect(rows.filter((r) => r.trimStart().startsWith("└")).length).toBe(1);
		expect(rows[rows.length - 1]!.startsWith("    ")).toBe(true);
	});
});

describe("R8a — the diff's bar is a SCOPE mark and is NOT touched", () => {
	it("a diff still carries its gutter", () => {
		const rows = cellComponent(tool({ name: "edit_file", state: "approval", diff: [{ kind: "add", text: "const x = 1;" }, { kind: "del", text: "const y = 2;" }] } as never)).render(80, CTX).map(plain);
		expect(rows.some((r) => r.startsWith("│")), `no diff gutter: ${JSON.stringify(rows)}`).toBe(true);
	});
});
