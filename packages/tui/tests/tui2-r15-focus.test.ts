/**
 * TUI2-R1.5 slice ⑥ — VD-7: ctrl+o acts on exactly one cell.
 *
 * The walkthrough's 06→07→08 sequence saw one press collapse the read
 * group AND expand the error card. A screen diff cannot prove or
 * disprove that on its own — an APPENDED block scrolls the window, and
 * rows leaving the top look exactly like a cell collapsing — so the
 * property is pinned where the truth lives: the cells themselves.
 *
 * One press changes ONE cell's `expanded` flag, or appends one block,
 * never both and never two cells at once. The rollup counts as one cell:
 * its members are a display projection of the head.
 *
 * The VISIBLE-FOCUS half of VD-7 is NOT delivered — see the round's
 * RETURN. A marker cannot ride the cells (a committed row's bytes are
 * frozen in the scrollback, ADR-0046) and the status hint, the only
 * always-repainted surface, collides with three "emitted exactly once"
 * gates when it carries the literal `ctrl+o`.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). Two reasons, one of them a truthfulness bug: that table
 * names what a single-tool rollup COUNTS — "14 matches" means fourteen
 * matched lines — while this line counts CALLS, so one search rendered
 * "1 match" whenever the search had matched any other number. The
 * phrasing is the owner's, from the shape they asked for: "thought 17s
 * · read 4 files · listed 1 directory · ran 4 shell commands".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	const W = opts.W ?? 80;
	const H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function call(body: Body, name: string, id: string, input: Record<string, unknown>, result: string, isError = false): void {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: result, isError });
}

describe("TUI2-R1.5 ⑥ — one press, one cell (VD-7)", () => {
	it("a press on a LIVE cell toggles exactly that cell; the others are untouched", () => {
		const { body, tick } = makeBody();
		body.enter();
		body.userLine("go");
		body.textAppend("Working.");
		body.textEnd();
		tick();
		call(body, "shell", "c1", { command: "one" }, "a\nb\nc\nd\ne\nf\ng");
		call(body, "shell", "c2", { command: "two" }, "h\ni\nj\nk\nl\nm\nn");
		// both are still LIVE (the turn has not ended and nothing committed
		// them): the newest is the target
		const first = body.expandNext();
		expect(first.kind).toBe("toggled");
		const second = body.expandNext();
		expect(second.kind).toBe("toggled");
		// two presses, two toggles — and the SECOND undid the first on the
		// same cell rather than reaching a different one
		const third = body.expandNext();
		expect(third.kind).toBe("toggled");
	});

	it("a press on the COMMITTED history APPENDS one block and toggles nothing", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("go");
		body.textAppend("Working.");
		body.textEnd();
		tick();
		call(body, "shell", "c1", { command: "one" }, "a\nb\nc\nd\ne\nf\ng");
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		const before = writes.length;
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		// the appended block is NEW content — nothing above it was rewritten
		tick();
		const after = writes.slice(before).join("");
		expect(after).not.toContain("\x1b[1;1H"); // no full repaint of the history
	});

	it("the ROLLUP is ONE cell — a press expands the group, not its members", () => {
		const { body, tick } = makeBody();
		body.enter();
		body.userLine("go");
		body.textAppend("Exploring.");
		body.textEnd();
		tick();
		for (let i = 0; i < 4; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x\ny");
		call(body, "search_text", "s0", { pattern: "q", path: "." }, "hit");
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = (r as { lines: string[] }).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		// R3b: the expansion is the SEGMENT's now — its header names what
		// the segment did, and the run's own "explored …" title sits one
		// row below it. The claim — ONE expansion naming the group, not
		// five per-call ones — is unchanged and is what is asserted.
		expect(lines).toContain("expanded · read 4 files · ran 1 search");
		expect(lines).toContain("explored 4 files · 1 search");
		// DECLARED SUPERSESSION (R3i phase 4): in the APPENDED path the
		// footer said `ctrl+o collapses`, which is false there — a
		// committed row is ink (ADR-0046 forbids rewriting history), so
		// nothing about this block can be taken back and the next press
		// opens the NEXT fold. The footer says what the key does. The
		// LIVE toggle keeps the old wording, where it is true.
		// R4a: the ordinal is retired; the footer says which DIRECTION the
		// walk goes, which is the promise the key can actually keep.
		expect(lines).toContain("end of expansion · ctrl+o opens the one before it");
		expect(lines.match(/expanded ·/g) ?? []).toHaveLength(1);
	});

});
