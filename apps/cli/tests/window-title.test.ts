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
import type { Event } from "@vincemakes/kiso-core";
import { OSC_TITLE_PREFIX, OSC_TITLE_SUFFIX, sanitizeTitle, titleText, windowTitleText } from "../src/window-title.js";

const ev = (content: string): Event => ({ seq: 0, type: "user_input", content });

describe("the window title text", () => {
	// Graphite §8.10: `<name> — <folder>`; the product's own name is the
	// placeholder until the session has one (it no longer prefixes the name).
	it("before the session has a title, kiso and the folder", () => {
		expect(windowTitleText([], "kiso")).toBe("kiso — kiso");
	});

	it("once a substantive prompt lands, the session's own title names it", () => {
		expect(windowTitleText([ev("fix the resize repaint")], "kiso")).toBe("fix the resize repaint — kiso");
	});

	it("an opener is not a title — it holds until something substantive arrives", () => {
		// The SAME rule the resume picker and `kiso sessions` use: the title
		// is one definition, or it is two labels for one session.
		expect(windowTitleText([ev("hi"), ev("rewrite the adapter error mapping")], "kiso")).toBe("rewrite the adapter error mapping — kiso");
	});

	it("a long title is cut by CELLS, with the mark", () => {
		const out = windowTitleText([ev("a".repeat(80))], "kiso");
		expect(out).toBe(`${"a".repeat(39)}… — kiso`);
	});

	it("the cut counts wide characters as two cells, never as one", () => {
		// 30 double-width characters are 60 cells: the cut lands inside them.
		// A title measured in code points would have let all 30 through and
		// overflowed the tab by 20 columns. Written as an ESCAPE, not as the
		// character: the tracked tree is English and the CJK gate scans it,
		// and a width fixture is the one place where the realistic input IS
		// a wide script. The escape is the same code point, spelled ASCII.
		const out = windowTitleText([ev("\u6f22".repeat(30))], "kiso");
		const shown = out.slice(0, -" — kiso".length);
		expect([...shown].length).toBe(20); // 19 wide + the mark
		expect(shown.endsWith("…")).toBe(true);
	});

	it("control bytes in a prompt never reach the terminal", () => {
		// A title is whatever the human typed or pasted. A BEL would end the
		// sequence early and an ESC would start another one, so the title
		// would stop being a title and start being commands.
		const out = windowTitleText([ev("rm \u0007\u001b]0;pwned the thing")], "kiso");
		expect(out).not.toContain("\u001b");
		expect(out).not.toContain("\u0007");
		expect(out).toContain("pwned"); // the TEXT survives; only the control bytes go
	});

	it("§8.10 — the three states: ready has no mark, working wears ✦, waiting says it needs you", () => {
		expect(titleText("ready", "fix the repaint", "kiso")).toBe("fix the repaint — kiso");
		expect(titleText("working", "fix the repaint", "kiso")).toBe("✦ fix the repaint — kiso");
		expect(titleText("needs-you", "fix the repaint", "kiso")).toBe("❯ needs you · fix the repaint — kiso");
		expect(titleText("working", null, "kiso")).toBe("✦ kiso — kiso");
		expect(windowTitleText([ev("fix the repaint")], "kiso", "needs-you")).toBe("❯ needs you · fix the repaint — kiso");
	});

	it("bidi controls and invisible format characters never reach a title", () => {
		// each one can reorder or hide what a tab says without being a
		// control byte — escapeTerminal alone lets them through
		const sneaky = "a\u061cb\u200bc\u200fd\u202ae\u202ef\u2060g\u2069h\ufeffi";
		expect(sanitizeTitle(sneaky)).toBe("abcdefghi");
		expect(titleText("ready", "evil\u202egnp.exe", "w\u200bork")).toBe("evilgnp.exe — work");
		// a name made only of them is no name
		expect(titleText("ready", "\u200b\u200b", "kiso")).toBe("kiso — kiso");
	});

	it("the sequence is OSC 0, BEL-terminated", () => {
		expect(OSC_TITLE_PREFIX).toBe("\u001b]0;");
		expect(OSC_TITLE_SUFFIX).toBe("\u0007");
	});
});
