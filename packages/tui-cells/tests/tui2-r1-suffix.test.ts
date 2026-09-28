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

// Graphite §7.4 (the card, unpainted — colour off here): the key rides
// the HEAD row's end on a card with no body (a read), and the FOOT on a
// card whose body was cut; a card hiding nothing names no key at all.
const HEAD = (verb: string, target: string, outcome: string): RegExp => new RegExp(`^ {6}${verb} +${target.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} +${outcome.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);

describe("TUI2-R1 T-V1 — the self-naming key", () => {
	it("a collapsed cell that hides its whole body names the key on its head row, with the REAL line count", () => {
		setTTY(false);
		const rows = render(toolCell({ resultText: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(HEAD("READ", "src/parser.ts", "12 lines · 2.4s · ctrl+o expands"));
	});

	it("a shell whose settled tail is CUT names the key on its FOOT, once", () => {
		setTTY(false);
		const rows = render(
			toolCell({
				name: "shell",
				input: "npm test",
				inputFull: JSON.stringify({ command: "npm test" }),
				resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
			}),
		);
		expect(rows[0]).toMatch(HEAD("SHELL", "npm test", "exit 0 · 22 lines · 2.4s"));
		expect(rows).toContain("      \u2514 \u2026 17 earlier lines");
		expect((rows.join("\n").match(/ctrl\+o/g) ?? []).length, "exactly one affordance for the cell").toBe(1);
		expect(rows.at(-1)!.trim()).toBe("ctrl+o expands");
	});

	it("a cell that hides NOTHING names no key — the empty result, and a whole tail", () => {
		setTTY(false);
		const empty = render(toolCell({ name: "shell", input: "echo hi", inputFull: JSON.stringify({ command: "echo hi" }), resultText: "" }));
		expect(empty).toHaveLength(1);
		expect(empty[0]).toMatch(HEAD("SHELL", "echo hi", "exit 0 · 2.4s"));
		expect(render(toolCell({ resultText: "" }))[0]).toMatch(HEAD("READ", "src/parser.ts", "0 lines · 2.4s"));
		const whole = render(toolCell({ name: "shell", input: "echo hi", inputFull: JSON.stringify({ command: "echo hi" }), resultText: "hi" }));
		expect(whole).toHaveLength(2);
		expect(whole[0]).toMatch(HEAD("SHELL", "echo hi", "exit 0 · 1 line · 2.4s"));
		expect(whole[1]).toBe("      \u2514 hi");
		expect(whole.join("\n")).not.toContain("ctrl+o");
	});

	it("the key gives way last — the full key, then the bare key; the elapsed outlasts the count", () => {
		setTTY(false);
		const cell = toolCell({
			name: "read_file",
			input: "src/parser.ts",
			inputFull: JSON.stringify({ path: "src/parser.ts" }),
			resultText: Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n"),
		});
		const tierAt = (W: number): string => {
			const row = render(cell, W)[0]!;
			const count = row.includes("22 lines");
			if (count && row.includes("ctrl+o expands")) return "full";
			if (count && row.includes("ctrl+o")) return "terse";
			if (row.includes("2.4s · ctrl+o")) return "key";
			return "absent";
		};
		expect(tierAt(80)).toBe("full");
		expect(tierAt(48)).toBe("terse");
		expect(tierAt(36)).toBe("terse");
		expect(tierAt(24)).toBe("key");
		for (const W of [20, 24, 32, 36, 44, 48, 60, 80, 120]) {
			for (const row of render(cell, W)) expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
		}
	});

	it("an EXPANDED block offers the way back on its FOOT", () => {
		setTTY(false);
		const rows = render(toolCell({ expanded: true, resultText: "alpha\nbeta\ngamma" }));
		expect(rows[0]).toMatch(HEAD("READ", "src/parser.ts", "3 lines · 2.4s"));
		expect(rows.slice(1, 4)).toEqual(["      \u2514 alpha", "        beta", "        gamma"]);
		expect(rows.at(-1)!.trim()).toBe("ctrl+o collapses");
		expect(rows.filter((r) => r.includes("ctrl+o collapses"))).toHaveLength(1);
		expect(rows.join("\n")).not.toContain("expands");
	});

	it("the key is DIM, on the head row's outcome and on the foot", () => {
		setTTY(true);
		const rows = render(toolCell({ resultText: "a\nb\nc" }));
		expect(rows[0]!.endsWith("\x1b[2m3 lines · 2.4s · ctrl+o expands\x1b[0m"), JSON.stringify(rows[0])).toBe(true);
		const expanded = render(toolCell({ expanded: true, resultText: "a\nb\nc" }));
		expect(expanded.at(-1)!.trimStart()).toBe("\x1b[2mctrl+o collapses\x1b[0m");
	});

	it("a running / queued / approval / denied cell never says `expands` — the affordance is a settled-cell statement", () => {
		setTTY(false);
		expect(render(toolCell({ state: "running", done: false, resultText: "" })).join("\n")).not.toContain("expands");
		expect(render(toolCell({ state: "pending", done: false })).join("\n")).not.toContain("expands");
		expect(render(toolCell({ state: "approval", done: false })).join("\n")).not.toContain("expands");
		expect(render(toolCell({ reason: "not allowed", isError: true, resultText: "[Permission denied] not allowed" })).join("\n")).not.toContain("expands");
	});

	it("an errored cell previews its text, and its one affordance is the foot", () => {
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
		expect(rows[0]).toMatch(HEAD("SHELL", "npm test", "exit 1 · 10 lines · 2.4s"));
		expect(rows.join("\n")).toContain("\u2026 5 more lines");
		expect(rows.at(-1)!.trim()).toBe("ctrl+o expands");
		expect((rows.join("\n").match(/ctrl\+o/g) ?? []).length, "one affordance for the cell").toBe(1);
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
