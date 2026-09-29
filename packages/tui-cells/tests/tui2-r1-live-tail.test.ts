/**
 * TUI2-R1 slice ④ — T-V3 (the render half): the running shell's live
 * tail.
 *
 * A running shell used to say only "waiting for output" for as long as
 * it ran. It now shows the last lines the sidecar has observed, inside
 * the SAME fixed three-row window W8 fixed: the block's height changes
 * exactly once, at settle, so a running cell never shifts the rows below
 * it mid-frame.
 *
 * Two shapes are deliberately unchanged: a shell with no output yet
 * still says "waiting for output" (nothing observed, nothing claimed),
 * and every NON-shell running tool keeps liveWindow byte for byte.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";

const ORIG_TTY = process.stdout.isTTY;
const setTTY = (v: boolean): void => {
	Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};
afterEach(() => {
	delete process.env.NO_COLOR;
	setTTY(ORIG_TTY ?? false);
});

const CTX: FrameCtx = { spinnerI: 0, now: 13_000, height: 24 };

function running(over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): BodyCell {
	return {
		kind: "tool",
		name: "shell",
		input: "npm test",
		inputFull: JSON.stringify({ command: "npm test" }),
		childRoles: [],
		state: "running",
		isError: false,
		resultText: "",
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 1_000,
		doneAt: null,
		done: false,
		expanded: false,
		turn: 0,
		reason: null,
		verdict: null,
		...over,
	} as BodyCell;
}

const render = (cell: BodyCell, W = 80): string[] => cellComponent(cell).render(W, CTX);

// MOVED (R1.5 slice 4, the running-header class — DECLARED THIS ROUND):
// four assertions in this file move. Two causes, both VD-4:
//  (a) the running header now uses the SAME formatter as the done card
//      and carries its duration as its own trailing " . Ns" segment
//      rather than a bare "Ns" welded to the header text;
//  (b) the W8 fixed-window pad moved from the TOP of the tail to the
//      BOTTOM, so a command's first line is never printed under an empty
//      gutter row. The window height is unchanged — W8 still holds, and
//      its own test in this file passes untouched.
//
// DECLARED SUPERSESSION (R7a, owner-ruled 2026-08-31) — THE PAD IS
// BLANK. It was `│ `, a gutter on rows with nothing on them, and under
// a short block it drew a bar running down the screen marking nothing
// (law 1.3; the owner's screenshot). The rows below change from `│ ` to
// `""` for that reason and no other: the window's HEIGHT is untouched,
// every `│` on a row that HAS content stays, and a live tail whose
// first row was already the output keeps that shape. See
// packages/tui/tests/r7a-standing-rows.test.ts group B, which fails on
// the pre-ruling tree at all four widths.
//
// DECLARED SUPERSESSION (R8a, owner-ruled 2026-09-01) — A TOOL BLOCK'S
// ROWS ARE INDENTED, NOT GUTTERED. `│ ` on every row drew a bar down
// the left of every multi-row output; the owner asked for the corner
// form instead. The fact the bar carried — these rows are the call's
// output, not prose — moves into the INDENT (four columns, deeper than
// prose and the header), so law 1.2 still holds in plain bytes. `└`
// survives as the mark that OPENS a block, once, on its first row with
// content; in-block notes take the same indent with no glyph, because
// a second `└` inside one block would be one mark meaning two things.

// Graphite §7.4 (the card, unpainted — these run with colour off): the
// head row at the content edge carries the running status at its right
// end, where the settled outcome will stand; the window sits under it,
// opened by `└` at column 6, its rows at column 8; there is no status
// row of its own any more.
const HEAD_RUNNING = /^● SHELL {3}npm test +running · 12s · esc stops · alt\+⏎ redirects$/;

describe("TUI2-R1 T-V3 — the running shell's live tail", () => {
	it("no output yet: the head row alone — nothing observed, nothing claimed", () => {
		setTTY(false);
		const rows = render(running());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(HEAD_RUNNING);
		expect(rows[0]!.length).toBe(80);
	});

	it("output observed: the lines ride the block under the head, which names the state and the two gestures", () => {
		setTTY(false);
		const rows = render(running({ resultText: "packages/runtime    184 tests\npackages/tui      ⠸ 88/120" }));
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatch(HEAD_RUNNING);
		expect(rows.slice(1)).toEqual(["  \u2514 packages/runtime    184 tests", "    packages/tui      ⠸ 88/120"]);
	});

	it("the tail UPDATES and the height NEVER comes back down (DC-46)", () => {
		setTTY(false);
		let last = 0;
		for (const text of ["", "one", "one\ntwo", "one\ntwo\nthree", "one\ntwo\nthree\nfour\nfive", "one\ntwo\nthree\nfour\nfive\nsix", `${"x\n".repeat(80)}last`]) {
			const h = render(running({ resultText: text })).length;
			expect(h, `${JSON.stringify(text.slice(0, 12))}: the window shrank`).toBeGreaterThanOrEqual(last);
			last = h;
		}
		expect(last, "the window grew past its cap").toBe(7); // head + note + 5
		const rows = render(running({ resultText: "one\ntwo\nthree\nfour\nfive\nsix" }));
		expect(rows[1]).toBe("  \u2514 \u2026 1 earlier line");
		expect(rows.slice(2, 7)).toEqual(["    two", "    three", "    four", "    five", "    six"]);
	});

	it("a long line folds inside the block, and the cap still bounds it", () => {
		setTTY(false);
		const rows = render(running({ resultText: `short\n${"x".repeat(300)}` }), 40);
		expect(rows).toHaveLength(7);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
		expect(rows[0], "the gestures gave way; the elapsed did not").toMatch(/running · 12s$/);
	});

	it("the tail is DIM off the card — the running content is context, never the message", () => {
		setTTY(true);
		const rows = render(running({ resultText: "building…" }));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toBe("  \u2514 \x1b[2mbuilding…\x1b[0m");
	});

	it("a NON-shell running tool keeps its own window — the gestures are the shell's alone", () => {
		setTTY(false);
		const rows = render(running({ name: "read_file", input: "big.txt", inputFull: JSON.stringify({ path: "big.txt" }) }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/^● READ {4}big\.txt +running · 12s$/);
		const listed = render(running({ name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }), resultText: "a.ts\nb.ts" }));
		expect(listed[0]).toMatch(/^● LIST {4}\(root\) +running · 12s$/);
		expect(listed.slice(1)).toEqual(["  \u2514 a.ts", "    b.ts"]);
	});

	it("COMPLETION replaces the running status with the outcome, in the same place; the key moves to the foot", () => {
		setTTY(false);
		const settled = render(
			running({
				state: "done",
				done: true,
				doneAt: 19_200,
				resultText: Array.from({ length: 22 }, (_, i) => `out ${i}`).join("\n"),
			}),
		);
		expect(settled[0]).toMatch(/^ {2}SHELL {3}npm test +exit 0 · 22 lines · 18\.2s$/);
		expect(settled).toContain("  \u2514 \u2026 17 earlier lines");
		expect(settled.at(-1)!.trim()).toBe("ctrl+o expands");
		expect(settled.join("\n")).not.toContain("running");
	});
});
