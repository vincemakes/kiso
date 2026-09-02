/**
 * TUI2-R1.5 slice ① — VD-1: the exploration rollup forms BY DEFAULT.
 *
 * DECLARED SUPERSESSION (R3b, owner ruling 2026-08-27): the rollup's
 * ADDRESS moved. A closed segment's committed form is the fold line, and
 * the rollup — with its per-tool counts and subjects — is what `ctrl+o`
 * opens. The subject of these cases is PACING, not address: the run must
 * still form as ONE thing when the burst arrives one frame at a time,
 * which is exactly what a fold that says "6 reads" and opens onto
 * "explored 6 files · 1 dir · 1 search" proves.
 *
 * R1's rollup suite feeds the whole burst SYNCHRONOUSLY and then ticks
 * once: every cell is done inside the head's own commit frame, so the
 * fold's "every member done" test passes and the row forms. No real
 * session looks like that. A model narrates before it explores ("Let me
 * look at the parser area"), and that text RELEASES the W14 fold-hold —
 * from then on each read commits in ITS OWN frame, the head commits
 * alone, and the run degrades to one row per call, forever.
 *
 * These tests pace the burst: one frame per completion, exactly what the
 * 16ms coalescer sees when the runtime writes a durable event between
 * calls. The rollup must still be the settled form, with no keypress.
 *
 * Red on base: the settle frame carries no exploration row at all.
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
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED.
 *
 * R3b ruled that zero terms are dropped ("a sentence about things that
 * did not happen"), and the THOUGHT term was exempt by accident: it was
 * written before the rule and never revisited. So a model that emits no
 * thinking — and these cases pass `endTurn(0)` — folded under `thought
 * 0s` in the LEAD position, every turn of its life.
 *
 * The cases below claimed "the turn folded" by looking for `✦ thought`.
 * That literal is no longer the fold's signature when the turn did no
 * thinking, so each one now names the fold by what the turn actually
 * DID — which is the claim they were making all along.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16), setSize: (w: number, h: number) => { W = w; H = h; } };
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

function plain(stream: string): string {
	return stream.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** One settled read-only call. */
function call(body: Body, name: string, id: string, input: Record<string, unknown>, result: string): void {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: result, isError: false });
}

