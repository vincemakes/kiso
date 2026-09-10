/**
 * HF-1 (0.32.1) — the crash path itself, in the compositor.
 *
 * The owner's 0.32.0 dogfood: `toolStart("shell", …, { command: "python3 -
 * <<'EOF'\n…" })`, the running card's head row carried the newlines,
 * `#checked` threw invariant ①b inside a repaint timer, the process died.
 *
 * Two layers now stand between a heredoc and that crash: the tui-cells
 * builders project a break to ⏎ before a row exists (`oneRow`), and
 * `#checked` follows the width half's ruling (DC-48, 2026-09-04) — throw
 * under KISO_INVARIANTS=throw, project and say so once in the field. This
 * file drives the real path under BOTH settings: with the builders in
 * place nothing reaches the sink with a break, so neither setting throws,
 * and the head row shows the command as one row with its marks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const H = 24;
const W = 100;
const HEREDOC = "python3 - <<'EOF'\nimport json\nprint(1)\nEOF";

function drive(): { writes: string[]; run: () => void } {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	return {
		writes,
		run: () => {
			body.toolStart("shell", "h1", { command: HEREDOC });
			vi.advanceTimersByTime(1200); // the running card's own repaint timer — the frame that threw
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	process.env.KISO_INVARIANTS = "throw";
});

describe("HF-1 — a heredoc shell command reaches the screen as one row", () => {
	it("under KISO_INVARIANTS=throw (the suites): no throw — the builders keep ①b by construction", () => {
		process.env.KISO_INVARIANTS = "throw";
		const { writes, run } = drive();
		expect(run).not.toThrow();
		const out = writes.join("");
		expect(out).toContain("python3 - <<'EOF'⏎import json⏎print(1)⏎EOF");
		expect(out).not.toMatch(/python3 - <<'EOF'\n/);
	});
	it("in the field (the variable unset): the same row, and no notice — nothing reached the sink broken", () => {
		delete process.env.KISO_INVARIANTS;
		const { writes, run } = drive();
		expect(run).not.toThrow();
		const out = writes.join("");
		expect(out).toContain("python3 - <<'EOF'⏎import json⏎print(1)⏎EOF");
		expect(out).not.toContain("please report");
	});
});
