/**
 * Graphite §3 — the terminal's answer to the ground question repaints the
 * screen AT ONCE, and never by erasing the scrollback.
 *
 * The answer (OSC 11, CSI 997) arrives a few milliseconds after the first
 * frame, at every launch. `onGroundChange` used to clear the held screen
 * and ask for a resize settle; the settle returns early when the geometry
 * did not change — it never does here — so nothing was painted and the
 * no-ground palette stayed up until the first keystroke, committed cells
 * included (their cached rows carried the old palette's bytes).
 *
 * A reprint would paint, but it writes `3J`: at every launch that would
 * erase the shell's scrollback the first frame just scrolled into it
 * (DC-40). So the repaint drops the cached rows and repaints the screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { palette, setGround } from "../src/lines.js";

const H = 24;
const W = 80;

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	vi.useRealTimers();
});

function settledCard(): { body: Body; writes: string[] } {
	setGround("unknown");
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	body.enter();
	body.toolStart("shell", "c1", { command: "echo ground" });
	body.toolRunning("c1");
	body.toolResult("c1", { content: Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n"), isError: false });
	vi.advanceTimersByTime(200);
	return { body, writes };
}

describe("a ground answer repaints what is on screen", () => {
	it("the settled card is repainted on its new ground without a keystroke", () => {
		const { body, writes } = settledCard();
		const before = writes.length;
		setGround("dark", { r: 30, g: 30, b: 30 });
		const wash = palette().wash;
		body.onGroundChange();
		vi.advanceTimersByTime(200);
		const after = writes.slice(before).join("");
		expect(wash, "the dark ground's card is a background colour").toMatch(/^\x1b\[48;/);
		expect(after, "the card's rows are written again, in the dark ground's colour").toContain(wash);
	});

	it("…and it never erases the scrollback — the shell's history above the first frame survives", () => {
		const { body, writes } = settledCard();
		const before = writes.length;
		setGround("light", { r: 255, g: 255, b: 255 });
		body.onGroundChange();
		vi.advanceTimersByTime(200);
		expect(writes.slice(before).join("")).not.toContain("\x1b[3J");
	});
});
