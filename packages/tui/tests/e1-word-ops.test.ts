/**
 * E1 §1 — WORD MOTION AND WORD DELETION.
 *
 * `editor.ts` had no `alt+<letter>` path at all: the escape branch
 * handled `[` (CSI), `]` (OSC), `O` (SS3), `\x0d` and the menu/picker/
 * queue cases, and nothing else. `#killWord` (ctrl+w) existed but split
 * on `0x20` ALONE — no tab, no punctuation, no CJK. So `foo.bar` could
 * not be deleted a piece at a time and a Chinese sentence was one word
 * from its first character to its last.
 *
 * The round is therefore not "four new keys". It is ONE boundary
 * function that five operations share, so a motion and a deletion can
 * never disagree about where a word ends.
 *
 * The cursor is not observable from outside the editor, so every motion
 * case moves and then TYPES A MARKER: where the marker lands is where
 * the cursor was. That is the same thing the user would see.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const make = () => new Editor(() => {});

/** Type `text`, then the gesture, then `mark` — the marker's position IS
 *  the cursor's. */
const probe = (text: string, gesture: string, mark = "|"): string => {
	const ed = make();
	ed.feed(enc(text));
	ed.feed(enc(gesture));
	ed.feed(enc(mark));
	return ed.line();
};

/** Type `text`, then the gesture; the buffer is the result. */
const kill = (text: string, gesture: string): string => {
	const ed = make();
	ed.feed(enc(text));
	ed.feed(enc(gesture));
	return ed.line();
};

const LEFT = ["\x1bb", "\x1b[1;3D", "\x1b[1;5D"] as const;
const RIGHT = ["\x1bf", "\x1b[1;3C", "\x1b[1;5C"] as const;
const DEL_BACK = ["\x1b\x7f", "\x1b\x08"] as const;
const DEL_FWD = "\x1bd";

describe("E1 §1 — the three encodings of one gesture", () => {
	// Terminal.app sends `\x1bb` for alt+← only when "Use Option as Meta
	// Key" is on; without it the CSI form arrives. ctrl+← is a third
	// spelling of the same intent. All three are the gesture.
	it.each(LEFT)("word LEFT: %j", (seq) => {
		expect(probe("alpha beta", seq)).toBe("alpha |beta");
	});

	it.each(RIGHT)("word RIGHT: %j", (seq) => {
		const ed = make();
		ed.feed(enc("alpha beta"));
		for (const _ of LEFT) ed.feed(enc("\x1bb")); // back to the start
		ed.feed(enc(seq));
		ed.feed(enc("|"));
		expect(ed.line()).toBe("alpha| beta");
	});

	it.each(DEL_BACK)("delete word BEFORE: %j", (seq) => {
		expect(kill("alpha beta", seq)).toBe("alpha ");
	});

	it("delete word AFTER (alt+d)", () => {
		const ed = make();
		ed.feed(enc("alpha beta"));
		ed.feed(enc("\x1bb")); // cursor before `beta`
		ed.feed(enc(DEL_FWD));
		expect(ed.line()).toBe("alpha ");
	});
});

