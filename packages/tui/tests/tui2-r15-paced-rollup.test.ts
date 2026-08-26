/**
 * TUI2-R1.5 slice ① — VD-1: the exploration rollup forms BY DEFAULT.
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
		const settle = plain(writes.slice(settleFrom).join(""));
		expect(settle).toContain("explored 6 files · 1 dir · 1 search");
		expect(settle).toContain("ctrl+r lists them");
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
		const settle = plain(writes.slice(settleFrom).join(""));
		// the settle frame commits the run as the W13 single-name row…
		expect(settle).toContain("read  6 files");
		// …and never as six individual read rows (the rollup head is itself
		// a "✓ read " row, so the per-call PATH is what must be absent)
		expect(settle.match(/✓ read {2}src\/f\d/g) ?? []).toHaveLength(0);
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
		expect(settled.match(/explored 1 file · 1 search · 1 dir/g) ?? []).toHaveLength(2);
		expect(settled).toContain("write out.ts");
		// the write sits BETWEEN them — the run's group key is unchanged
		const first = settled.indexOf("explored 1 file");
		expect(settled.indexOf("write out.ts")).toBeGreaterThan(first);
		expect(settled.lastIndexOf("explored 1 file")).toBeGreaterThan(settled.indexOf("write out.ts"));
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
		// the run still reached the screen (nothing stuck, nothing lost) and
		// the settled shape is a rollup, not twenty rows
		expect(frame).toContain("done.");
		expect(frame).toContain("read  ");
		expect(frame).toContain("files");
	});
});
