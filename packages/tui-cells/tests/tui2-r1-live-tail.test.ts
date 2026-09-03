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

describe("TUI2-R1 T-V3 — the running shell's live tail", () => {
	it("no output yet: the shape is exactly today's — nothing observed, nothing claimed", () => {
		setTTY(false);
		// VD-4 already put the waiting row FIRST; R7a blanks the pad
		// R13 E2: the window is the SETTLED card's (six rows, five preview
		// plus its note row) and the elapsed rides the metadata row, where
		// the settled card keeps it. The head row and the waiting row are
		// unchanged.
		expect(render(running())).toEqual(["● shell npm test", "  └ waiting for output", "", "", "", "", "", "    12s"]);
	});

	it("output observed: the LAST lines ride the block, the footer names the state and the two gestures", () => {
		setTTY(false);
		const rows = render(running({ resultText: "packages/runtime    184 tests\npackages/tui      ⠸ 88/120" }));
		expect(rows).toEqual([
			"● shell npm test",
			"  └ packages/runtime    184 tests",
			"    packages/tui      ⠸ 88/120",
			"",
			"",
			"",
			"    live tail · esc stop · alt+⏎ redirect",
			"    12s",
		]);
	});

	it("the tail UPDATES and the height NEVER changes — the W8 fixed window survives every length", () => {
		setTTY(false);
		for (const text of ["one", "one\ntwo", "one\ntwo\nthree", "one\ntwo\nthree\nfour\nfive\nsix"]) {
			expect(render(running({ resultText: text })), text).toHaveLength(8);
		}
		// growing output scrolls: the LAST five lines are what shows
		const rows = render(running({ resultText: "one\ntwo\nthree\nfour\nfive\nsix" }));
		expect(rows[1]).toBe("  └ two");
		expect(rows.slice(2, 6)).toEqual(["    three", "    four", "    five", "    six"]);
	});

	it("a long line is width-truncated inside the block, never folded into a fourth row", () => {
		setTTY(false);
		const rows = render(running({ resultText: `short\n${"x".repeat(300)}` }), 40);
		expect(rows).toHaveLength(8);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
		expect(rows.at(-2)).toContain("live tail");
	});

	it("the tail is DIM — the running content is context, never the message", () => {
		setTTY(true);
		const rows = render(running({ resultText: "building…" }));
		// the pad is BELOW the output now (VD-4(b)) — the first tail row
		// carries the command's first line, never an empty gutter
		expect(rows[1]).toBe("\x1b[2m  └ building…\x1b[0m");
		expect(rows[2]).toBe(""); // R7a: the pad is blank
		expect(rows.at(-2)).toBe("\x1b[2m    live tail · esc stop · alt+⏎ redirect\x1b[0m");
	});

	it("a NON-shell running tool keeps liveWindow byte for byte — the tail is the shell's alone", () => {
		setTTY(false);
		const rows = render(running({ name: "read_file", input: "big.txt", inputFull: JSON.stringify({ path: "big.txt" }) }));
		// R13 E1: a read previews nothing, running or settled — its card is
		// the head row and its metadata, and the settle changes only what
		// they say. `liveWindow` itself is unchanged and still the non-
		// shell form for every other tool (the list below).
		expect(rows).toEqual(["● read  big.txt", "    12s"]);
		const listed = render(running({ name: "list_dir", input: ".", inputFull: JSON.stringify({ path: "." }) }));
		expect(listed).toEqual(["● list  .", "  └ waiting for output", "", "", "", "", "", "    12s"]);
	});

	// DECLARED REVERSAL (R9 P2 / D4): completion no longer collapses. The
	// property this case exists for is the one it still asserts — the LIVE
	// tail's footer is gone once the call settles, because that footer
	// names a state ("waiting for output") that has ended. What replaces
	// the live window is the settled slab, not a single row.
	it("COMPLETION replaces the live tail with the settled slab — the live footer is gone", () => {
		setTTY(false);
		const settled = render(
			running({
				state: "done",
				done: true,
				doneAt: 19_200,
				resultText: Array.from({ length: 22 }, (_, i) => `out ${i}`).join("\n"),
			}),
		);
		expect(settled[0]).toBe("  shell npm test");
		expect(settled.at(-1)).toBe("    exit 0 · 22 lines · 18.2s");
		expect(settled.map((r) => r.trim().replace(/^└ /, ""))).toContain("… 17 earlier lines · ctrl+o expands");
		expect(settled.join("\n")).not.toContain("live tail");
	});
});
