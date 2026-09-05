/**
 * TUI2-R1 slice ② — T-V1: A, the tool card names its own expand key.
 *
 * ctrl+o has existed since W15 and lived only in /help. A collapsed cell
 * that is HIDING something now says so, in the cell, with the REAL count
 * of what it hides; an expanded block says how to put it back.
 *
 * The rules the suffix obeys (each pinned below):
 *
 *   - it appears only when expanding would SHOW MORE. A settled cell
 *     whose body is already whole carries nothing — the affordance is a
 *     statement about hidden content, and inventing one over a fully
 *     visible cell would be noise that lies.
 *   - the count is the result's real line count, never a guess.
 *   - it never costs the row its content: the suffix takes the width
 *     that is LEFT, degrading full → terse → absent (the prototype's
 *     three collapsed forms are the three tiers), and a head row that
 *     already fills the terminal keeps every byte it has today.
 *   - the PIPE is untouched. Suffixes are a TTY-render concern; the
 *     pipe path's bytes (renderToolSummary / foldResult / terminalPipe)
 *     are transcribed literals here and must not move.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";
import { foldResult, renderToolSummary, terminalPipe } from "../src/index.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

function toolCell(over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> {
	return {
		kind: "tool",
		name: "read_file",
		input: "src/parser.ts",
		inputFull: JSON.stringify({ path: "src/parser.ts" }),
		childRoles: [],
		state: "done",
		isError: false,
		resultText: "",
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 1_000,
		doneAt: 3_400,
		done: true,
		expanded: false,
		turn: 0,
		reason: null,
		verdict: null,
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
}

const render = (cell: BodyCell, W = 80): string[] => cellComponent(cell).render(W, CTX);

describe("TUI2-R1 T-V1 — the self-naming suffix", () => {
	it("a collapsed cell that hides its whole body names the key with the REAL line count", () => {
		setTTY(false);
		const rows = render(toolCell({ resultText: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }));
		// the settled head row, plus the suffix — the count is the result's
		// own lines, not a row count and not a cap
		// MOVED (R1.5 slice ⑤, the R1 tool-cell suffix class): the count is
		// stated EXACTLY ONCE now (VD-6). This very row is the one the
		// walkthrough quoted: the parens and the suffix were written by
		// different rounds, each unaware the other was counting.
		// R13 MOVED THIS ASSERTION: one grammar for both cards. The head
		// row's W4 parentheses became the `·` chain the bodied card's
		// outcome row already used, and the COUNT moved out of the suffix
		// into that chain, where it is still stated exactly once.
		expect(rows[0]).toBe("  read  src/parser.ts · 12 lines · 2.4s · ctrl+o expands");
		// nothing else changed: the collapsed body is still empty
		expect(rows).toHaveLength(1);
	});

	// DECLARED REVERSAL (R9 P2 / D4): a settled shell has its tail back, so
	// the key is named by the SLAB'S NOTE ROW rather than by a head-row
	// suffix. TUI2-R1's rule is unchanged and is what forces the move —
	// two affordances for one cell is exactly what it forbids, and the
	// note row is the one that sits where the content stops.
	it("a shell whose settled tail is CUT names the key on its NOTE row, not on the head", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "npm test",
				inputFull: JSON.stringify({ command: "npm test" }),
				resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
			}),
		);
		expect(rows[0]).toBe("  shell npm test");
		expect(rows.map((r) => r.trim().replace(/^└ /, ""))).toContain("… 17 earlier lines · ctrl+o expands");
		expect((rows.join("\n").match(/ctrl\+o/g) ?? []).length, "exactly one affordance for the cell").toBe(1);
		expect(rows.at(-1)).toBe("    exit 0 · 22 lines · 2.4s");
	});

	// MOVED AGAIN (R9 P2 / D4): the premise "the shell whose whole tail is
	// already on screen" is BACK, because the tail is. The rule the case
	// pins is unchanged — nothing hidden, no suffix — and it now has two
	// witnesses: the empty result, and a shell whose whole output fits
	// inside the cap and therefore has no note either.
	it("a cell that hides NOTHING carries NO suffix — the empty result, and a whole tail", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "echo hi",
				inputFull: JSON.stringify({ command: "echo hi" }),
				resultText: "",
			}),
		);
		expect(rows[0]).toBe("  shell echo hi · exit 0 · 2.4s");
		expect(rows.join("\n")).not.toContain("ctrl+o");
		// an empty result hides nothing for any tool
		expect(render(toolCell({ resultText: "" }))[0]).toBe("  read  src/parser.ts · 0 lines · 2.4s");
		// …and a shell whose ONE line is on screen hides nothing either: it
		// is a slab with no note, so nothing anywhere names the key.
		const whole = render(toolCell({ name: "shell", input: "echo hi", inputFull: JSON.stringify({ command: "echo hi" }), resultText: "hi" }));
		expect(whole.map((r) => r.trim().replace(/^└ /, ""))).toEqual(["shell echo hi", "hi", "exit 0 · 1 line · 2.4s"]);
		expect(whole.join("\n")).not.toContain("ctrl+o");
	});

	// MOVED (R9 P2 / D4): the fixture is a READ now, not a shell. The rule
	// this case pins — the suffix degrades full → terse → key, and never
	// pushes a row past the width — is unchanged and applies wherever a
	// head row still CARRIES a suffix. A settled shell no longer does: its
	// note row names the key instead, so it is the wrong witness for a
	// head-row rule, not a counter-example to it.
	it("the suffix takes the width that is LEFT — full, then terse, then key (the prototype's three forms)", () => {
		setTTY(false);
		const cell = toolCell({
			name: "read_file",
			input: "src/parser.ts",
			inputFull: JSON.stringify({ path: "src/parser.ts" }),
			resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
		});
		const tierAt = (W: number): string => {
			const row = render(cell, W)[0]!;
			// R13: the COUNT lives in the head's own `·` chain now and the
			// affordance in the suffix, so the two are no longer adjacent.
			// The LADDER is unchanged — full, terse, key, and the key is
			// reserved — and that is what the tiers below still pin.
			const count = row.includes("· 22 lines");
			if (count && row.includes("ctrl+o expands")) return "full";
			if (count && row.includes("ctrl+o")) return "terse";
			if (row.includes("· ctrl+o")) return "key";
			return "absent";
		};
		expect(tierAt(80)).toBe("full");
		expect(tierAt(48)).toBe("terse");
		expect(tierAt(36)).toBe("key");
		// TUI2-R1.5 ⑤: the shortest tier is RESERVED — the affordance is the
		// semantics, so it never degrades to nothing while there is a cell
		// hiding something.
		expect(tierAt(24)).toBe("key");
		// invariant ①: the suffix NEVER pushes a row past the width
		for (const W of [20, 24, 32, 36, 44, 48, 60, 80, 120]) {
			for (const row of render(cell, W)) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	// DECLARED SUPERSESSION (DC-50 / R14, 2026-09-05) — THE WAY BACK MOVED
	// ONTO THE OUTCOME ROW.
	//
	// The footer used to be a row of its own at the end of the block, and
	// the expanded card's head row carried the outcome inline. That gave
	// the expanded card a DIFFERENT skeleton from the collapsed one,
	// which was tolerable while an expanded card was rare and stopped
	// being tolerable when §7.7 made ctrl+o expand every settled card at
	// once. Both states are pad · head · blank · body · blank · outcome ·
	// pad now: the head row says only what was run, and the outcome row
	// says what happened AND how to put it back.
	//
	// The claim this case makes is unchanged — an expanded block offers
	// the way back, exactly once, and does not also advertise expanding
	// what is already expanded. Only its address moved.
	it("an EXPANDED block offers the way back on its OUTCOME row", () => {
		setTTY(false);
		const rows = render(toolCell({ expanded: true, resultText: "alpha\nbeta\ngamma" }));
		// R8a (owner-ruled 2026-09-01): a tool block's rows are INDENTED, not
		// guttered — `└` opens the block once, on its first row with content,
		// and every other row is the same four-column indent with no glyph.
		expect(rows).toEqual([
			"  read  src/parser.ts",
			"  └ alpha",
			"    beta",
			"    gamma",
			"    3 lines · 2.4s · ctrl+o collapses",
		]);
		// the expanded head row drops the collapsed suffix — it would be
		// telling the reader to expand what is already expanded
		expect(rows[0]).not.toContain("expands");
		// and the way back is stated ONCE, not on both rows
		expect(rows.filter((r) => r.includes("ctrl+o collapses"))).toHaveLength(1);
	});

	it("the suffix and the footer are DIM (the prototype's placement), the head row's own SGR untouched", () => {
		setTTY(true);
		const rows = render(toolCell({ resultText: "a\nb\nc" }));
		// MOVED (R1.5 slice ⑤, the R1 tool-cell suffix class): the parens
		// lost their duplicate count (VD-6); the SGR placement — the whole
		// point of this case — is byte-identical.
		expect(rows[0]).toBe("  read  src/parser.ts · 3 lines · 2.4s\x1b[2m · ctrl+o expands\x1b[0m"); // R2: no tick
		// DC-50 / R14: the way back rides the OUTCOME row now (one skeleton
		// for both states — see the case above). The claim here is
		// unchanged and is about SGR PLACEMENT: the dim opens the row and
		// the reset closes it, with nothing of the head row's own styling
		// leaking in. It is asserted structurally rather than as one
		// literal, because the metadata inside it belongs to §7.5's tier
		// ladder and moves when the ladder does — pinning the whole string
		// would make every metadata change land in an SGR case.
		const expanded = render(toolCell({ expanded: true, resultText: "a\nb\nc" }));
		const last = expanded[expanded.length - 1]!;
		expect(last.startsWith("\x1b[2m"), `the outcome row does not open dim: ${JSON.stringify(last)}`).toBe(true);
		expect(last.endsWith("\x1b[0m"), `the outcome row does not close its SGR: ${JSON.stringify(last)}`).toBe(true);
		expect(last).toContain("ctrl+o collapses");
		expect(last.slice(5, -4), "the outcome row carries SGR of its own inside").not.toMatch(/\x1b\[/);
	});

	it("a running / queued / approval / denied cell is never suffixed — the affordance is a settled-cell statement", () => {
		setTTY(false);
		expect(render(toolCell({ state: "running", done: false, resultText: "" })).join("\n")).not.toContain("expands");
		expect(render(toolCell({ state: "pending", done: false })).join("\n")).not.toContain("expands");
		expect(render(toolCell({ state: "approval", done: false })).join("\n")).not.toContain("expands");
		// a DENIED call never ran — there is nothing behind the key
		expect(
			render(toolCell({ reason: "not allowed", isError: true, resultText: "[Permission denied] not allowed" })).join("\n"),
		).not.toContain("expands");
	});

	// MOVED (R9 P2 / D4): an errored shell is a SLAB too — the head row
	// names the call and the outcome row carries `exit 1` in the failure
	// colour (R9: no tint on the object, only on the fact). The rule the
	// case pins is untouched: ONE affordance for the cell, and it is the
	// error body's own cut row.
	it("an errored cell keeps its own cut row and gains no second affordance", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "npm test",
				inputFull: JSON.stringify({ command: "npm test" }),
				isError: true,
				resultText: `exit 1: boom\n${Array.from({ length: 9 }, (_, i) => `err ${i}`).join("\n")}`,
			}),
		);
		expect(rows[0]).toBe("  shell npm test");
		expect(rows[0]).not.toContain("ctrl+o");
		expect(rows.at(-1), "the outcome closes the block").toBe("    exit 1 · 10 lines · 2.4s");
		// the error body's own renderer cut is the affordance there, unchanged
		expect((rows.join("\n").match(/ctrl\+o/g) ?? []).length, "one affordance for the cell").toBe(1);
		expect(rows.join("\n")).toContain("more lines · ctrl+o"); // R13: an error previews like any card
	});

	/**
	 * R2: the pipe KEEPS its ✓. The owner's ruling retired the mark from
	 * the interactive screen, where a row already says `exit 0` and the
	 * mark repeated it. The pipe is not that screen — it is its own
	 * design, with no gutter, no colour and no metadata column, and there
	 * the mark is the only thing carrying the state. Removing it there
	 * would drop information rather than noise.
	 */
	it("THE PIPE IS BYTE-IDENTICAL — the suffixes are a TTY-render concern and never reach a pipe", () => {
		setTTY(false); // a pipe: palette off, the line-mode renderers
		expect(renderToolSummary("shell", { command: "npm test" }, { content: "a\nb\nc", isError: false })).toBe("\u2713 shell npm test (exit 0)");
		expect(renderToolSummary("read_file", { path: "src/parser.ts" }, { content: "a\nb\nc", isError: false })).toBe(
			"\u2713 read src/parser.ts (3 lines)",
		);
		expect(foldResult("a\nb\nc")).toBe("a b c");
		expect(terminalPipe("[label]", "✦ 1s · 1 tool")).toBe("[label]\u2726 1s · 1 tool\n\n");
	});
});
