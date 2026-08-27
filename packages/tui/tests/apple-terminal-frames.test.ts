/**
 * Finding REL-0150-D1 — the Apple Terminal conservative frame mode.
 *
 * Terminal.app does not support DEC 2026 synchronized output: an
 * unsupported terminal paints HALF-FRAMES on its own schedule, and the
 * reviewer dogfood watched the tearing live (transient brackets from
 * legitimately-bracketed rows, visible mid-stream, gone at settle).
 * Its renderer is also throughput-weak — the same dogfood saw typed
 * input lag seconds behind during heavy streaming (finding D3; the
 * local echo path measures 148ms, so the delay is the terminal
 * digesting our byte volume).
 *
 * The remedy where 2026 is absent (TERM_PROGRAM=Apple_Terminal — the
 * reliable heuristic; no stdin round-trip):
 *   - the frame wraps in ?25l … ?25h (cursor hidden during the
 *     repaint — the classic anti-tearing degrade) instead of the
 *     2026 pair, which is dead bytes there;
 *   - the coalesce window widens 16ms → 40ms: fewer, bigger frames =
 *     fewer tear opportunities and less throughput pressure.
 * Every other terminal keeps today's bytes exactly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/index.js";
import type { InputState } from "../src/compositor.js";

const provider = (): InputState => ({ line: "", cursor: 0 });

function frames(script: (body: Body) => void, advanceMs: number, termProgram?: string): string {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s), ...(termProgram !== undefined ? { termProgram } : {}) });
	body.bindInput(provider, "› ");
	body.enter();
	script(body);
	vi.advanceTimersByTime(advanceMs);
	return writes.join("");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("REL-0150-D1 — the conservative frame mode on Apple Terminal", () => {
	// DECLARED SUPERSESSION (REL-0161): the ?25l/?25h FRAME BRACKET is
	// retired. Hidden is the cursor's STEADY state now — Terminal.app
	// infers "a prompt line" from bracketed-paste + a visible cursor and
	// decorates it with a Mark, and the composer met both conditions.
	// The visible cursor returns exactly once, in editor.exit().
	it("TERM_PROGRAM=Apple_Terminal: frames re-assert ?25l, NEVER ?25h, and carry NO dead 2026 bytes", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("streaming text"), 40, "Apple_Terminal");
		expect(out).toContain("\x1b[?25l");
		expect(out).not.toContain("\x1b[?25h");
		expect(out).not.toContain("\x1b[?2026");
	});

	it("any other terminal: the 2026 pair, and the same steady hidden cursor", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("streaming text"), 16, "iTerm.app");
		expect(out).toContain("\x1b[?2026h");
		expect(out).toContain("\x1b[?2026l");
		expect(out).toContain("\x1b[?25l"); // REL-0161: self-healing re-assert at every open
		expect(out).not.toContain("\x1b[?25h");
	});

	it("Apple Terminal frames coalesce at 40ms — a 16ms tick paints nothing yet", () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s), termProgram: "Apple_Terminal" });
		body.bindInput(provider, "› ");
		body.enter();
		vi.advanceTimersByTime(41); // the boot frame flushes
		const before = writes.length;
		body.textAppend("tick");
		vi.advanceTimersByTime(17); // 16ms would have painted on other terminals
		expect(writes.length).toBe(before);
		vi.advanceTimersByTime(30); // …the 40ms window closes
		expect(writes.length).toBeGreaterThan(before);
	});
});

/**
 * REL-0152-D1 — the frame's SIZE, which the gates above never measured.
 *
 * Everything above asserts the control sequences are present and paired.
 * All of it passed while the owner watched brackets tear on 0.15.2,
 * because a paired ?25l/?25h says nothing about what happens between
 * them. Measured on the shipped build, one streaming frame erased and
 * rewrote a median of 45 rows in a 40-row terminal — the whole screen,
 * plus change. ?25l hides the cursor; it is not a frame transaction, so
 * a terminal without DEC 2026 is free to paint after any one of those
 * 45 writes.
 *
 * The fix is to stop rewriting rows that did not change, so the gate is
 * on the count. A streaming delta moves the live band and nothing else:
 * the status row, the box, the composer and the queue are identical to
 * the frame before, and identical rows have no business being erased.
 *
 * BOTH CASES WERE `it.fails` for three releases. A row-level diff was
 * built and reverted first: it hit the gate (40 rows to 8) and then
 * failed the A7 replay, putting status-row text where the box top
 * belongs. Row-keyed caching is only correct if every path that changes
 * what a row NUMBER means clears it, and this file's own history — A7,
 * A8, A8b, TUI2-MD-1, the W11 boundary pileup — is a list of such paths
 * that was still being discovered.
 *
 * REL-0152-R1 is the fix that held: a full screen buffer diffed row by
 * row, whose correctness comes from HOLDING a copy of the screen rather
 * than from remembering what was written. A row that is wrong for any
 * reason is repaired by the next frame, because the difference includes
 * it — which is what the reverted attempts could not say.
 *
 * Measured after: 1.0 row erases per keystroke and 1.1 per streaming
 * delta, against 13 before. One row changes, one row is written.
 */
