/**
 * TUI2-R1 slice ⑤ — T-V4 (the gate half): when `?` is a key and when it
 * is a character.
 *
 * `?` is an ordinary character in the middle of a sentence and a
 * question a human is asking on an empty composer. The gate is exactly
 * that: EMPTY composer, nothing else holding the keys. Anything else and
 * the byte inserts, which is the behaviour every previous round had.
 *
 * Closing is the cheapest contract available: ANY key. A sheet you have
 * to learn how to close is a sheet that failed at its job.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

let editor: Editor;
let rendered: number;

beforeEach(() => {
	vi.useFakeTimers();
	rendered = 0;
	editor = new Editor(() => {
		rendered += 1;
	});
});
afterEach(() => {
	vi.useRealTimers();
});

describe("TUI2-R1 T-V4 — the ? gate", () => {
	it("? on an EMPTY composer opens the sheet and inserts nothing", () => {
		editor.feed(enc("?"));
		expect(editor.sheetOpen()).toBe(true);
		expect(editor.line()).toBe("");
	});

	it("? MID-TEXT is a character — the question mark a human is typing", () => {
		editor.feed(enc("what now?"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("what now?");
	});

	it("? after the buffer is cleared opens again — the gate is the STATE, not a one-shot", () => {
		editor.feed(enc("abc?"));
		expect(editor.sheetOpen()).toBe(false);
		editor.feed(enc("\x15")); // ctrl+u: kill to start
		expect(editor.line()).toBe("");
		editor.feed(enc("?"));
		expect(editor.sheetOpen()).toBe(true);
	});

	it("ANY key closes it — and the key that closed it never reaches the buffer", () => {
		for (const key of ["x", "\r", "\x1b", " ", "\x0f", "\x1b[A"]) {
			editor.feed(enc("?"));
			expect(editor.sheetOpen(), `open before ${JSON.stringify(key)}`).toBe(true);
			editor.feed(enc(key));
			expect(editor.sheetOpen(), `closed by ${JSON.stringify(key)}`).toBe(false);
			expect(editor.line(), `buffer clean after ${JSON.stringify(key)}`).toBe("");
		}
	});

	it("the close REPAINTS — a sheet that stays on screen after the key is a stuck sheet", () => {
		editor.feed(enc("?"));
		const before = rendered;
		editor.feed(enc("x"));
		expect(rendered).toBeGreaterThan(before);
	});

	it("the slash menu holds the keys — ? under an open menu is a character", () => {
		editor.feed(enc("/"));
		editor.feed(enc("?"));
		expect(editor.sheetOpen()).toBe(false);
		expect(editor.line()).toBe("/?");
	});
});
