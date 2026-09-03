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

/** R13 E3 — the body renders a markdown block at COLUMN 2, folded in the
 *  room that leaves. The reference these cases compare the screen against
 *  is still the md renderer itself; the transform is written out here so
 *  the gate pins the indent as well as the rendering, rather than asking
 *  the component what it did. */
const PROSE = "  ";
const prose = (text: string, W: number): string[] => renderMarkdown(text, W - PROSE.length).map((r) => (r === "" ? r : `${PROSE}${r}`));

describe("TUI2-MD ⑤ — the compositor wiring", () => {
	it("T-MD-37: the committed history IS the rendered markdown, in order", () => {
		// at a height where the paint clamp of finding TUI2-MD-1 (below) does
		// not fire, the transcript is EXACT: every rendered row, in order,
		// exactly once.
		const offenders: string[] = [];
		for (const [W, H] of [[80, 30], [100, 40], [60, 32]] as const) {
			const { screen } = stream(MD_BENCHMARK, W, H, RAGGED);
			const want = prose(MD_BENCHMARK, W).map(plain).filter((r) => r !== "");
			const got = screen.all().map(plain);
			let at = 0;
			for (const row of want) {
				const found = got.indexOf(row, at);
				if (found < 0) offenders.push(`${W}x${H}: ${row.slice(0, 30)}`);
				else at = found + 1;
			}
		}
		expect(offenders.slice(0, 3)).toEqual([]);
	});

	/**
	 * FINDING TUI2-MD-1 (escalated, not fixed here) — a SHORT terminal can
	 * still drop rows from the scrollback, and it is not this round's
	 * mechanism.
	 *
	 * `#drawFull`'s A8b pre-paint places each leaving row at
	 * `frozen.length + i − lastSkip + 1`, clamped by `Math.max(1, …)`. When
	 * a frame commits more rows than the window has room above the live
	 * region, several leaving rows clamp to row 1 and overwrite each other
	 * before the scroll carries them off. That is the R2pre-1 family — the
	 * mechanism this round is explicitly instructed not to touch — and it
	 * predates the markdown work by a wide margin.
	 *
	 * Measured on the acceptance content at W=80 (rows absent from the
	 * whole screen model, of ~25):
	 *
	 *     H     one text cell (before)     block-freeze (after)
	 *     20         12                          2
	 *     24         10                          3
	 *     30          6                          0
	 *     40          0                          0
	 *
	 * Block-freeze commits a BLOCK at a time instead of a whole message, so
	 * the frames that trip the clamp are far smaller and far rarer — the
	 * round improves the defect by 4-5× without going near its cause. The
	 * residue is bounded here, as R2pre-1's own gate bounds its duplicate
	 * copies. Adjudication: the integrator.
	 */
	it("T-MD-39: the short-terminal residue is BOUNDED — finding TUI2-MD-1", () => {
		const worst: string[] = [];
		for (const [W, H, cap] of [[80, 20, 4], [80, 24, 4], [60, 20, 4]] as const) {
			const { screen } = stream(MD_BENCHMARK, W, H, RAGGED);
			const want = prose(MD_BENCHMARK, W).map(plain).filter((r) => r !== "");
			const got = screen.all().map(plain);
			const absent = want.filter((r) => !got.includes(r)).length;
			if (absent > cap) worst.push(`${W}x${H}: ${absent} absent (cap ${cap})`);
		}
		expect(worst).toEqual([]);
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
		// close, so the force-commit path is never what is moving them. And
		// the peak is CONSTANT — the same after 200 lines as after 20, which
		// is the block-freeze property stated as a number.
		const peak = Math.max(...peaks);
		expect(`peak=${peak} of cap ${H - 4}`).toBe(`peak=4 of cap ${H - 4}`);
		expect(Math.max(...peaks.slice(0, 20))).toBe(peak);
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
		const at = rows.indexOf(`${PROSE}A heading`);
		expect(at).toBeGreaterThan(0);
		// exactly ONE blank row above and below the heading — the style
		// table's rhythm, not the W11 row-count formula (which would give a
		// heading between two one-row paragraphs no blank at all)
		expect(`${rows[at - 1]}|${rows[at + 1]}`).toBe("|");
		expect(`${rows[at - 2]}|${rows[at + 2]}`).toBe(`${PROSE}first paragraph here|${PROSE}second paragraph here`);
	});
});
