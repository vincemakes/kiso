/**
 * DC-55 — A TAB INSIDE A BRACKETED PASTE IS DROPPED.
 *
 * Pasting indented code loses its indentation, silently: `alpha\tbeta`
 * arrives as `alphabeta` — not a space, not a marker, nothing on screen
 * to say a byte went missing.
 *
 * NOT the paste filter, which is what I first called it. The rule is
 * `editor.ts`'s GENERAL control-byte branch — every code point below
 * U+0020 that no earlier branch claimed is discarded — and it applies
 * identically to a typed byte and a pasted one. A paste has no other way
 * in, which is why it is where the loss shows.
 *
 * A TYPED Tab never reaches that branch: `\t` is claimed further up as
 * the completion key (the menu completes a command, the `@` picker
 * completes a path). It is out of reach here rather than something this
 * round has to avoid, and it keeps completing.
 *
 * TWO DECISIONS, and the gates below keep them apart on purpose.
 *
 * STORAGE: the buffer keeps the real U+0009, so the submitted line and
 * the durable event carry the tab. That is the whole point.
 *
 * RENDERING: a raw tab in the composer row is expanded BY THE TERMINAL
 * to the next tab stop, while `charWidth(0x09)` returns 1 — so the row
 * on screen is wider than the row kiso measured, which is invariant ① in
 * its literal form, and every cursor column after the tab is wrong by
 * the same amount. The composer therefore shows a ONE-CELL stand-in,
 * `→`, IN THE DISPLAY PROJECTION ONLY (`dockState`).
 *
 * One cell rather than a tab-stop expansion because a tab's width is a
 * property of its POSITION, and `charWidth(cp)` takes a code point with
 * no context. CJK's two cells work because two is a property of the
 * character. Those are different problems.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const make = () => new Editor(() => {});
const paste = (inner: string) => enc(`\x1b[200~${inner}\x1b[201~`);

describe("DC-55 — the buffer keeps the tab", () => {
	it("a pasted tab survives into the buffer", () => {
		const ed = make();
		ed.feed(paste("alpha\tbeta"));
		expect(ed.line()).toBe("alpha\tbeta");
	});

	it("leading indentation survives — the case the defect was reported for", () => {
		const ed = make();
		ed.feed(paste("function f() {\n\treturn 1;\n}"));
		expect(ed.line()).toContain("\n\treturn 1;");
	});

	it("other control bytes are still dropped — U+0009 alone opens", () => {
		const ed = make();
		ed.feed(paste("a\x00b\x07c"));
		expect(ed.line()).toBe("abc");
	});
});

describe("DC-55 — the stand-in is DISPLAY ONLY", () => {
	// Two assertions, deliberately. A single check on the rendered row
	// would pass if the substitution happened in `#insert` — which is the
	// same defect wearing a different coat, since the model would then
	// receive `→`.
	it("the ROW shows the stand-in", () => {
		const ed = make();
		ed.feed(paste("a\tb"));
		expect(ed.dockState().line).toContain("→");
	});

	it("the BUFFER holds the tab", () => {
		const ed = make();
		ed.feed(paste("a\tb"));
		expect(ed.line()).toBe("a\tb");
		expect(ed.line()).not.toContain("→");
	});

	it("ONE FOR ONE — the two strings differ at the tab's index and nowhere else", () => {
		const ed = make();
		ed.feed(paste("alpha\tbeta"));
		const shown = [...ed.dockState().line];
		const stored = [...ed.line()];
		expect(shown).toHaveLength(stored.length);
		const differ = shown.map((c, i) => (c === stored[i] ? -1 : i)).filter((i) => i >= 0);
		expect(differ).toEqual([5]); // exactly the tab
	});

	it("the CURSOR column is unchanged by the styling", () => {
		// `dockState` already carries an SGR span — the horizontal-scroll
		// ellipsis is `${dim}…${reset}` — and `cursorCol` COUNTS markers
		// and sums the buffer's own widths rather than measuring the
		// string, so SGR bytes have never been in it. Asserted rather than
		// inherited: the precedent was never pinned.
		const ed = make();
		ed.feed(paste("ab\tcd"));
		expect(ed.dockState().cursorCol).toBe(5); // a-b-TAB-c-d, one cell each
	});
});

describe("DC-55 — UD-1 and the typed key", () => {
	it("a KILL over a pasted tab is undone exactly — the tab comes back as a tab", () => {
		// The first version of this case asserted that ctrl+z undoes the
		// PASTE. Measured: it does not, for any paste, with or without a
		// tab — pasting takes no archive point. That is UD-1 working as
		// written: the rule is that a gesture which DESTROYS >= 2 chars
		// must have one, and a paste adds rather than destroys. The case
		// was asserting a rule the product never made.
		//
		// What UD-1 does promise here is that a DESTRUCTIVE gesture over
		// pasted content restores it exactly, tab included — a word kill
		// that gave back a space, or a `->`, would be the real defect.
		const ed = make();
		ed.feed(paste("alpha\tbeta"));
		expect(ed.line()).toBe("alpha\tbeta");
		ed.feed(enc("\x1b\x7f")); // alt+backspace kills `beta`
		expect(ed.line()).toBe("alpha\t");
		ed.feed(enc("\x1a"));
		expect(ed.line(), "the undo did not restore the pasted text exactly").toBe("alpha\tbeta");
		ed.feed(enc("\x19"));
		expect(ed.line()).toBe("alpha\t");
	});

	it("a TYPED Tab still completes and does NOT insert — it never reaches the control branch", () => {
		const ed = make();
		ed.feed(enc("abc"));
		ed.feed(enc("\t"));
		expect(ed.line(), "a typed Tab inserted a tab — the completion key was taken away").toBe("abc");
	});
});

describe("DC-55 — the row never outgrows the screen", () => {
	// The reason the stand-in exists. A raw tab is expanded BY THE
	// TERMINAL to the next tab stop while `charWidth(0x09)` returns 1, so
	// the painted row would be wider than the row kiso measured —
	// invariant ① — and the drift grows with every tab.
	it("a row of tabs measures one cell each, not eight", () => {
		const ed = make();
		ed.feed(paste("\t\t\t\t"));
		// four tabs: four cells in the projection, not 32
		expect([...ed.dockState().line.replace(/\x1b\[[0-9;]*m/g, "")]).toHaveLength(4);
		expect(ed.dockState().cursorCol).toBe(4);
	});

	it("the buffer still holds four real tabs", () => {
		const ed = make();
		ed.feed(paste("\t\t\t\t"));
		expect(ed.line()).toBe("\t\t\t\t");
	});
});
