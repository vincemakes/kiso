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
import { askView } from "../src/ask-panel.js";
import type { AskSpec, PanelVerdict } from "../src/approval-panel.js";

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

/**
 * REL-0152-D9 — a paste costs time in its SIZE, not its size squared.
 *
 * From the owner's dogfood of 0.15.4: the capsule appears, but only
 * after a long wait. Every character went through #insert, which
 * splices one code point and reflows — and a reflow scans the line for
 * the cursor's bounds and measures its width. Linear work per character
 * is quadratic work per paste: measured on the shipped build, 10k
 * characters took 33ms and 30k took 278ms, with 100k heading for three
 * seconds of frozen composer.
 *
 * The run is collected and spliced once. These cases pin the two
 * properties that makes possible — the whole paste arrives, and it
 * arrives whether the terminal hands it over in one read or fifty.
 */
describe("REL-0152-D9 — a large paste is linear, and survives chunking", () => {
	const bigText = Array.from({ length: 3000 }, (_, i) => `line ${i} of a large pasted file`).join("\n");

	it("a paste split across many reads is ONE paste, in order", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		const wire = `\x1b[200~${bigText}\x1b[201~`;
		for (let i = 0; i < wire.length; i += 997) editor.feed(enc(wire.slice(i, i + 997)));
		expect(editor.line()).toBe("[Pasted text #1 +3000 lines]");
		editor.feed(enc("\r"));
		expect(seen).toEqual([bigText]);
	});

	it("a 400k paste stays well under a frame — the quadratic path took seconds", () => {
		const editor = new Editor(() => {});
		const huge = "x".repeat(400_000);
		const t = process.hrtime.bigint();
		editor.feed(enc(`\x1b[200~${huge}\x1b[201~`));
		const ms = Number(process.hrtime.bigint() - t) / 1e6;
		expect(editor.line()).toBe("[Pasted text #1 +1 line]");
		// generous by two orders of magnitude against the quadratic path
		// (which needed ~40s for this size) — this gate is about the SHAPE
		// of the curve, and a CI machine under load must not flake it.
		expect(ms, `400k characters took ${ms.toFixed(0)}ms`).toBeLessThan(2000);
	});

	it("the capsule's line count is the pasted text's, not the composer's view of it", () => {
		const editor = new Editor(() => {});
		paste(editor, "a\nb\nc\nd\ne\nf\ng\nh\ni");
		expect(editor.line()).toBe("[Pasted text #1 +9 lines]");
	});
});

/**
 * REL-0152-D10 — a newline inside a paste is content, in EVERY phase.
 *
 * The owner asked whether the type-your-own answer box takes a paste.
 * It did not: the panel branches handled CR/LF as Enter before the
 * paste-aware normalizer below them ever ran, so a multi-line paste
 * SUBMITTED at its first line and dropped the rest into the composer
 * behind the now-closed panel. Both halves of what was pasted were lost
 * from the answer, and the typed prefix went with them.
 *
 * Bracketed paste marks its own boundaries. Between them a \n is a line
 * of the pasted text and cannot be a keypress — that is what the
 * brackets are FOR, and the main composer had always honoured it.
 */
describe("REL-0152-D10 — the typed answer box takes a paste", () => {
	const ASK: AskSpec = { questions: [{ question: "which way?", options: [{ label: "safe" }, { label: "fast" }] }] };
	const trace = Array.from({ length: 30 }, (_, i) => `stack frame ${i}`).join("\n");

	const openBox = (): { editor: Editor; seen: PanelVerdict[] } => {
		const seen: PanelVerdict[] = [];
		const editor = new Editor(() => {});
		editor.beginPanel(askView(ASK), (v) => seen.push(v));
		editor.feed(enc("\x1b[B\x1b[B")); // onto the custom row
		editor.feed(enc("here: ")); // D4: typing opens the box
		return { editor, seen };
	};

	it("a multi-line paste does not submit the answer at its first line", () => {
		const { editor, seen } = openBox();
		paste(editor, trace);
		expect(seen, "the paste committed the answer mid-way").toHaveLength(0);
		expect(editor.panelState()).not.toBeNull();
	});

	it("the answer is the typed prefix plus the WHOLE paste", () => {
		const { editor, seen } = openBox();
		paste(editor, trace);
		expect(editor.line()).toBe("here: [Pasted text #1 +30 lines]");
		editor.feed(enc("\r"));
		const v = seen[0] as Extract<PanelVerdict, { action: "answers" }>;
		expect("answers" in v.result ? v.result.answers[0] : null).toEqual({ q: "which way?", custom: `here: ${trace}` });
	});

	it("a SHORT multi-line paste lands as itself — no capsule, still no early submit", () => {
		const { editor, seen } = openBox();
		paste(editor, "a\nb");
		expect(seen).toHaveLength(0);
		editor.feed(enc("\r"));
		const v = seen[0] as Extract<PanelVerdict, { action: "answers" }>;
		expect("answers" in v.result ? v.result.answers[0] : null).toEqual({ q: "which way?", custom: "here: a\nb" });
	});

	it("a TYPED enter still commits — the guard is the paste, not the key", () => {
		const { editor, seen } = openBox();
		editor.feed(enc("done"));
		editor.feed(enc("\r"));
		expect(seen).toHaveLength(1);
	});
});
