/**
 * TUI2-R1 slice ② — T-V1: A, the tool card names its own expand key.
 *
 * ctrl+r has existed since W15 and lived only in /help. A collapsed cell
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
		rolled: null,
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
		expect(rows[0]).toBe("✓ read  src/parser.ts (12 lines, 2.4s) · 12 lines · ctrl+r expands");
		// nothing else changed: the collapsed body is still empty
		expect(rows).toHaveLength(1);
	});

	it("a shell whose settled tail is CUT names the key too — the count is the full output", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "npm test",
				inputFull: JSON.stringify({ command: "npm test" }),
				resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
			}),
		);
		expect(rows[0]).toBe("✓ shell npm test (exit 0, 2.4s) · 22 lines · ctrl+r expands");
	});

	it("a NON-truncated cell carries NO suffix — the shell whose whole tail is already on screen", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "echo hi",
				inputFull: JSON.stringify({ command: "echo hi" }),
				resultText: "hi",
			}),
		);
		expect(rows[0]).toBe("✓ shell echo hi (exit 0, 2.4s)");
		expect(rows.join("\n")).not.toContain("ctrl+r");
		// an empty result hides nothing either
		expect(render(toolCell({ resultText: "" }))[0]).toBe("✓ read  src/parser.ts (0 lines, 2.4s)");
	});

	it("the suffix takes the width that is LEFT — full, then terse, then absent (the prototype's three forms)", () => {
		setTTY(false);
		const cell = toolCell({
			name: "shell",
			input: "npm test",
			inputFull: JSON.stringify({ command: "npm test" }),
			resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
		});
		expect(render(cell, 80)[0]).toBe("✓ shell npm test (exit 0, 2.4s) · 22 lines · ctrl+r expands");
		expect(render(cell, 54)[0]).toBe("✓ shell npm test (exit 0, 2.4s) · 22 lines · ctrl+r");
		expect(render(cell, 44)[0]).toBe("✓ shell npm test (exit 0, 2.4s) · ctrl+r");
		// no room at all — the row is exactly what it is today
		expect(render(cell, 32)[0]).toBe("✓ shell npm test (exit 0, 2.4s)");
		// invariant ①: the suffix NEVER pushes a row past the width
		for (const W of [20, 32, 40, 44, 54, 60, 80, 120]) {
			for (const row of render(cell, W)) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("an EXPANDED block gains the collapse footer — the way back, at the block's last row", () => {
		setTTY(false);
		const rows = render(toolCell({ expanded: true, resultText: "alpha\nbeta\ngamma" }));
		expect(rows).toEqual(["✓ read  src/parser.ts (3 lines, 2.4s)", "│ alpha", "│ beta", "│ gamma", "└ ctrl+r collapses"]);
		// the expanded head row drops the collapsed suffix — it would be
		// telling the reader to expand what is already expanded
		expect(rows[0]).not.toContain("expands");
	});

	it("the suffix and the footer are DIM (the prototype's placement), the head row's own SGR untouched", () => {
		setTTY(true);
		const rows = render(toolCell({ resultText: "a\nb\nc" }));
		expect(rows[0]).toBe("\x1b[1m✓\x1b[0m read  src/parser.ts (3 lines, 2.4s)\x1b[2m · 3 lines · ctrl+r expands\x1b[0m");
		const expanded = render(toolCell({ expanded: true, resultText: "a\nb\nc" }));
		expect(expanded[expanded.length - 1]).toBe("\x1b[2m└ ctrl+r collapses\x1b[0m");
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
		expect(rows[0]).toBe("✗ shell npm test (exit 1, 2.4s)");
		expect(rows[0]).not.toContain("ctrl+r");
		// the error body's own renderer cut is the affordance there, unchanged
		expect(rows[rows.length - 1]).toContain("more · ctrl+r");
	});

	it("THE PIPE IS BYTE-IDENTICAL — the suffixes are a TTY-render concern and never reach a pipe", () => {
		setTTY(false); // a pipe: palette off, the line-mode renderers
		expect(renderToolSummary("shell", { command: "npm test" }, { content: "a\nb\nc", isError: false })).toBe("✓ shell npm test (exit 0)");
		expect(renderToolSummary("read_file", { path: "src/parser.ts" }, { content: "a\nb\nc", isError: false })).toBe(
			"✓ read src/parser.ts (3 lines)",
		);
		expect(foldResult("a\nb\nc")).toBe("a b c");
		expect(terminalPipe("[label]", "▞ 1s · 1 tool")).toBe("[label]▞ 1s · 1 tool\n\n");
	});
});
