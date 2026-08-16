/**
 * KC1 slice ① — the multi-line composer's INPUT layer: the §3 newline
 * normalizer (every newline source funnels through ONE rule), the key
 * bindings (§4), and the derived line model (§5 — the buffer stays FLAT:
 * 0x0A is a stored code point, lines and the cursor's row/col are
 * DERIVED, never a second mutable model).
 *
 * The proofs (the approved design's §7): T-E1 (a paste keeps its
 * newlines), T-E1a (the CRLF matrix — LF / CR / CRLF / a CR|LF pair
 * split across stdin chunks each yield EXACTLY one 0x0A), T-E2 (Ctrl+J
 * inserts, Enter submits the whole multi-line buffer as ONE line(), a
 * paste's Enter still never submits — the surviving contract), T-E3
 * (Shift+Enter where the terminal encodes it: kitty CSI-u `13;2u`,
 * xterm modifyOtherKeys `27;2;13~`, chunk-split-safe through the
 * existing #pending resume), T-E4 (↑/↓ walk the lines with the
 * #verticalGoalCol, while history and queue-pop stay gated on an EMPTY
 * buffer and the menu/panel precedence is unchanged), and A3 (the
 * line-local Ctrl+A/E/U/K — single-line behavior identical).
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";
import type { PanelView } from "../src/approval-panel.js";

const enc = (s: string) => new TextEncoder().encode(s);

const make = () => {
	const lines: string[] = [];
	const editor = new Editor(() => {});
	editor.onLine((l) => lines.push(l));
	return { editor, lines };
};

/** the count of REAL newlines in the buffer — the §3 gate's unit (a
 *  CRLF that yielded two 0x0A would show up here, never in a `toBe`
 *  on the text alone) */
const newlines = (s: string): number => [...s].filter((c) => c === "\n").length;

describe("KC1 T-E1 — a paste keeps its newlines (the declared supersession of the space-substitution)", () => {
	it("bracketed paste inserts LITERAL newlines; ONE submit delivers the block", () => {
		const { editor, lines } = make();
		editor.feed(enc("\x1b[200~a\nb\nc\x1b[201~"));
		expect(editor.line()).toBe("a\nb\nc");
		expect(lines).toEqual([]); // the paste's newlines never submit
		editor.feed(enc("\r"));
		expect(lines).toEqual(["a\nb\nc"]); // ONE line() carrying them literally
		expect(editor.line()).toBe(""); // the buffer cleared on submit
	});

	it("the pasted block survives editing: a backspace at the end never eats a newline it did not reach", () => {
		const { editor } = make();
		editor.feed(enc("\x1b[200~a\nb\x1b[201~"));
		editor.feed(enc("\x7f"));
		expect(editor.line()).toBe("a\n");
		editor.feed(enc("\x7f"));
		expect(editor.line()).toBe("a"); // the newline is ONE code point — one key
	});
});

describe("KC1 T-E1a — the CRLF matrix: every boundary yields EXACTLY one 0x0A", () => {
	for (const [label, body] of [
		["LF", "a\nb"],
		["CR", "a\rb"],
		["CRLF", "a\r\nb"],
	] as const) {
		it(`a pasted ${label} boundary is ONE newline`, () => {
			const { editor } = make();
			editor.feed(enc(`\x1b[200~${body}\x1b[201~`));
			expect(editor.line()).toBe("a\nb");
			expect(newlines(editor.line())).toBe(1);
		});
	}

	it("a CR|LF pair SPLIT across stdin chunks is ONE newline — the trailing CR parks in #pending", () => {
		const { editor } = make();
		editor.feed(enc("\x1b[200~a\r")); // the chunk ends ON the CR — it parks, undecided
		expect(editor.line()).toBe("a"); // nothing committed yet
		editor.feed(enc("\nb\x1b[201~")); // the next chunk's leading LF resolves the pair
		expect(editor.line()).toBe("a\nb");
		expect(newlines(editor.line())).toBe(1);
	});

	it("a parked CR followed by anything OTHER than LF resolves as its own newline", () => {
		const { editor } = make();
		editor.feed(enc("\x1b[200~a\r"));
		editor.feed(enc("b\x1b[201~"));
		expect(editor.line()).toBe("a\nb");
		expect(newlines(editor.line())).toBe(1);
	});

	it("a CRLF typed OUTSIDE a paste submits ONCE — the LF never lands in the fresh buffer", () => {
		const { editor, lines } = make();
		editor.feed(enc("hello\r\n"));
		expect(lines).toEqual(["hello"]); // ONE submit, not two
		expect(editor.line()).toBe(""); // and no stray newline left behind
	});
});