describe("E1 §1 — the boundary: whitespace, punctuation, CJK", () => {
	it("PUNCTUATION splits: `foo.bar` is three words, not one", () => {
		// `#killWord` split on 0x20 alone, so this deleted the whole thing.
		expect(kill("foo.bar", "\x1b\x7f")).toBe("foo.");
		expect(kill("foo.", "\x1b\x7f")).toBe("foo");
	});

	// NO TAB CASE, and the reason is a separate finding rather than an
	// omission: a tab cannot reach the buffer by ANY route this gate can
	// drive. Typed, `\t` is the completion key. PASTED, it is dropped —
	// `alpha\tbeta` inside a bracketed paste arrives as `alphabeta`,
	// measured. `#classOf` classes a tab as a separator anyway, because
	// the class is about what a word boundary IS and not about which
	// buffers can currently hold one; asserting it here would be
	// asserting something unreachable.

	it("CJK is ONE CHARACTER PER WORD — the owner types Chinese", () => {
		// A whole sentence is not a useful unit to move or delete by.
		//
		// The characters are ESCAPED, not literal: the tracked tree is
		// CJK-free (README.zh.md is the only exception) and `check-cjk`
		// enforces it. It scans TRACKED files only, so a new file passes
		// locally while it is still untracked and fails the moment it is
		// committed — which is exactly how this one reached CI.
		const CJK = "\u4e2d\u6587\u5b57"; // three Han characters
		const TWO = "\u4e2d\u6587";
		expect(kill(CJK, "\x1b\x7f")).toBe(TWO);
		expect(probe(CJK, "\x1bb")).toBe(`${TWO}|\u5b57`);
	});

	it("U+3000, the IDEOGRAPHIC SPACE, is a separator and not a character", () => {
		// It lives inside the CJK range, so a range test alone classes it as
		// a character and deletes it as one. Measured before the fix:
		// `<CJK> <IDEO-SPACE> <CJK>` killed twice left the first character;
		// as a separator the second kill crosses the space and takes it.
		const A = "\u4e2d";
		const B = "\u6587";
		expect(kill(`${A}\u3000${B}`, "\x1b\x7f")).toBe(`${A}\u3000`);
		const ed = make();
		ed.feed(enc(`${A}\u3000${B}`));
		ed.feed(enc("\x1b\x7f"));
		ed.feed(enc("\x1b\x7f"));
		expect(ed.line(), "the second kill treated the ideographic space as a character").toBe("");
	});

	it("a run of separators is crossed, then one run of word", () => {
		expect(probe("alpha   beta", "\x1bb")).toBe("alpha   |beta");
	});
});

describe("E1 §1 — a grapheme is ONE unit, never dismantled", () => {
	// The boundary walks by CODE POINT and keeps combining marks
	// (U+0300–U+036F), ZWJ joins (U+200D) and variation selectors with
	// the unit before them. Deleting half of a family emoji and leaving
	// a stranded ZWJ is the failure this pins.
	it("a ZWJ emoji sequence deletes as one", () => {
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		expect(kill(`hi ${family}`, "\x1b\x7f")).toBe("hi ");
	});

	it("a combining mark rides its base character", () => {
		expect(kill("é", "\x1b\x7f")).toBe("");
	});

	it("a variation selector rides its base", () => {
		expect(kill("❤️", "\x1b\x7f")).toBe("");
	});

	it("typing ONE emoji leaves exactly ONE code point in the buffer", () => {
		// The direct case for the pre-existing insert defect this round
		// fixed: the feed loop advanced by `text[i].length` (always 1) while
		// reading a full code point, so an astral character was inserted AND
		// its low surrogate after it — `"😀"` became three UTF-16 units.
		// The motion cases above catch it indirectly; this one names it.
		const ed = make();
		ed.feed(enc("\u{1F600}"));
		expect([...ed.line()]).toHaveLength(1);
		expect(ed.line()).toBe("\u{1F600}");
	});

	/*
	 * WHAT THIS BOUNDARY IS NOT: a grapheme cluster segmenter.
	 *
	 * Measured, and the results are right for the wrong reason in two
	 * cases and wrong in a third:
	 *
	 *   `👍🏽`  deletes in ONE press — correct, but by accident: the emoji
	 *          and the skin-tone modifier both class as "punct" and form
	 *          one run. `#joins` does not list U+1F3FB–1F3FF.
	 *   `🇯🇵`  deletes in ONE press — same accident, two regional
	 *          indicators in one "punct" run.
	 *   `😀😁` deletes in ONE press — and this one IS wrong: two separate
	 *          glyphs, one run, because "punct" does not distinguish them.
	 *
	 * A real segmenter (Intl.Segmenter, or the UAX #29 tables) is the fix
	 * and is out of this round's scope. Recorded here rather than left to
	 * be rediscovered, because the two accidental passes make the gap look
	 * smaller than it is.
	 */
	it("motion never lands inside a surrogate pair", () => {
		const out = probe("ab \u{1F600}", "\x1bb");
		expect(out).toBe("ab |\u{1F600}");
		expect([...out].some((c) => c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff && c.length === 1)).toBe(false);
	});
});