describe("TUI2-R1.5 ① — the rollup at REAL pacing (VD-1)", () => {
	it("a narrated burst — text FIRST, then one frame per completion — still settles as ONE exploration row", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("explore the parser area");
		// the model narrates first — this is the byte that releases W14's
		// fold-hold, and the reason every real burst degraded
		body.textAppend("Let me explore the parser area first.");
		body.textEnd(); // the CLI's text_end event — the narration block closes before the tools
		tick();
		const files = ["src/parser.ts", "src/lexer.ts", "src/ast.ts", "src/token.ts", "src/index.ts", "src/util.ts"];
		for (const [i, path] of files.entries()) {
			call(body, "read_file", `r${i}`, { path }, "a\nb");
			tick(); // ONE FRAME PER COMPLETION — the real pacing
		}
		call(body, "list_dir", "l1", { path: "src" }, "x");
		tick();
		call(body, "search_text", "g1", { pattern: "parseExpr", path: "src" }, "hit");
		tick();
		const settleFrom = writes.length;
		body.textAppend("Found it.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		// DECLARED SUPERSESSION (R4 tense + R6/D3, together): the SETTLE
		// EMITS NO BYTES ANY MORE, and the reason is worth recording.
		//
		// R4 made the stretch line's tense PER TERM, so a stretch whose
		// calls are all done already reads `read 6 files` while live.
		// R6/D3 then removed the mark, which was the last thing that
		// differed between the live row and the settled one. They are now
		// byte-identical, so the diff renderer has nothing to write at the
		// boundary — and a slice of the write stream taken after the
		// settle is empty of it by construction.
		//
		// That is not a defect: the row says the same true thing before
		// and after. It does mean the claim has to be made about the
		// SCREEN, which is the honest surface anyway.
		const sc = new Screen(80, 24);
		sc.feed(writes.join(""));
		const settle = sc.rows.map((r) => r.join("").replace(/\s+$/, "")).join("\n");
		expect(settle).toContain("read 6 files · listed 1 directory · ran 1 search");
		const opened = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(opened).toContain("explored 6 files · 1 dir · 1 search");
	});

	it("the settled screen carries the ONE row and NOT the eight individual ones", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("explore");
		body.textAppend("Exploring.");
		body.textEnd();
		tick();
		for (let i = 0; i < 6; i += 1) {
			call(body, "read_file", `r${i}`, { path: `src/f${i}.ts` }, "a\nb");
			tick();
		}
		const settleFrom = writes.length;
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		// R4 tense + R6/D3: the settle emits no bytes (see the case above
		// for why), so the claim is made about the SCREEN. It is the
		// stronger surface anyway: this case is about what a human is
		// left looking at.
		const sc2 = new Screen(80, 24);
		sc2.feed(writes.join(""));
		const settle = sc2.rows.map((r) => r.join("").replace(/\s+$/, "")).join("\n");
		// the run settled as the fold, and never as six individual reads
		expect(settle).toContain("read 6 files");
		expect(settle.match(/ {2}read {2}src\/f\d/g) ?? []).toHaveLength(0);
		// W13's single-name projection is what the key opens. One space,
		// not two: the double space was the COMMITTED row's verb-column
		// pad (W3), and the expansion is a list rather than a column.
		expect(plain((body.expandNext() as { lines: string[] }).lines.join("\n"))).toContain("read 6 files");
	});

	it("a run BROKEN by a write still rolls the two halves — pacing does not change the group key", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("mix");
		body.textAppend("Working.");
		body.textEnd();
		tick();
		call(body, "read_file", "a1", { path: "one.ts" }, "x");
		tick();
		call(body, "search_text", "a2", { pattern: "q", path: "src" }, "x");
		tick();
		call(body, "list_dir", "a3", { path: "src" }, "x");
		tick();
		call(body, "write_file", "w1", { path: "out.ts", content: "hello" }, "wrote out.ts");
		tick();
		call(body, "read_file", "b1", { path: "two.ts" }, "x");
		tick();
		call(body, "search_text", "b2", { pattern: "z", path: "src" }, "x");
		tick();
		call(body, "list_dir", "b3", { path: "lib" }, "x");
		tick();
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		// DECLARED SUPERSESSION (REL-0152-R1): the settled SCREEN is
		// reconstructed from the whole stream rather than read off the last
		// frame's bytes. A diffing renderer writes only the rows that
		// changed, so the final frame carries whichever rollup row moved
		// and not the one that stood still — and this case is about what is
		// ON THE SCREEN, which is now a stronger thing to assert than what
		// the last write happened to contain.
		const screen = new Screen(80, 24);
		screen.feed(writes.join(""));
		const settled = screen.rows.map((r) => r.join("").replace(/\s+$/, "")).join("\n");
		// R3b: the two runs and the write between them live in the fold's
		// expansion; the ORDER — which is the group key's proof — is what
		// this case is about and it is asserted there.
		expect(settled).toContain("read 2 files"); // R6/D3: the fold wears no mark
		const opened = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(opened.match(/explored 1 file · 1 search · 1 dir/g) ?? []).toHaveLength(2);
		expect(opened).toContain("write out.ts");
		const first = opened.indexOf("explored 1 file");
		expect(opened.indexOf("write out.ts")).toBeGreaterThan(first);
		expect(opened.lastIndexOf("explored 1 file")).toBeGreaterThan(opened.indexOf("write out.ts"));
	});

	it("TWO paced calls never roll — the threshold is unchanged by the pacing", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("two");
		body.textAppend("Looking.");
		body.textEnd();
		tick();
		call(body, "read_file", "a", { path: "one.ts" }, "x");
		tick();
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "x");
		tick();
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		expect(plain(writes.join(""))).not.toContain("explored");
	});

	it("the screen NEVER STICKS — a burst taller than the live cap force-commits and keeps painting", () => {
		// H=10 leaves 6 content rows; 20 paced reads cannot all stay live.
		const { body, writes, tick } = makeBody({ W: 80, H: 10 });
		body.enter();
		body.userLine("flood");
		body.textAppend("Exploring hard.");
		body.textEnd();
		tick();
		for (let i = 0; i < 20; i += 1) {
			call(body, "read_file", `r${i}`, { path: `src/f${i}.ts` }, "a\nb");
			tick();
		}
		body.textAppend("done.");
		body.textEnd();
		body.endTurn(0);
		tick();
		tick();
		const frame = plain(writes.join(""));
		// DECLARED SUPERSESSION (R3i phase 2): the SETTLED SHAPE moved,
		// the liveness property did not. Twenty paced reads no longer
		// force-commit — the open stretch is one line whose height does
		// not depend on the call count — so the settled shape is the
		// fold, not a rollup of twenty rows. What this case is named for
		// is that the screen keeps painting through the burst and the
		// turn lands: that is still exactly what is asserted.
		expect(frame).toContain("done."); // the screen never stuck
		expect(frame).toContain("read 20 files"); // and the run is all there, in one line
		expect(frame).toContain("ctrl+o"); // with the way back to it
	});
});
