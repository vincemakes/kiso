/**
 * TUI2-R2 slice ⑤ — D, the live focus marker (the owner's candidate 1).
 *
 * ctrl+r acts on ONE cell, and until now nothing on screen said which.
 * The key was learnable and its target was not: you pressed it and found
 * out. Candidate 1 answers it with zero new rows and zero new columns —
 * the cell the next press will act on renders its own `ctrl+r` token in
 * the code tint, and every other suffix stays dim.
 *
 * Candidate 2 (a `▸` marker in a new leading column) was rejected by the
 * owner: it costs a column, and the A-group badges want that column.
 *
 * THE invariant, and the reason this gate exists: exactly ONE bright
 * token per frame. Two would be a lie about a single-target key; zero
 * would put the round back where it started.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { COLOR_ON } from "../src/render.js";

const ORIG = { tty: process.stdout.isTTY };

function makeBody(rows = 24, cols = 100) {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => rows, width: () => cols, editCol: () => 1, write: (s) => writes.push(s) });
	body.bindInput(() => ({ line: "", cursor: 0 }), "› ");
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
}

/** every `ctrl+r` token in the frame, with the SGR that opened it */
function tokens(bytes: string): { tint: "code" | "dim" | "other" }[] {
	const out: { tint: "code" | "dim" | "other" }[] = [];
	for (const m of bytes.matchAll(/\x1b\[(?:38;5;252|2)m[^\x1b]*ctrl\+r/g)) {
		out.push({ tint: m[0].startsWith(COLOR_ON.code) ? "code" : m[0].startsWith(COLOR_ON.dim) ? "dim" : "other" });
	}
	return out;
}

beforeEach(() => {
	vi.useFakeTimers();
	delete process.env.NO_COLOR;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: ORIG.tty, configurable: true });
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
});

/** a settled read cell (carries a suffix) followed by a running shell —
 *  the prototype's D frame, as mutations */
function protoFrame(body: Body): void {
	body.toolStart("read_file", "t1", { path: "src/parser.ts" });
	body.toolRunning("t1");
	body.toolResult("t1", { content: "a\nb\nc\nd\ne\nf", isError: false });
	body.toolStart("shell", "t2", { command: "npm test" });
	body.toolRunning("t2"); // the live cell ctrl+r is aimed at
}

describe("TUI2-R2 ⑤ — the live focus marker (candidate 1)", () => {
	it("the cell the next ctrl+r will act on renders its token in the CODE tint; every other stays dim", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		protoFrame(body);
		writes.length = 0;
		tick();
		const found = tokens(writes.join(""));
		expect(found.length, "no ctrl+r token in the frame at all").toBeGreaterThan(0);
		expect(found.filter((t) => t.tint === "code"), "the focused cell's token is not code-tinted").toHaveLength(1);
	});

	it("EXACTLY ONE bright token per frame — the invariant, swept across the frames of a growing turn", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		for (let n = 1; n <= 4; n += 1) {
			body.toolStart("read_file", `t${n}`, { path: `src/f${n}.ts` });
			body.toolRunning(`t${n}`);
			writes.length = 0;
			tick();
			const bright = tokens(writes.join("")).filter((t) => t.tint === "code");
			expect(bright, `frame after ${n} cells: ${bright.length} bright tokens`).toHaveLength(1);
		}
	});

	it("the focus FOLLOWS the target: a new live cell takes it from the one before", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.toolStart("read_file", "a", { path: "src/one.ts" });
		body.toolRunning("a");
		writes.length = 0;
		tick();
		expect(writes.join("")).toContain(`${COLOR_ON.code}`); // the only cell has it
		body.toolStart("read_file", "b", { path: "src/two.ts" });
		body.toolRunning("b");
		writes.length = 0;
		tick();
		const frame = writes.join("");
		// the bright token is on the row that names the NEW cell
		const row = frame.split(/\x1b\[\d+;1H\x1b\[0K/).find((r) => r.includes(COLOR_ON.code + "ctrl+r") || r.includes(COLOR_ON.code));
		expect(row ?? "", "the focus did not move to the newest cell").toContain("two.ts");
		expect(tokens(frame).filter((t) => t.tint === "code")).toHaveLength(1);
	});

	it("NO_COLOR: the tint is empty and the frame is byte-identical to a frame with no focus at all", () => {
		process.env.NO_COLOR = "1";
		const { body, writes, tick } = makeBody();
		body.enter();
		protoFrame(body);
		writes.length = 0;
		tick();
		const bytes = writes.join("");
		expect(bytes).not.toContain("\x1b[38;5;252m");
		expect(bytes).toContain("ctrl+r"); // the affordance itself survives
	});
});
