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
		// …and never as six individual read rows
		expect(settle.match(/✓ read /g) ?? []).toHaveLength(0);
	});

	it("a run BROKEN by a write still rolls the two halves — pacing does not change the group key", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("mix");
		body.textAppend("Working.");
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
		const frame = plain(writes.join(""));
		expect(frame.match(/explored 1 file · 1 search · 1 dir/g) ?? []).toHaveLength(2);
		expect(frame).toContain("write out.ts");
	});

	it("TWO paced calls never roll — the threshold is unchanged by the pacing", () => {
		const { body, writes, tick } = makeBody({ W: 80, H: 24 });
		body.enter();
		body.userLine("two");
		body.textAppend("Looking.");
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
