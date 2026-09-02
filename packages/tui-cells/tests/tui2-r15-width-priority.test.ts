/**
 * TUI2-R1.5 pin 4 — the settled head row's cut PRIORITY.
 *
 * Slice ⑤ reserved the affordance, which stopped the row going silent
 * about hidden content. It did not say WHICH of the remaining parts
 * gives way first, and gutterCut's single `widthCut` at the end meant
 * the answer was "whatever happens to be last" — the parens. The
 * integrator's walkthrough caught both failure modes:
 *
 *   ✓ shell printf '…' 1 2 … 12 (exit 0 · approv… · ctrl+o
 *   ✓ shell for i in 1 2 3 …                          … · ctrl+o
 *
 * The first is an UNCLOSED parenthesis — the row states the beginning of
 * a fact and stops. The second lost the exit code and the duration
 * entirely: the command text, which is the most compressible thing on
 * the row, ate the two facts the row exists to report.
 *
 * The order, tightest last:
 *   1. the affordance always survives (⑤'s reserve);
 *   2. the parens' RESULT CORE always renders whole, closing paren
 *      included — `(exit 0, 3.0s)`, `(+1 -1, 0.2s)`;
 *   3. the ATTRIBUTION segment drops before the core is touched;
 *   4. the COMMAND/target is what truncates, with `…`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellComponent, visibleWidth, type BodyCell, type FrameCtx } from "../src/components.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

/** The walkthrough's own S1 command — 62 cells. */
const S1 = "printf 'test %s of the suite passed\\n' 1 2 3 4 5 6 7 8 9 10 11 12";
/** The walkthrough's own S2 command — 97 cells. */
const S2 = 'for i in 1 2 3 4 5 6; do echo "step $i · compiling module $i of 6"; sleep 1; done; echo build done';

function shell(command: string, over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): BodyCell {
	return {
		kind: "tool",
		name: "shell",
		input: JSON.stringify({ command }).slice(0, 60),
		inputFull: JSON.stringify({ command }),
		childRoles: [],
		state: "done",
		isError: false,
		resultText: "a\nb\nc\nd\ne\nf",
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 8_000,
		doneAt: 11_000,
		done: true,
		expanded: false,
		turn: 0,
		rolled: null,
		reason: null,
		verdict: { decision: "approved" },
		...over,
	} as BodyCell;
}

const row = (cell: BodyCell, W: number): string => cellComponent(cell).render(W, CTX)[0]!;

describe("TUI2-R1.5 pin 4 — the parens never break", () => {
	it("the walkthrough's S1 row closes its parenthesis at 100 cols", () => {
		const r = row(shell(S1), 100);
		expect(r).not.toContain("approv…");
		expect(r).toMatch(/\(exit 0, 3\.0s\)/);
		expect(r).toContain("ctrl+o");
		expect(visibleWidth(r)).toBeLessThanOrEqual(100);
	});

	it("the walkthrough's S2 row keeps exit AND duration at 100 cols", () => {
		const r = row(shell(S2), 100);
		expect(r).toMatch(/\(exit 0, 3\.0s\)/);
		expect(r).toContain("…"); // the COMMAND is what gave way
		expect(r).toContain("ctrl+o");
		expect(visibleWidth(r)).toBeLessThanOrEqual(100);
	});

	it("the ATTRIBUTION drops before the core is touched — the boundary width", () => {
		// wide enough for the whole row: the verdict is there
		expect(row(shell("echo hi"), 60)).toContain("· approved");
		// squeezed: the verdict goes, the core stays whole
		const tight = row(shell(S1), 56);
		expect(tight).not.toContain("approved");
		expect(tight).toMatch(/\(exit 0, 3\.0s\)/);
		expect(tight).toContain("ctrl+o");
	});

	it("EVERY width from 24 to 120: the parens are whole or absent, never cut open", () => {
		for (const command of [S1, S2, "echo hi"]) {
			for (let W = 24; W <= 120; W += 1) {
				const r = row(shell(command), W);
				expect(visibleWidth(r), `W=${W}`).toBeLessThanOrEqual(W);
				const opens = (r.match(/\(/g) ?? []).length;
				const closes = (r.match(/\)/g) ?? []).length;
				expect(opens, `W=${W} unbalanced parens: ${r}`).toBe(closes);
				// and when a paren group IS present it carries the whole core
				// whole means: opens with the result, closes with the timing —
				// the attribution rides between them only while there is room
				if (opens > 0) expect(r, `W=${W}: ${r}`).toMatch(/\(exit 0(?: · approved)?, 3\.0s\)/);
			}
		}
	});

	it("an EDIT card's core is the ± pair, and it is whole at every width too", () => {
		const edit = shell("x", { name: "edit_file", inputFull: JSON.stringify({ path: "src/some/deep/path/parser.ts" }), added: 1, removed: 1, resultText: "edited" }) as BodyCell;
		for (let W = 24; W <= 120; W += 1) {
			const r = row(edit, W);
			expect(visibleWidth(r), `W=${W}`).toBeLessThanOrEqual(W);
			const opens = (r.match(/\(/g) ?? []).length;
			if (opens > 0) expect(r, `W=${W}: ${r}`).toMatch(/\(\+1 -1(?: · approved)?, 3\.0s\)/);
		}
	});

	it("the affordance survives every width that has a paren group at all", () => {
		for (let W = 30; W <= 120; W += 1) {
			const r = row(shell(S2), W);
			expect(r, `W=${W}: ${r}`).toContain("ctrl+o");
		}
	});
});