describe("KC1 T-E2 — Ctrl+J inserts, Enter submits the whole buffer", () => {
	it("Ctrl+J (LF) inserts a newline; Enter (CR) submits the 3-line buffer as ONE line()", () => {
		const { editor, lines } = make();
		editor.feed(enc("one\x0atwo\x0athree"));
		expect(editor.line()).toBe("one\ntwo\nthree");
		expect(lines).toEqual([]); // three lines, zero submits
		editor.feed(enc("\r"));
		expect(lines).toEqual(["one\ntwo\nthree"]); // ONE submit, the newlines literal
		expect(editor.line()).toBe("");
	});

	it("a paste's Enter does NOT submit; a real Enter does (the surviving contract, re-pinned)", () => {
		const { editor, lines } = make();
		editor.feed(enc("\x1b[200~a\rb\x1b[201~"));
		expect(lines).toEqual([]); // the paste's CR became a NEWLINE, not a submit
		expect(editor.line()).toBe("a\nb");
		editor.feed(enc("\r"));
		expect(lines).toEqual(["a\nb"]);
	});

	it("the multi-line submit rides the history like any other turn", () => {
		const { editor } = make();
		editor.feed(enc("a\x0ab\r"));
		editor.feed(enc("\x1b[A")); // ↑ from the empty input — the browse
		expect(editor.line()).toBe("a\nb");
	});
});

describe("KC1 T-E3 — Shift+Enter where the terminal encodes it", () => {
	it("kitty CSI-u `13;2u` inserts a newline", () => {
		const { editor, lines } = make();
		editor.feed(enc("a\x1b[13;2ub"));
		expect(editor.line()).toBe("a\nb");
		expect(lines).toEqual([]);
	});

	it("xterm modifyOtherKeys `27;2;13~` inserts a newline", () => {
		const { editor, lines } = make();
		editor.feed(enc("a\x1b[27;2;13~b"));
		expect(editor.line()).toBe("a\nb");
		expect(lines).toEqual([]);
	});

	it("both forms survive a chunk split — the incomplete CSI parks in #pending", () => {
		const { editor } = make();
		editor.feed(enc("a\x1b[13")); // the CSI is incomplete — it parks
		expect(editor.line()).toBe("a");
		editor.feed(enc(";2ub"));
		expect(editor.line()).toBe("a\nb");
		editor.feed(enc("\x1b[27;2"));
		editor.feed(enc(";13~c"));
		expect(editor.line()).toBe("a\nb\nc");
	});

	it("an UNMODIFIED CSI-u (`13;1u`) is not a newline — the shift bit is the binding", () => {
		const { editor } = make();
		editor.feed(enc("a\x1b[13;1ub"));
		expect(editor.line()).toBe("ab");
	});
});

