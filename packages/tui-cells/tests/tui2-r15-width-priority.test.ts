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
		reason: null,
		verdict: { decision: "approved" },
		...over,
	} as BodyCell;
}

const rows = (cell: BodyCell, W: number): string[] => cellComponent(cell).render(W, CTX);
const row = (cell: BodyCell, W: number): string => rows(cell, W)[0]!;
/** MOVED (R9 P2 / D4): a settled shell with output is a SLAB, so the
 *  paren core that used to ride its head row now rides the OUTCOME row,
 *  in the slab's own grammar (`exit 0 · 6 lines · 3.0s · approved`).
 *  Pin 4's rule is unchanged and is what these cases still measure: the
 *  parts give way in a pinned order — attribution first, then the count
 *  — and the core is never cut open. The row it is measured on moved
 *  because the fact moved. */
// Graphite §7.4: the outcome rides the HEAD row's right end, two or more
// spaces after the target.
// (At the narrowest widths the target gives way and the verb stands right
// before the outcome: `SHELL exit 0 · 3.0s`.)
const outcome = (cell: BodyCell, W: number): string =>
	row(cell, W)
		.split(/ {2,}/)
		.at(-1)!
		.trim()
		.replace(/^[A-Z]+ /, "");

describe("TUI2-R1.5 pin 4 — the parens never break", () => {
	// (Graphite R1f: the head starts at the content edge, column 2 — four
	// columns earlier than it did — so the row that has to give way is 96.)
	it("the walkthrough's S1 block: its whole chain at 120 cols; at 96 the attribution and the count give way before the command does", () => {
		expect(outcome(shell(S1), 120)).toBe("exit 0 · 6 lines · 3.0s · approved");
		expect(outcome(shell(S1), 96)).toBe("exit 0 · 3.0s");
		expect(row(shell(S1), 96)).toContain(S1.replace("\\n", "\\n").slice(0, 30));
		expect(row(shell(S1), 96)).not.toContain("approv…");
		expect(rows(shell(S1), 96).join("\n")).toContain("ctrl+o");
		for (const r of rows(shell(S1), 96)) expect(visibleWidth(r)).toBeLessThanOrEqual(96);
	});

	it("the walkthrough's S2 block keeps exit AND duration at 100 cols", () => {
		expect(outcome(shell(S2), 100)).toContain("exit 0");
		expect(outcome(shell(S2), 100)).toContain("3.0s");
		// Re-derived for the card round (owner, 2026-10-05): the command gives
		// way by FOLDING, never by losing its middle — the core keeps the
		// first row's right end and the rest of the command hangs under it.
		const head = rows(shell(S2), 100).slice(0, 2).map((r) => r.trim().replace(/^SHELL /, "").split(/ {2,}/)[0]!);
		expect(head.join(" ")).toBe(S2);
		expect(row(shell(S2), 100)).not.toContain("\u2026");
		expect(rows(shell(S2), 100).join("\n")).toContain("ctrl+o");
		for (const r of rows(shell(S2), 100)) expect(visibleWidth(r)).toBeLessThanOrEqual(100);
	});

	it("the ATTRIBUTION drops before the core is touched — the boundary width", () => {
		// wide enough for the whole row: the verdict is there
		expect(outcome(shell("echo hi"), 60)).toContain("· approved");
		// squeezed: the verdict goes, the core stays whole and uncut
		const tight = outcome(shell(S1), 30);
		expect(tight).not.toContain("approved");
		expect(tight, "what happened and how long it took").toBe("exit 0 · 3.0s");
		expect(tight).not.toContain("…");
	});

	it("EVERY width from 24 to 120: the core is whole or shorter, never cut open", () => {
		for (const command of [S1, S2, "echo hi"]) {
			for (let W = 24; W <= 120; W += 1) {
				const all = rows(shell(command), W);
				for (const r of all) expect(visibleWidth(r), `W=${W}: ${r}`).toBeLessThanOrEqual(W);
				// the outcome row is one of the pinned forms, entire — never a
				// form with its tail sliced off (which is what the ellipsis
				// would say)
				const o = outcome(shell(command), W);
				expect(o, `W=${W}: ${o}`).toMatch(/^exit 0(?: · \d+ lines?)?(?: · 3\.0s)?(?: · approved)?$/);
			}
		}
	});

	it("an EDIT card's core is the ± pair, and it is whole at every width too", () => {
		const edit = shell("x", { name: "edit_file", inputFull: JSON.stringify({ path: "src/some/deep/path/parser.ts" }), added: 1, removed: 1, resultText: "edited" }) as BodyCell;
		for (let W = 24; W <= 120; W += 1) {
			const r = row(edit, W);
			expect(visibleWidth(r), `W=${W}`).toBeLessThanOrEqual(W);
			// the ± pair is never cut open: where it shows, it is whole and its
			// elapsed follows it
			if (r.includes("+1")) expect(r, `W=${W}: ${r}`).toMatch(/\+1 -1(?: · 1 line)? · 3\.0s(?: · approved)?$/);
			expect(r, `W=${W}: the elapsed was cut away`).toMatch(/3\.0s/);
		}
	});

	// MOVED (R9 P2 / D4): the affordance is on the slab's NOTE row now, not
	// on the head row — the head row of a shell carries the command and
	// nothing else. The rule is the one TUI2-R1.5 ⑤ wrote and is unchanged:
	// the key is the semantics, so it is the part that is RESERVED while
	// every other part of the row gives way.
	// Graphite §7.4: the affordance was the card's FOOT, a row of its own.
	// Re-derived for the card round (owner, 2026-10-05): the key stands at
	// the cut note's right margin — one row for one fact — and it is still
	// the part RESERVED: the count's words give way before it does.
	it("the affordance survives every width — the cut note carries the key, whole", () => {
		for (const command of [S1, S2]) {
			for (let W = 24; W <= 120; W += 1) {
				const all = rows(shell(command), W);
				const keyed = all.filter((r) => r.trimEnd().endsWith("ctrl+o expands"));
				expect(keyed.length, `W=${W}: ${all.join("\n")}`).toBe(1);
				expect(keyed[0]!, `W=${W}: the key is on the note`).toMatch(/\u2026 1( earlier line)? {2,}ctrl\+o expands$/);
				expect(all.at(-1)!.trim(), `W=${W}: no foot`).not.toBe("ctrl+o expands");
				for (const r of all) expect(visibleWidth(r), `W=${W}`).toBeLessThanOrEqual(W);
			}
		}
	});
});
