/**
 * TUI2-MD slice ⑤ — the compositor wiring, and the covenant it must
 * not break.
 *
 * kiso's committed bytes are never re-emitted: a line that has left the
 * live region belongs to the terminal's own scrollback, and the
 * scrollback is not ours to rewrite. That is exactly why markdown
 * cannot be rendered by re-lexing the whole message per delta. The
 * wiring is therefore the scanner's discipline expressed in the cell
 * model: a CLOSED block becomes a DONE cell and commits through the
 * path the compositor already had; the OPEN tail block is the live
 * region's occupant and repaints in place.
 *
 * The gates below are the consequences worth guarding:
 *   - the committed history IS the rendered markdown, in order, once
 *     each (T-MD-37/39) — a repaint would show up as a second copy;
 *   - the live region does not grow with the message: a 200-line fence
 *     streams through it without bloating it (T-MD-38), because fence
 *     body lines are line-local and freeze one at a time;
 *   - the pipe is untouched. Non-TTY output is the model's own
 *     markdown bytes, byte-for-byte (T-MD-40), and the raw surfaces
 *     /think and /last feed on stay raw (T-MD-41);
 *   - invariant ① — a row wider than W THROWS — survives the CJK-heavy
 *     acceptance content at every geometry (T-MD-42).
 *
 * The harness is R2pre slice ②'s: WideScreen keeps the rows the house
 * emulator throws away, and measures with its own reference width so it
 * cannot agree with a mistake in ours.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { renderMarkdown } from "../src/components.js";
import { MD_BENCHMARK } from "../../tui-cells/tests/helpers/md-benchmark.js";
import { WideScreen } from "./helpers/wide-screen.js";

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

function plain(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
}

/** A turn that streams `text` in ragged deltas through a real Body. */
function stream(text: string, W: number, H: number, chunk: (i: number) => number): { screen: WideScreen; body: Body } {
	const screen = new WideScreen(H, W);
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => screen.write(s) });
	body.bindInput(() => ({ line: "", cursor: 0 }), "> ");
	body.enter();
	body.userLine("audit the repo");
	body.render();
	let i = 0;
	for (let n = 0; i < text.length; n += 1) {
		const size = chunk(n);
		body.textAppend(text.slice(i, i + size));
		body.render();
		i += size;
	}
	body.textEnd();
	body.endTurn(1.5);
	body.render();
	return { screen, body };
}

const RAGGED = (n: number): number => [3, 17, 1, 41, 9, 128, 5][n % 7]!;

describe("TUI2-MD ⑤ — the compositor wiring", () => {
	it("T-MD-37: the committed history IS the rendered markdown, in order", () => {
		const W = 80;
		const { screen } = stream(MD_BENCHMARK, W, 24, RAGGED);
		const want = renderMarkdown(MD_BENCHMARK, W).map(plain).filter((r) => r !== "");
		const got = screen.all().map(plain);
		let at = 0;
		const missing: string[] = [];
		for (const row of want) {
			const found = got.indexOf(row, at);
			if (found < 0) missing.push(row.slice(0, 40));
			else at = found + 1;
		}
		expect(missing.slice(0, 3)).toEqual([]);
	});

	it("T-MD-39: a committed row is never re-emitted — exactly one copy of each", () => {
		const W = 80;
		const { screen } = stream(MD_BENCHMARK, W, 24, RAGGED);
		const want = renderMarkdown(MD_BENCHMARK, W).map(plain).filter((r) => r.length > 12);
		const rows = screen.all().map(plain);
		const doubled = want.filter((r) => rows.filter((x) => x === r).length !== 1);
		expect(doubled.slice(0, 3)).toEqual([]);
	});

	it("T-MD-38: a long fence streams WITHOUT bloating the live region", () => {
		// a fence body line is line-local, so it freezes the instant its
		// newline arrives: the live region holds the open block, not the
		// message. Without block-freeze the whole message is one live cell
		// and the live count climbs to the cap on every delta.
		const H = 24;
		const screen = new WideScreen(H, 80);
		const body = new Body({ active: () => true, height: () => H, width: () => 80, editCol: () => 1, write: (s) => screen.write(s) });
		body.bindInput(() => ({ line: "", cursor: 0 }), "> ");
		body.enter();
		body.userLine("show me the fix");
		body.render();
		body.textAppend("here it is:\n\n```ts\n");
		body.render();
		const peaks: number[] = [];
		for (let i = 0; i < 200; i += 1) {
			body.textAppend(`const value${i} = compute(${i});\n`);
			body.render();
			peaks.push(body.liveCount());
		}
		body.textAppend("```\n");
		body.textEnd();
		body.endTurn(1);
		body.render();
		// the live region never fills up: the fence's rows leave it as they
		// close, so the force-commit path is never what is moving them
		expect(`peak=${Math.max(...peaks)} cap=${H - 4}`).toBe(`peak=6 cap=${H - 4}`);
	});

	it("T-MD-40: the PIPE is byte-identical — raw markdown, unchanged", () => {
		let out = "";
		const body = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => (out += s) });
		let i = 0;
		for (let n = 0; i < MD_BENCHMARK.length; n += 1) {
			const size = RAGGED(n);
			body.textAppend(MD_BENCHMARK.slice(i, i + size));
			i += size;
		}
		body.textEnd();
		expect(out).toBe(`${MD_BENCHMARK}\n`);
	});

	it("T-MD-41: the RAW surfaces stay raw — /think and /last are truth surfaces", () => {
		const W = 80;
		const screen = new WideScreen(24, W);
		const body = new Body({ active: () => true, height: () => 24, width: () => W, editCol: () => 1, write: (s) => screen.write(s) });
		body.bindInput(() => ({ line: "", cursor: 0 }), "> ");
		body.enter();
		// the channel /think and /last print through: markdown must NOT be
		// rendered here — the human asked to see the bytes
		body.raw(["## not a heading", "**not bold**", "| a | b |", "`code`"]);
		body.render();
		const rows = screen.all().map(plain);
		for (const line of ["## not a heading", "**not bold**", "| a | b |", "`code`"]) expect(rows).toContain(line);
	});

	it("T-MD-42: invariant ① survives the acceptance content at every geometry", () => {
		// the compositor THROWS on a row wider than W. The CJK-heavy content,
		// streamed for real, through narrow and wide terminals alike.
		for (const [W, H] of [[40, 20], [60, 24], [80, 24], [100, 30], [120, 40]] as const) {
			expect(() => stream(MD_BENCHMARK, W, H, RAGGED)).not.toThrow();
		}
	});

	it("T-MD-43: consecutive markdown blocks own their own vertical rhythm", () => {
		const W = 80;
		const { screen } = stream("first paragraph here\n\n## A heading\n\nsecond paragraph here\n", W, 24, () => 7);
		const rows = screen.all().map(plain);
		const at = rows.indexOf("A heading");
		expect(at).toBeGreaterThan(0);
		// exactly ONE blank row above and below the heading — the style
		// table's rhythm, not the W11 row-count formula (which would give a
		// heading between two one-row paragraphs no blank at all)
		expect(`${rows[at - 1]}|${rows[at + 1]}`).toBe("|");
		expect(`${rows[at - 2]}|${rows[at + 2]}`).toBe("first paragraph here|second paragraph here");
	});
});