describe("KC1 T-E4 — ↑/↓ walk the lines; history and queue-pop stay EMPTY-gated", () => {
	/** a 3-line buffer: a long line, a SHORT one, a long one — the goal
	 *  column's proof shape (20 → 5 → 20) */
	const threeLines = () => {
		const { editor, lines } = make();
		editor.feed(enc(`${"x".repeat(30)}\x0ashort\x0a${"y".repeat(30)}`));
		editor.feed(enc("\x01")); // Ctrl+A — line-local home (the last line's start)
		editor.feed(enc("\x1b[A"));
		editor.feed(enc("\x1b[A")); // ↑↑ — the first line, column 0
		return { editor, lines };
	};

	it("#verticalGoalCol: column 20 → a short line clamps to 5 → the next long line RETURNS to 20", () => {
		const { editor } = threeLines();
		editor.feed(enc("\x1b[C".repeat(20))); // → ×20 — a horizontal move RESETS the goal
		expect(editor.dockState().cursor).toBe(20);
		editor.feed(enc("\x1b[B")); // ↓ — the short line clamps
		expect(editor.dockState().cursor).toBe(5);
		editor.feed(enc("\x1b[B")); // ↓ — the goal column returns
		expect(editor.dockState().cursor).toBe(20);
	});

	it("an insert RESETS the goal column — the walk restarts from where the user typed", () => {
		const { editor } = threeLines();
		editor.feed(enc("\x1b[C".repeat(20)));
		editor.feed(enc("\x1b[B")); // ↓ — clamped to 5, the goal still 20
		editor.feed(enc("z")); // an edit — the goal dies here
		expect(editor.dockState().cursor).toBe(6);
		editor.feed(enc("\x1b[B")); // ↓ — column 6, NOT the retired goal 20
		expect(editor.dockState().cursor).toBe(6);
	});

	it("↑ at the first line and ↓ at the last stay put — the walk never leaves the buffer", () => {
		const { editor } = threeLines();
		editor.feed(enc("\x1b[A")); // ↑ at the top
		expect(editor.dockState().cursor).toBe(0);
		expect(editor.line()).toBe(`${"x".repeat(30)}\nshort\n${"y".repeat(30)}`); // no history recall
		editor.feed(enc("\x1b[B"));
		editor.feed(enc("\x1b[B"));
		editor.feed(enc("\x1b[B")); // ↓ past the last line
		expect(editor.line()).toBe(`${"x".repeat(30)}\nshort\n${"y".repeat(30)}`);
	});

	it("the history stays EMPTY-gated: a multi-line draft's ↑ navigates it, never recalls", () => {
		const { editor } = make();
		editor.feed(enc("remembered\r"));
		editor.feed(enc("a\x0ab")); // a 2-line draft
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("a\nb"); // the draft survives — no recall
		editor.clearLine();
		editor.feed(enc("\x1b[A")); // from the EMPTY input the browse works as before
		expect(editor.line()).toBe("remembered");
	});

	it("the queue-pop stays EMPTY-gated: a multi-line draft's ↑ never pops a queued turn", () => {
		const { editor } = make();
		const queue = ["queued turn"];
		editor.bindQueue(
			() => queue,
			() => queue.pop() ?? null,
		);
		editor.feed(enc("a\x0ab"));
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("a\nb");
		expect(queue).toEqual(["queued turn"]); // the chip stayed in the queue
		editor.clearLine();
		editor.feed(enc("\x1b[A")); // from the EMPTY input the pop walks as before
		expect(editor.line()).toBe("queued turn");
		expect(queue).toEqual([]);
	});

	it("the menu keeps ↑↓ while open, and the panel keeps them while up — the precedence is unchanged", () => {
		const { editor } = make();
		editor.feed(enc("/m"));
		expect(editor.menuState()?.selected).toBe(0);
		editor.feed(enc("\x1b[B"));
		expect(editor.menuState()?.selected).toBe(1); // the menu owns ↓
		editor.feed(enc("\x1b")); // close the menu, clear the buffer
		const view: PanelView = {
			flavor: "approval",
			name: "edit_file",
			title: "edit examples/foo.ts",
			speaker: "mode:default",
			hint: "/mode accept-edits auto-approves edits",
			statusText: "▸ run paused",
			args: { kind: "text", lines: ["old", "new"] },
			fallbackQuestion: "approve edit_file? (y/n) ",
		};
		editor.beginPanel(view, () => {});
		editor.feed(enc("a\x0ab")); // a multi-line rule/feedback line
		editor.feed(enc("\x1b[A")); // ↑ — the panel owns the keys, nothing moves
		expect(editor.dockState().cursor).toBe(1); // still at the end of "b"
	});
});

describe("KC1 A3 — Ctrl+A/E/U/K are LINE-local (single-line behavior identical)", () => {
	it("Ctrl+A/E move within the CURSOR's line", () => {
		const { editor } = make();
		editor.feed(enc("one\x0atwo"));
		editor.feed(enc("\x01")); // Ctrl+A — the second line's start
		expect(editor.dockState().cursor).toBe(0);
		editor.feed(enc("\x1b[C")); // → one cell into "two"
		editor.feed(enc("\x05")); // Ctrl+E — the second line's end
		expect(editor.dockState().cursor).toBe(3);
		expect(editor.line()).toBe("one\ntwo"); // nothing moved between the lines
	});

	it("Ctrl+U kills to the LINE's start; Ctrl+K to the LINE's end — the other lines survive", () => {
		const { editor } = make();
		editor.feed(enc("one\x0atwo\x0athree"));
		editor.feed(enc("\x1b[A")); // ↑ — the middle line, column 3 (its end)
		editor.feed(enc("\x15")); // Ctrl+U
		expect(editor.line()).toBe("one\n\nthree");
		editor.feed(enc("\x1b[A")); // ↑ — the first line
		editor.feed(enc("\x01")); // its start
		editor.feed(enc("\x1b[C")); // one cell in
		editor.feed(enc("\x0b")); // Ctrl+K
		expect(editor.line()).toBe("o\n\nthree");
	});

	it("Home/End follow A/E — line-local too", () => {
		const { editor } = make();
		editor.feed(enc("one\x0atwo"));
		editor.feed(enc("\x1b[H"));
		expect(editor.dockState().cursor).toBe(0);
		editor.feed(enc("\x1b[F"));
		expect(editor.dockState().cursor).toBe(3);
	});
});
