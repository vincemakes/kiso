/**
 * 0.40.6 — thinking hidden is ONE italic line, the open block included.
 *
 * The owner, 2026-09-23: most people do not want the thinking text breaking
 * into the screen and taking rows; keep one italic `thinking…` line. The
 * 0.40.5 switch folded only SETTLED blocks, into a 100-character preview,
 * while the open block kept streaming its text — the part the owner wanted
 * gone was the part it left. Hidden now covers a block from its first
 * character; the record still holds every word (`/think`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const CHUNKS = ["Weighing the two shapes for this. ", "The first keeps every character on the screen; ", "the second is quieter and leaves nothing behind."];

function makeBody(W = 80) {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => 24, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, take: (): string => writes.splice(0).join("") };
}
const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("0.40.6 — hidden thinking", () => {
	it("restored at start: an open block streams NO text, only its label; settled, `THINK · hidden · ctrl+t`", () => {
		const { body, take } = makeBody();
		body.setThinkingHidden(true);
		expect(body.thinkingHidden()).toBe(true);
		let live = "";
		for (const c of CHUNKS) {
			body.thinkingAppend(c);
			vi.advanceTimersByTime(16);
			live += strip(take());
		}
		// Graphite §7.2: the hidden form is the label line — while it streams
		// the twinkle hangs beside it
		expect(live, "the live line").toMatch(/THINK · hidden · ctrl\+t/);
		for (const c of CHUNKS) expect(live, "no thinking text reaches the screen while it runs").not.toContain(c.trim().slice(0, 20));
		body.thinkingEnd();
		body.textAppend("the answer is the first one.");
		vi.advanceTimersByTime(16);
		const settled = strip(take());
		expect(settled, "the settled line names the way back to the text").toMatch(/THINK( [\d.]+s)? · hidden · ctrl\+t/);
		expect(settled).not.toContain("leaves nothing behind");
		expect(settled, "the prose is untouched").toContain("the answer is the first one.");
		expect(body.lastThinking(), "the record holds every word").toBe(CHUNKS.join(""));
	});

	it("thrown while a block is OPEN: the rest of that block is not drawn either", () => {
		const { body, take } = makeBody();
		body.thinkingAppend(CHUNKS[0]!);
		vi.advanceTimersByTime(16);
		expect(strip(take()), "shown by default: the text streams").toContain("Weighing the two shapes");
		body.toggleThinking();
		expect(body.thinkingHidden()).toBe(true);
		vi.advanceTimersByTime(16);
		take();
		body.thinkingAppend(CHUNKS[1]!);
		body.thinkingAppend(CHUNKS[2]!);
		vi.advanceTimersByTime(16);
		const after = strip(take());
		expect(after).not.toContain("leaves nothing behind");
		expect(after).not.toContain("every character on the screen");
	});

	it("shown again: the words come back, and the default is shown", () => {
		const { body, take } = makeBody();
		expect(body.thinkingHidden(), "the default").toBe(false);
		body.setThinkingHidden(true);
		body.thinkingAppend(CHUNKS.join(""));
		body.thinkingEnd();
		body.textAppend("done.");
		vi.advanceTimersByTime(16);
		take();
		body.setThinkingHidden(false);
		expect(strip(take())).toContain("leaves nothing behind");
	});
});
