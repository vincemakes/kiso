/**
 * REL-0152-D8 — a long paste is a capsule in the composer, not a wall.
 *
 * From the owner's dogfood of 0.15.3: pasting a long text into the
 * composer should collapse to a short reference the way the reference
 * implementation does; kiso pasted the whole thing in. A 300-line paste
 * takes the composer to the top of the terminal, pushes the panel and
 * the status row off screen, and leaves nothing to look at but the
 * middle of a file you already have.
 *
 * The shape: the buffer holds `[Pasted text #1 +312 lines]`, the real
 * text lives beside it, and the LINE THAT LEAVES the editor is the real
 * text — the capsule is a display form, never a truncation. Nothing is
 * lost and nothing is sent that the human did not paste.
 *
 * The threshold is a paste that would not fit in the composer's own
 * area: measured in lines first (what actually blows the layout up),
 * with a character bound for the pathological single-line paste.
 *
 * Editing over the capsule is ordinary text editing. Delete it and the
 * paste is gone — that is a feature: it is how you undo a paste. Paste
 * twice and there are two capsules, numbered, each expanding to its own.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const paste = (editor: Editor, text: string): void => editor.feed(enc(`\x1b[200~${text}\x1b[201~`));

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

describe("REL-0152-D8 — the paste capsule", () => {
	it("a long paste shows as a capsule naming its size, not as its content", () => {
		const editor = new Editor(() => {});
		paste(editor, LONG);
		expect(editor.line()).toBe("[Pasted text #1 +40 lines]");
		expect(editor.line()).not.toContain("line 7");
	});

	it("the line that LEAVES the editor is the real text, character for character", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		paste(editor, LONG);
		editor.feed(enc("\r"));
		expect(seen).toEqual([LONG]);
	});

	it("prose typed around the capsule survives, and the capsule expands in place", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		editor.feed(enc("review this: "));
		paste(editor, LONG);
		editor.feed(enc(" — what breaks?"));
		expect(editor.line()).toBe("review this: [Pasted text #1 +40 lines] — what breaks?");
		editor.feed(enc("\r"));
		expect(seen).toEqual([`review this: ${LONG} — what breaks?`]);
	});

	it("two pastes are two capsules, each expanding to its own text", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		paste(editor, LONG);
		editor.feed(enc(" then "));
		paste(editor, "second\npaste\nhere".repeat(20));
		expect(editor.line()).toContain("#1");
		expect(editor.line()).toContain("#2");
		editor.feed(enc("\r"));
		expect(seen[0]!.startsWith(LONG)).toBe(true);
		expect(seen[0]).toContain("second");
	});

	it("deleting the capsule deletes the paste — nothing hidden gets sent", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		paste(editor, LONG);
		for (let i = 0; i < "[Pasted text #1 +40 lines]".length; i += 1) editor.feed(enc("\x7f"));
		expect(editor.line()).toBe("");
		editor.feed(enc("never mind\r"));
		expect(seen).toEqual(["never mind"]);
	});

	it("a SHORT paste is untouched — the capsule is for the pastes that break the layout", () => {
		const editor = new Editor(() => {});
		paste(editor, "one\ntwo");
		expect(editor.line()).toBe("one\ntwo");
	});

	it("a single enormous line capsules too — it wraps to a screenful all the same", () => {
		const editor = new Editor(() => {});
		paste(editor, "x".repeat(3000));
		expect(editor.line()).toBe("[Pasted text #1 +1 line]");
	});

	it("typed newlines are not a paste — ctrl+J keeps building a multi-line prompt", () => {
		const editor = new Editor(() => {});
		for (let i = 0; i < 40; i += 1) editor.feed(enc(`line ${i}\x0a`));
		expect(editor.line()).toContain("line 39");
		expect(editor.line()).not.toContain("Pasted text");
	});
});
