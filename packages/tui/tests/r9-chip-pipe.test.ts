import { describe, expect, it } from "vitest";
import { Body } from "../src/compositor.js";

/**
 * R9 P1 + Q3 — THE PIPE, and why it does not move.
 *
 * The brief expected a re-pin here: the wash is a background that
 * `COLOR_OFF` empties, so P1 is free, but a word fold changes WHERE a
 * row breaks and a long chip's piped rows would break elsewhere. It
 * does not arise, and the reason is structural rather than lucky — the
 * chip HAS no pipe form. A Body whose `active()` is false (piped stdin,
 * NO_COLOR, a terminal under four rows) never builds a `user` cell at
 * all; it writes the line-mode `you> …` record and returns. So no
 * folding happens on that path, at any width, and law 1.2's "strip
 * every escape sequence and no fact is lost" is answered by the line
 * form, not by the block.
 *
 * Asserted rather than argued, because the argument is exactly the kind
 * that stops being true when someone makes the chip the pipe form too.
 */
describe("R9 — the chip has no pipe form, so neither change moves a piped byte", () => {
	it("an INACTIVE body writes the line-mode record, never a padded block", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => false, height: () => 24, width: () => 56, editCol: () => 1, write: (s: string) => writes.push(s) });
		body.userLine("alpha bravo charlie delta echo foxtrot golf hotel india");
		const out = writes.join("");
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("you> alpha bravo charlie delta echo foxtrot golf hotel india\n");
		// the chip's own shape: a leading pad space and a run of trailing
		// ones. Neither may appear on this path at any width.
		expect(out).not.toMatch(/ {3,}/);
	});
});

/**
 * R9 P2 — the SLAB does not reach a pipe either, and for the same
 * structural reason.
 *
 * The brief expected a re-pin here: D4 puts five tail rows and a note
 * row back on a settled shell, and those looked like rows the `--plain`
 * identity gate would have to re-pin. They are not, because an inactive
 * Body never builds a tool CELL: `toolResult` writes the line-mode
 * record (`renderToolSummary` plus the folded `[result]`) and returns.
 * No cell, no block, no slab.
 *
 * Which means the surface question and the pipe question do not touch:
 * the wash is a background `COLOR_OFF` empties, and the rows it would
 * have painted are not on that path at all. Asserted, because the
 * argument stops being true the moment someone renders cells into a
 * pipe.
 */
describe("R9 P2 — the slab has no pipe form, so D4's rows re-pin nothing", () => {
	it("an INACTIVE body writes the line-mode tool record, never a block", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s: string) => writes.push(s) });
		body.toolStart("shell", "c1", { command: "pwd && ls -la" });
		body.toolResult("c1", { content: Array.from({ length: 88 }, (_, i) => `row ${i + 1}`).join("\n"), isError: false });
		const out = writes.join("");
		// none of the slab's rows: no note, no outcome row, no indent block
		expect(out).not.toContain("earlier line");
		expect(out).not.toContain("exit 0 · 88 lines");
		expect(out).not.toMatch(/^ {4}row /m);
		// and no surface of any kind
		expect(out).not.toContain("\x1b[48;5;255m");
		expect(out).not.toContain("\x1b[48;5;236m");
		expect(out).not.toContain("\x1b[7m");
		// what it DOES write is the line-mode record
		expect(out).toContain("[result]");
	});
});
