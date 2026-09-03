/**
 * TUI2-R1.5 slice ⑨ — VD-10: word-aware wrap.
 *
 * The walkthrough read "ex pected.", "re al model" and "stops i t and
 * sends" off the screen. Every wrap in the product was foldLine, a hard
 * character fold at the width — correct for verbatim output, wrong for
 * prose, because a reader's eye has to reassemble the word.
 *
 * The rule: text a HUMAN reads wraps at word boundaries; text a TOOL
 * produced stays verbatim. A single word longer than the width still
 * hard-breaks, because the alternative is a row that overflows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldWords } from "../src/components.js";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

describe("TUI2-R1.5 ⑨ — foldWords (VD-10)", () => {
	it("breaks at spaces, never mid-word — the walkthrough's own 'expected'", () => {
		const rows = foldWords("this is exactly what I expected.", 22);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(22);
		expect(rows.join("\n")).not.toContain("ex\npected");
		expect(rows.every((r) => !r.startsWith(" "))).toBe(true);
		expect(rows.join(" ").replace(/\s+/g, " ").trim()).toBe("this is exactly what I expected.");
	});

	it("a word LONGER than the width still hard-breaks — an overflowing row is worse", () => {
		const rows = foldWords(`start ${"x".repeat(50)} end`, 20);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
		expect(rows.join("")).toContain("x".repeat(50));
	});

	it("an explicit newline is a row break, as in foldLine", () => {
		expect(foldWords("one two\nthree four", 40)).toEqual(["one two", "three four"]);
	});

	it("SGR spans survive the wrap — closed at the break, reopened after", () => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const rows = foldWords("\x1b[1mbold words here that wrap\x1b[0m", 12);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) {
			const opens = (row.match(/\x1b\[1m/g) ?? []).length;
			expect(opens).toBeGreaterThan(0);
		}
	});

	it("the empty string is one empty row — the foldLine contract", () => {
		expect(foldWords("", 20)).toEqual([""]);
	});
});

describe("TUI2-R1.5 ⑨ — the surfaces that wrap by word (VD-10)", () => {
	const render = (cell: BodyCell, W: number): string[] => cellComponent(cell).render(W, CTX);

	// the ASSISTANT-text cell retired at TT-1B (assistant prose renders as
	// md blocks since TUI2-MD; the tui2-md tests pin the word-wrap claim)

	it("a NOTICE wraps at words too — it is a sentence for a human", () => {
		const rows = render({ kind: "notice", text: "the run was interrupted before it finished", done: true } as BodyCell, 20);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
		expect(rows.join("\n")).not.toMatch(/interrup\ntsed|interr\nupted/);
	});

	it("a RAW block wraps by word only when the CALLER says so — verbatim is the default", () => {
		const line = "keys  enter sends · ctrl+J newline · esc stops the run · @ files";
		const verbatim = render({ kind: "raw", lines: [line], done: true } as BodyCell, 24);
		const words = render({ kind: "raw", lines: [line], done: true, wrap: "words" } as BodyCell, 24);
		expect(verbatim.join("\n")).not.toBe(words.join("\n"));
		// the word-wrapped form never splits a word; the verbatim form does
		expect(words.every((r) => r.length <= 24)).toBe(true);
		expect(words.join(" ").replace(/\s+/g, " ").trim()).toBe(line.replace(/\s+/g, " ").trim());
	});

	it("TOOL OUTPUT stays verbatim — a hard fold, byte for byte", () => {
		const cell = {
			kind: "tool",
			name: "shell",
			input: JSON.stringify({ command: "x" }),
			inputFull: JSON.stringify({ command: "x" }),
			childRoles: [],
			state: "done",
			isError: false,
			resultText: "aaaa bbbb cccc dddd eeee",
			diff: null,
			added: 0,
			removed: 0,
			startedAt: 1,
			doneAt: 2,
			done: true,
			expanded: true,
			turn: 0,
			reason: null,
			verdict: null,
		} as unknown as BodyCell;
		// R8a: the block's rows are indented, not guttered — the corner
		// opens the first one and the rest carry the same four columns.
		const rows = render(cell, 14).filter((r) => (r.startsWith("  └ ") || r.startsWith("    ")) && !r.includes("ctrl+o"));
		// the hard fold splits mid-word at the width; a word wrap would not
		expect(rows.some((r) => /\S$/.test(r) && !/ $/.test(r))).toBe(true);
		expect(rows.join("").replace(/ {2}└ | {4}/g, "")).toBe("aaaa bbbb cccc dddd eeee".replace(/ /g, " "));
	});
});
