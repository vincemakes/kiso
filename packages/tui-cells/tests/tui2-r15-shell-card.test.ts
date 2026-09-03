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
 * (c) VD-5 collapsed a completed shell to ONE line. R9 P2 / D4 reversed
 *     that once the slab gave those rows an edge — see the declared
 *     reversal below. (a) and (b) stand exactly as written.
 *
 * Red on base: (a) the running header contains `{"command"`; (b) a
 * one-line tail's first row is blank.
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

	it("the duration is its OWN row — never glued to a cut word", () => {
		// MOVED (R13 E2): the duration left the head row for the card's
		// METADATA row, which is where the settled card keeps it — so the
		// settle changes what that row says and never where anything sits.
		// VD-4's subject survives the move intact and is what is asserted:
		// the duration is never welded to the cut head.
		const rows = render(shellCell({ resultText: "x" }), 60);
		expect(rows.at(-1)).toMatch(/\d+s$/);
		expect(rows[0]).not.toMatch(/[A-Za-z0-9]\d+s$/);
		expect(rows[0]).not.toMatch(/\ds$/);
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
		// the fixed-window pad still holds the block's height — it just
		// sits BELOW the output now instead of above it. R13 E2 widened
		// the window from W8's three rows to the SETTLED card's six, so
		// the settle can only ever shrink it.
		expect(body).toHaveLength(7);
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
		// …and the metadata row (R13 E2's elapsed) closes the card below it
		expect(rows.at(-2)).toContain("live tail · esc stop · alt+⏎ redirect");
	});
});

/**
 * DECLARED REVERSAL (R9 P2 / D4, owner-ruled 2026-09-02) — A SETTLED
 * SHELL KEEPS ITS TAIL.
 *
 * VD-5 collapsed it to one row, and the reason was sound at the time:
 * six ungrounded rows per call meant three shells owned a screen. What
 * changed is not the arithmetic but the CONTAINER. The slab is a
 * surface that says where a call begins and ends, so its rows read as
 * one object instead of as five loose lines, and the cost VD-5 was
 * avoiding is the cost of rows with no edge.
 *
 * What VD-5 decided and this does NOT reverse: the cap is still five
 * rows (CAP_SHELL_SETTLED), and the tail is still the END of the output
 * rather than its head, because a command's conclusion is at the
 * bottom. Only the emptiness is reversed.
 *
 * The head-row suffix goes with it. The slab's note row names the key
 * where there is more ("… N earlier lines · ctrl+o expands"), so a
 * suffix on the head row as well would be TUI2-R1's two affordances for
 * one cell — the thing that rule exists to forbid.
 */
describe("R9 P2 / D4 — the settled shell keeps its tail (reversing VD-5)", () => {
	/** A SHORT command, so the row has room for the full grammar — the
	 *  tiered degradation on a wide command is R1's own design. */
	const done = (over: Partial<Extract<BodyCell, { kind: "tool" }>> = {}) =>
		shellCell({
			command: "npm test",
			state: "done",
			done: true,
			doneAt: 14_000,
			resultText: "step 1\nstep 2\nstep 3\nstep 4\nstep 5\nstep 6\nbuild done",
			...over,
		} as Partial<Extract<BodyCell, { kind: "tool" }>>);

	it("the head row names the call; the outcome closes the block on its own row", () => {
		const rows = render(done());
		expect(rows[0]).toBe("  shell npm test");
		expect(rows.at(-1)).toBe("    exit 0 · 7 lines · 6.0s");
	});

	it("the tail is the LAST five rows, with a note above saying what was cut", () => {
		// these render with the palette OFF, so the block is unpainted and
		// R8a's corner still opens it — the corner is the surface's
		// alternative, not part of the note.
		const rows = render(done()).map((r) => r.trim().replace(/^└ /, ""));
		expect(rows).toContain("… 2 earlier lines · ctrl+o expands");
		expect(rows.slice(2, 7)).toEqual(["step 3", "step 4", "step 5", "step 6", "build done"]);
	});

	it("an output inside the cap is whole, and gets no note", () => {
		const rows = render(done({ resultText: "one\ntwo\nthree" })).map((r) => r.trim().replace(/^└ /, ""));
		expect(rows.join("\n")).not.toContain("earlier lines");
		expect(rows.filter((r) => r !== "")).toEqual(["shell npm test", "one", "two", "three", "exit 0 · 3 lines · 6.0s"]);
	});

	it("the line count is stated EXACTLY ONCE, and it is on the outcome row", () => {
		const rows = render(done());
		expect(rows.join("\n").match(/\d+ lines/g) ?? []).toHaveLength(1);
		expect(rows[0]).not.toContain("lines");
	});

	it("no SECOND affordance: the note names the key, the head row does not", () => {
		const rows = render(done());
		expect((rows.join("\n").match(/ctrl\+o/g) ?? []).length).toBe(1);
		expect(rows[0]).not.toContain("ctrl+o");
	});

	it("a WIDE command still fits — invariant ① at every width", () => {
		for (const W of [24, 40, 60, 80, 120]) {
			for (const row of render(shellCell({ state: "done", done: true, doneAt: 14_000, resultText: "a\nb\nc\nd\ne\nf\ng" }), W)) {
				expect(row.length, `W=${W}`).toBeLessThanOrEqual(W);
			}
		}
	});

	it("ctrl+o EXPANDS it — the whole block plus the way back", () => {
		const rows = render(done({ expanded: true }));
		expect(rows.length).toBeGreaterThan(2);
		expect(rows.join("\n")).toContain("step 1");
		expect(rows.join("\n")).toContain("build done");
		expect(rows[rows.length - 1]).toContain("ctrl+o collapses");
	});

	it("a shell that produced NO output is still ONE row — nothing to close", () => {
		const rows = render(done({ resultText: "" }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("ctrl+o");
	});

	it("a FAILED shell still shows its error body — the collapse never hid a failure, and neither does this", () => {
		const rows = render(done({ isError: true, resultText: "exit 1\nls: /nonexistent: No such file or directory" }));
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("\n")).toContain("No such file or directory");
	});
});
