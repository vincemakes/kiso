/**
 * TUI2-R1.5 slice ④ — VD-4 + VD-5: the shell card.
 *
 * (a) The RUNNING card printed `c.input` — a 60-char slice of the call's
 *     JSON — while the DONE card printed the plain command through
 *     toolTarget. The walkthrough's frame s2-01:
 *       ▖ shell {"command":"for i in 1 2 3 4 5 6; do echo \"step $i · compil 2s
 *     escaped JSON, cut mid-word, with the duration jammed against the
 *     cut. The clean formatter already existed; the running path just
 *     never called it.
 *
 * (b) The live tail padded SHORT output upward with blank `│ ` rows, so
 *     a command's first line arrived under an empty gutter row.
 *
 * (c) VD-5: a completed shell kept its last rows plus
 *     `└ +N earlier rows · ctrl+r` forever — six rows per call, for the
 *     whole session. The approved R1 prototype settles it to ONE line.
 *
 * Red on base: (a) the running header contains `{"command"`; (b) a
 * one-line tail's first row is blank; (c) the settled card is 6 rows.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellComponent, type BodyCell, type FrameCtx } from "../src/components.js";

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});
afterEach(() => {
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };

const LONG = 'for i in 1 2 3 4 5 6; do echo "step $i · compiling module $i of 6"; sleep 1; done; echo build done';

function shellCell(over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}): Extract<BodyCell, { kind: "tool" }> {
	const command = (over as { command?: string }).command ?? LONG;
	return {
		kind: "tool",
		name: "shell",
		input: JSON.stringify({ command }).slice(0, 60),
		inputFull: JSON.stringify({ command }, null, 2),
		childRoles: [],
		state: "running",
		isError: false,
		resultText: "",
		diff: null,
		added: 0,
		removed: 0,
		startedAt: 8_000,
		doneAt: null,
		done: false,
		expanded: false,
		turn: 0,
		rolled: null,
		reason: null,
		verdict: null,
		...over,
	} as Extract<BodyCell, { kind: "tool" }>;
}

function render(cell: BodyCell, W = 100): string[] {
	return cellComponent(cell).render(W, CTX);
}

describe("TUI2-R1.5 ④(a) — the running shell header is the clean one (VD-4)", () => {
	it("no raw JSON, no escaped quotes — the plain command, like the done card", () => {
		const rows = render(shellCell({ resultText: "step 1 · compiling module 1 of 6" }));
		expect(rows[0]).not.toContain('{"command"');
		expect(rows[0]).not.toContain('\\"');
		expect(rows[0]).toContain("shell for i in 1 2 3 4 5 6;");
	});

	it("the duration is its OWN trailing segment — never glued to a cut word", () => {
		const rows = render(shellCell({ resultText: "x" }), 60);
		// the head is cut with an ellipsis, and the duration follows it as a
		// separated segment rather than riding the cut
		expect(rows[0]).toMatch(/· \d+s$/);
		expect(rows[0]).not.toMatch(/[A-Za-z0-9]\d+s$/);
	});

	it("the row still fits the width — invariant ① holds at every width", () => {
		for (const W of [30, 40, 60, 80, 100, 120]) {
			const rows = render(shellCell({ resultText: "x" }), W);
			expect(rows[0]!.length, `W=${W}: ${rows[0]}`).toBeLessThanOrEqual(W);
		}
	});

	it("the QUEUED and APPROVAL headers are the clean formatter too", () => {
		for (const state of ["pending", "approval"] as const) {
			const rows = render(shellCell({ state }));
			expect(rows[0], state).not.toContain('{"command"');
			expect(rows[0], state).toContain("shell for i in");
		}
	});
});

describe("TUI2-R1.5 ④(b) — the live tail's first row is never blank (VD-4)", () => {
	it("one line of output renders one tail row, not a blank one above it", () => {
		const rows = render(shellCell({ resultText: "step 1 · compiling module 1 of 6" }));
		const body = rows.slice(1);
		expect(body[0]).toContain("step 1 · compiling module 1 of 6");
		// the W8 fixed-window pad still holds the block's height — it just
		// sits BELOW the output now instead of above it
		expect(body).toHaveLength(3);
		// DECLARED SUPERSESSION (R7a, owner-ruled 2026-08-31): the pad is
		// BLANK. This test's own subject — the first tail row is never
		// blank — is untouched and asserted above; what changes is the
		// glyph on the rows the pad occupies, which marked nothing.
		expect(body[1]).toBe("");
	});

	it("LEADING empty output lines are skipped — the sidecar's own blanks", () => {
		const rows = render(shellCell({ resultText: "\n\nfirst real line" }));
		const body = rows.slice(1);
		expect(body[0]).toContain("first real line");
	});

	it("the live-tail footer is unchanged", () => {
		const rows = render(shellCell({ resultText: "a\nb\nc" }));
		expect(rows[rows.length - 1]).toContain("live tail · esc stop · alt+⏎ redirect");
	});
});

describe("TUI2-R1.5 ④(c) — the completed shell collapses to ONE line (VD-5)", () => {
	/** A SHORT command, so the row has room for the full suffix grammar —
	 *  the tiered degradation on a wide command is R1's own design and has
	 *  its own case below. */
	const done = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}) =>
		shellCell({
			command: "npm test",
			state: "done",
			done: true,
			doneAt: 14_000,
			resultText: "step 1\nstep 2\nstep 3\nstep 4\nstep 5\nstep 6\nbuild done",
			...over,
		} as Partial<Extract<BodyCell, { kind: "tool" }>>);

	it("the settled card is ONE row: the head plus the suffix", () => {
		const rows = render(done());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe("  shell npm test (exit 0, 6.0s) · 7 lines · ctrl+r expands");
		// the tail rows and the "earlier rows" cut are gone
		expect(rows[0]).not.toContain("earlier rows");
	});

	it("a WIDE command still collapses to one row — the suffix degrades, the tail never returns", () => {
		const rows = render(shellCell({ state: "done", done: true, doneAt: 14_000, resultText: "a\nb\nc\nd\ne\nf\ng" }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("earlier rows");
	});

	it("the suffix states the line count EXACTLY ONCE", () => {
		const row = render(done())[0]!;
		expect(row.match(/\d+ lines/g) ?? []).toHaveLength(1);
	});

	it("ctrl+r EXPANDS it — the whole block plus the way back", () => {
		const rows = render(done({ expanded: true }));
		expect(rows.length).toBeGreaterThan(2);
		expect(rows.join("\n")).toContain("step 1");
		expect(rows.join("\n")).toContain("build done");
		expect(rows[rows.length - 1]).toContain("ctrl+r collapses");
	});

	it("a shell that produced NO output hides nothing and carries no suffix", () => {
		const rows = render(done({ resultText: "" }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("ctrl+r");
	});

	it("a SHORT shell now says so too — four hidden lines used to claim nothing", () => {
		const row = render(done({ resultText: "one\ntwo\nthree" }))[0]!;
		expect(row).toContain("· 3 lines · ctrl+r expands");
	});

	it("a FAILED shell still shows its error body — the collapse never hides a failure", () => {
		const rows = render(done({ isError: true, resultText: "exit 1\nls: /nonexistent: No such file or directory" }));
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("\n")).toContain("No such file or directory");
	});
});