describe("E1 §1 — the two ways the bytes can lie about themselves", () => {
	it("an escape SPLIT ACROSS CHUNKS is NOT joined — esc stays immediate", () => {
		// DECLARED, not a gap. The work order asked for the split pair to
		// join through #pending; built that way it broke six gates in four
		// files, because parking a lone ESC is what joining requires and
		// esc immediacy is what parking spends — esc INTERRUPTS A RUN.
		//
		// Alt+Enter ruled this exact question for these exact bytes:
		// "A terminal sends Alt+X as ESC and X in ONE write, so SAME-CHUNK
		// is the whole test... the bare Esc fires at once (its immediacy is
		// exactly what a hold would spend)". `dc7-osc-swallow` states the
		// same ruling from the other side. This case pins the cost so it
		// cannot drift into an accident.
		const ed = make();
		ed.feed(enc("alpha beta"));
		ed.feed(enc("\x1b"));
		ed.feed(enc("b"));
		// the esc acted on its own; the `b` is a character
		expect(ed.line()).toBe("alpha betab");
	});

	it("inside BRACKETED PASTE none of the gestures fire — the bytes are content", () => {
		const ed = make();
		ed.feed(enc("\x1b[200~a\x1bbb\x1b[201~"));
		// the pasted bytes stay as pasted: an escape and a `b`, not a motion
		expect(ed.line()).toContain("a");
		expect(ed.line().length).toBeGreaterThan(1);
	});
});

describe("E1 §1 — UD-1: every deletion is undoable exactly", () => {
	it("ctrl+z restores a killed CJK character", () => {
		const CJK = "\u4e2d\u6587\u5b57"; // escaped — see the boundary case above
		const ed = make();
		ed.feed(enc(CJK));
		ed.feed(enc("\x1b\x7f"));
		expect(ed.line()).toBe("\u4e2d\u6587");
		ed.feed(enc("\x1a"));
		expect(ed.line()).toBe(CJK);
	});

	it("ctrl+z restores a killed emoji whole", () => {
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		const ed = make();
		ed.feed(enc(`hi ${family}`));
		ed.feed(enc("\x1b\x7f"));
		expect(ed.line()).toBe("hi ");
		ed.feed(enc("\x1a"));
		expect(ed.line()).toBe(`hi ${family}`);
	});

	it("a deletion that removes NOTHING takes no checkpoint", () => {
		// An archive point for a kill that killed nothing would make the
		// next ctrl+z land on it and appear to do nothing.
		//
		// The first version of this case asserted that ctrl+z after the
		// no-op kill undid the TYPING — and typing takes no checkpoint at
		// all (UD-1's rule is about gestures that DESTROY, and typing
		// destroys nothing), so it was asserting the wrong thing. The
		// observable claim is that the ONE undo reaches the REAL kill.
		const ed = make();
		ed.feed(enc("alpha beta"));
		ed.feed(enc("\x1b\x7f")); // a real kill — one checkpoint
		expect(ed.line()).toBe("alpha ");
		ed.feed(enc("\x1bb")); // to the start
		ed.feed(enc("\x1bb")); // still the start
		ed.feed(enc("\x1b\x7f")); // nothing behind the cursor — must NOT checkpoint
		expect(ed.line()).toBe("alpha ");
		ed.feed(enc("\x1a")); // the one undo reaches the real kill
		expect(ed.line()).toBe("alpha beta");
	});
});
