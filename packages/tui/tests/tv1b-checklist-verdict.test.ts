/**
 * TV-1B ② — the compositor's checklist redraw guard widens: a
 * HEADER-ONLY change (the settle verdict landing on the same items)
 * repaints. The old guard compared items alone, so the most natural
 * driver implementation — same claims, new verdict suffix — would
 * green its tests against a screen that never redrew.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody() {
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => 24,
		width: () => 80,
		editCol: () => 1,
		write: (s: string) => writes.push(s),
	});
	return { body, writes, tick: () => vi.advanceTimersByTime(16) };
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

const ITEMS = [
	{ text: "implement", status: "done" as const },
	{ text: "verify with tests", status: "done" as const },
];

describe("TV-1B ② — a header-only verdict change repaints", () => {
	it("same items, new header → the live frame carries the new words", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		// the header param is the cell's TAIL (rendered after the derived
		// "task · N items · …" head) — the driver passes verdict WORDS.
		body.checklist("", ITEMS);
		tick();
		const before = writes.join("");
		writes.length = 0;
		// the settle verdict: SAME items, tail-only change
		body.checklist("no passing check yet", ITEMS);
		tick();
		const after = writes.join("");
		expect(before).toContain("2 items");
		expect(after).toContain("no passing check yet"); // the widened guard repaints
	});
});