const eraseCount = (s: string): number => (s.match(/\x1b\[0K/g) ?? []).length;

describe("REL-0152-D1 — a streaming frame rewrites only what changed", () => {
	it("a delta that moves nothing but the live band erases a handful of rows, not a screenful", () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 40, width: () => 120, editCol: () => 1, write: (s) => writes.push(s), termProgram: "Apple_Terminal" });
		body.bindInput(provider, "› ");
		body.enter();
		body.textAppend("the quick brown fox jumps over the lazy dog. ");
		vi.advanceTimersByTime(40);
		writes.length = 0; // the first frame legitimately paints everything
		body.textAppend("more text arrives on the same line. ");
		vi.advanceTimersByTime(40);
		const frame = writes.join("");
		expect(frame, "the frame must not be empty — an empty frame would pass this gate for the wrong reason").not.toBe("");
		expect(eraseCount(frame), `a steady streaming frame erased ${eraseCount(frame)} rows`).toBeLessThanOrEqual(8);
	});

	it("the chrome rows are not rewritten when their content is unchanged", () => {
		vi.useFakeTimers();
		const writes: string[] = [];
		const body = new Body({ active: () => true, height: () => 40, width: () => 120, editCol: () => 1, write: (s) => writes.push(s), termProgram: "Apple_Terminal" });
		body.bindInput(provider, "› ");
		body.enter();
		body.textAppend("first");
		vi.advanceTimersByTime(40);
		writes.length = 0;
		body.textAppend(" second");
		vi.advanceTimersByTime(40);
		// the composer's prompt is chrome: it cannot have changed between
		// two streaming deltas, so it must not be re-emitted.
		expect(writes.join("")).not.toContain("› ");
	});
});

/**
 * REL-0152-D14 — the frame turns AUTOWRAP off, and puts it back.
 *
 * Found in the owner's own byte capture: 97 of the rows kiso emitted at
 * 80 columns are EXACTLY 80 cells — the box top and bottom, the composer
 * row, every gap row the chrome pads out. A character printed into the
 * last column does not advance the cursor past it; it sets the
 * terminal's PENDING WRAP flag, and the next printed character goes to
 * column 1 of the row below. What a terminal does with that flag when a
 * cursor MOVE arrives instead of a character is not agreed on — and the
 * same frame then makes 65 relative cursor-ups through exactly that
 * state.
 *
 * So the layout depended on a behaviour terminals disagree about, on
 * every frame, at every width where a row happens to fill the screen.
 * That is enough on its own to explain a layout correct on one terminal
 * and damaged on another, and damaged only while frames are painting.
 *
 * Turning wrapping off is safe here precisely because #checked already
 * refuses to emit a row wider than the screen: there is nothing for the
 * terminal to wrap, so nothing can be lost by not wrapping it.
 */
describe("REL-0152-D14 — autowrap is off inside a frame and on outside it", () => {
	it("every frame disables autowrap and restores it, in that order", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("streaming text"), 40, "Apple_Terminal");
		expect(out).toContain("\x1b[?7l");
		expect(out).toContain("\x1b[?7h");
		expect(out.indexOf("\x1b[?7l")).toBeLessThan(out.indexOf("\x1b[?7h"));
		// balanced: a frame never leaves wrapping off
		expect(out.split("\x1b[?7l").length).toBe(out.split("\x1b[?7h").length);
	});

	it("the guard is outside the sync/cursor pair — the whole frame is covered", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("text"), 16, "iTerm.app");
		expect(out.indexOf("\x1b[?7l"), "wrapping must be off BEFORE the frame opens").toBeLessThan(out.indexOf("\x1b[?2026h"));
		expect(out.lastIndexOf("\x1b[?7h"), "and restored AFTER it closes").toBeGreaterThan(out.lastIndexOf("\x1b[?2026l"));
	});
});
