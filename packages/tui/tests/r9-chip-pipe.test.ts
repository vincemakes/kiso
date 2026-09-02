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
