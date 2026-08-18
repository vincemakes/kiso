/**
 * Finding R3v2-F1 — the safer-options degradation COPY, and which
 * sentence a given failure earns.
 *
 * These pins moved here from the CLI's suite when the copy did. The
 * words a panel shows belong next to the panel that shows them: with
 * both sentences in one file, a change to either is visibly a change to
 * a pair, and the CLI side is left owning what it can actually prove —
 * the CAUSE, not the phrasing.
 *
 * The pair is deliberately near-identical. The human reading it is
 * mid-approval with a destructive command on screen, and they have
 * already learned the shape of the first sentence; the second earns its
 * difference by naming a cause and changes nothing else, so it reads as
 * the same reassurance with one more fact in it.
 */
import { describe, expect, it } from "vitest";
import { SAFER_DEGRADED, SAFER_DEGRADED_TRUNCATED, saferDegradedNote, type SaferOption } from "../src/approval-panel.js";

describe("R3v2-F1 — the two degradation lines", () => {
	it("the unqualified line is exactly what it has always been", () => {
		expect(SAFER_DEGRADED).toBe("couldn't get safer options — the original choices stand");
	});

	it("the truncated line names the cause and keeps everything else", () => {
		expect(SAFER_DEGRADED_TRUNCATED).toBe(
			"couldn't get safer options (the reply was cut short) — the original choices stand",
		);
	});

	it("both LEAD with the failure and END with what is still true", () => {
		// the load-bearing half is the second one: the human needs to know
		// they can keep going, not what went wrong on our side.
		for (const line of [SAFER_DEGRADED, SAFER_DEGRADED_TRUNCATED]) {
			expect(line.startsWith("couldn't get safer options")).toBe(true);
			expect(line.endsWith("the original choices stand")).toBe(true);
		}
	});
});

describe("R3v2-F1 — saferDegradedNote picks the sentence", () => {
	it("a named cause gets the sentence that names it", () => {
		expect(saferDegradedNote({ reason: "truncated" })).toBe(SAFER_DEGRADED_TRUNCATED);
	});

	it("a bare null is a failure with nothing to add — the original line", () => {
		expect(saferDegradedNote(null)).toBe(SAFER_DEGRADED);
	});

	it("an EMPTY list is a failure too, and it has nothing to add either", () => {
		expect(saferDegradedNote([])).toBe(SAFER_DEGRADED);
	});

	it("a real answer never reaches the note at all, and still would not lie", () => {
		// the editor routes a non-empty list to the list phase; this pins
		// that the fallback could not invent a diagnosis even if it did.
		const options: SaferOption[] = [{ command: "npm run build", why: "keeps build/" }];
		expect(saferDegradedNote(options)).toBe(SAFER_DEGRADED);
	});
});
