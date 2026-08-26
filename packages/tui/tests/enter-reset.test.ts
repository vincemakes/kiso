/**
 * REL-0152-D19 — kiso must not inherit the terminal it was handed.
 *
 * The dock resets the terminal on the way OUT — `ESC[r` for the scroll
 * region, autowrap back on, the mouse off. It resets nothing on the way
 * IN. So every session begins in whatever state the previous occupant
 * left, and for THIS product that is not an edge case: kiso's whole
 * claim is that it survives kill -9, so "the last instance died without
 * running its teardown" is a supported, expected, advertised way to
 * arrive here.
 *
 * The owner's report is the shape of exactly that: stray `[` and `]` at
 * the extreme columns of the composer's rows, which kiso's own bytes
 * cannot produce (every chrome row is measured at exactly W and written
 * from column 1, so `ESC[0K` plus a W-wide write covers the row end to
 * end). Content can only survive at those columns if kiso's writes are
 * confined to a SUB-REGION of the terminal — which is what a scroll
 * region or a left/right margin does. And the report's own sequence is
 * the giveaway: a ctrl+C exit brings them on, a relaunch makes TWO, and
 * a resize clears them — terminal state that outlives the process,
 * accumulates per launch, and is reset by a size change.
 *
 * So the dock resets on entry, defensively and idempotently. This is
 * worth doing whether or not it is the cause of that report: a
 * full-screen TUI that trusts inherited terminal state is relying on
 * the good manners of whatever ran before it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

function entered(): string {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	vi.advanceTimersByTime(60);
	return writes.join("");
}

describe("REL-0152-D19 — the dock resets the terminal on entry", () => {
	it("releases an inherited SCROLL REGION", () => {
		expect(entered()).toContain("\x1b[r");
	});

	it("releases inherited LEFT/RIGHT MARGINS — the only way a write can be confined to a sub-region", () => {
		expect(entered()).toContain("\x1b[?69l");
	});

	it("the reset comes BEFORE the first frame — a frame drawn into a confined region is the defect", () => {
		const bytes = entered();
		const reset = bytes.indexOf("\x1b[r");
		const firstFrame = bytes.indexOf("\x1b[?7l");
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(firstFrame).toBeGreaterThanOrEqual(0);
		expect(reset, "the reset must precede the first frame").toBeLessThan(firstFrame);
	});

	it("restores autowrap and the cursor — what a KILLED kiso leaves off", () => {
		// REL-0152-D14 turns both off for a frame and restores them at its
		// end. A process that dies between those points leaves the shell,
		// and the next kiso, without wrapping and without a cursor.
		// `kill -9` cannot be caught, so entry is the only repair point —
		// and this product's claim is that it survives kill -9.
		const bytes = entered();
		expect(bytes).toContain("\x1b[?7h");
		expect(bytes).toContain("\x1b[?25h");
		expect(bytes.indexOf("\x1b[?7h"), "the repair must precede the first frame").toBeLessThan(bytes.indexOf("\x1b[?7l"));
	});

	it("a pipe gets NONE of it — the pipe path is byte-identical by ruling", () => {
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		const writes: string[] = [];
		const body = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
		body.enter();
		vi.advanceTimersByTime(60);
		expect(writes.join("")).not.toContain("\x1b[?69l");
		expect(writes.join("")).not.toContain("\x1b[r");
	});
});
