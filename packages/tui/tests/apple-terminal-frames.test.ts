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
	it("TERM_PROGRAM=Apple_Terminal: frames wrap in ?25l/?25h and carry NO dead 2026 bytes", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("streaming text"), 40, "Apple_Terminal");
		expect(out).toContain("\x1b[?25l");
		expect(out).toContain("\x1b[?25h");
		expect(out).not.toContain("\x1b[?2026");
		// the cursor is never left hidden: every ?25l is closed by a ?25h
		expect(out.split("\x1b[?25l").length).toBe(out.split("\x1b[?25h").length);
	});

	it("any other terminal keeps today's bytes exactly — the 2026 pair, no cursor games", () => {
		vi.useFakeTimers();
		const out = frames((b) => b.textAppend("streaming text"), 16, "iTerm.app");
		expect(out).toContain("\x1b[?2026h");
		expect(out).toContain("\x1b[?2026l");
		expect(out).not.toContain("\x1b[?25l");
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
