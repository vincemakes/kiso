/**
 * The terminal's window title.
 *
 * kiso set none, so a tab read whatever the shell put there — the
 * directory the shell was in and the absolute path of a node binary, for
 * every kiso in every tab. The title is the one place a terminal will
 * show which session a tab holds without the user switching to it.
 *
 * OSC 0, BEL-terminated, which sets the icon name AND the window title;
 * written straight to stdout, outside the compositor (a title is not a
 * cell and occupies no column, so it is not in the width accounting).
 * No restore on exit: the shell repaints its own title, and a kiso that
 * tried to put back what it found would have to read it first, which no
 * terminal reliably answers.
 */

import { describe, expect, it } from "vitest";
import { OSC_TITLE_PREFIX, OSC_TITLE_SUFFIX, sanitizeTitle, titleText, windowTitleText } from "../src/window-title.js";

describe("the window title text", () => {
	// Graphite §8.10, re-derived for the card round (owner, 2026-10-05):
	// the title says kiso and the folder. DECLARED REVERSAL of 0.39.1's
	// prompt-derived name and of the working tab's ✦ (2026-09-28); the
	// cases that pinned them (the substantive-prompt name, the opener
	// rule, `✦ <name>`) are re-derived here, not deleted: a prompt never
	// names the tab now, and a working tab looks like a ready one.
	it("kiso and the folder, whatever the session's first prompt said", () => {
		expect(windowTitleText("kiso")).toBe("kiso — kiso");
		expect(titleText("ready", null, "work")).toBe("kiso — work");
	});

	it("§8.10 — no mark while working; waiting says it needs you, in words", () => {
		expect(titleText("working", null, "work")).toBe("kiso — work");
		expect(titleText("needs-you", null, "work")).toBe("kiso · needs you — work");
		expect(windowTitleText("work", "needs-you")).toBe("kiso · needs you — work");
		for (const st of ["ready", "working", "needs-you"] as const) {
			expect(titleText(st, null, "work")).not.toMatch(/[\u2726\u276f]/);
			expect(titleText(st, "fix-auth", "work")).not.toMatch(/[\u2726\u276f]/);
		}
	});

	it("a session named with /name shows its name after kiso", () => {
		expect(titleText("ready", "fix-auth", "work")).toBe("kiso · fix-auth — work");
		expect(titleText("working", "fix-auth", "work")).toBe("kiso · fix-auth — work");
		expect(titleText("needs-you", "fix-auth", "work")).toBe("kiso · needs you · fix-auth — work");
	});

	it("a long name is cut by CELLS, with the mark", () => {
		expect(titleText("ready", "a".repeat(80), "kiso")).toBe(`kiso · ${"a".repeat(39)}\u2026 — kiso`);
	});

	it("the cut counts wide characters as two cells, never as one", () => {
		// 30 double-width characters are 60 cells: the cut lands inside them.
		// A name measured in code points would have let all 30 through and
		// overflowed the tab by 20 columns. Written as an ESCAPE, not as the
		// character: the tracked tree is English and the CJK gate scans it,
		// and a width fixture is the one place where the realistic input IS
		// a wide script. The escape is the same code point, spelled ASCII.
		const out = titleText("ready", "\u6f22".repeat(30), "kiso");
		const shown = out.slice("kiso · ".length, -" — kiso".length);
		expect([...shown].length).toBe(20); // 19 wide + the mark
		expect(shown.endsWith("\u2026")).toBe(true);
	});

	it("control bytes in a name never reach the terminal", () => {
		// A name is whatever the human typed or pasted. A BEL would end the
		// sequence early and an ESC would start another one, so the title
		// would stop being a title and start being commands.
		const out = titleText("ready", "rm \u0007\u001b]0;pwned the thing", "kiso");
		expect(out).not.toContain("\u001b");
		expect(out).not.toContain("\u0007");
		expect(out).toContain("pwned"); // the TEXT survives; only the control bytes go
	});

	it("bidi controls and invisible format characters never reach a title", () => {
		// each one can reorder or hide what a tab says without being a
		// control byte — escapeTerminal alone lets them through
		const sneaky = "a\u061cb\u200bc\u200fd\u202ae\u202ef\u2060g\u2069h\ufeffi";
		expect(sanitizeTitle(sneaky)).toBe("abcdefghi");
		expect(titleText("ready", "evil\u202egnp.exe", "w\u200bork")).toBe("kiso · evilgnp.exe — work");
		// a name made only of them is no name
		expect(titleText("ready", "\u200b\u200b", "kiso")).toBe("kiso — kiso");
	});

	it("the sequence is OSC 0, BEL-terminated", () => {
		expect(OSC_TITLE_PREFIX).toBe("\u001b]0;");
		expect(OSC_TITLE_SUFFIX).toBe("\u0007");
	});
});
