/**
 * v2c — the raw-mode editor, unit-tested through its pure surface: the
 * eastAsianWidth table, display-width cursor math, the edit keys, the
 * bracketed-paste unwrap, the question mode, and the startup submit queue.
 */

import { describe, expect, it } from "vitest";
import { charWidth, displayWidth, Editor, PROMPT_WIDTH } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("eastAsianWidth (the drift root cure)", () => {
	it("ASCII and narrow punctuation are 1", () => {
		expect(charWidth("a".codePointAt(0)!)).toBe(1);
		expect(charWidth(" ".codePointAt(0)!)).toBe(1);
		expect(charWidth("▌".codePointAt(0)!)).toBe(1); // the brick half-block stays narrow
		expect(charWidth("─".codePointAt(0)!)).toBe(1); // box drawing
	});

	it("CJK ideographs, kana, hangul, fullwidth forms, emoji are 2", () => {
		expect(charWidth(0x4f60)).toBe(2); // CJK unified (U+4F60)
		expect(charWidth("あ".codePointAt(0)!)).toBe(2); // kana
		expect(charWidth("한".codePointAt(0)!)).toBe(2); // hangul syllable
		expect(charWidth("Ａ".codePointAt(0)!)).toBe(2); // fullwidth form
		expect(charWidth("。".codePointAt(0)!)).toBe(2); // CJK punctuation
		expect(charWidth("😀".codePointAt(0)!)).toBe(2); // emoji
		expect(charWidth("\u{20000}".codePointAt(0)!)).toBe(2); // CJK ext B
	});

	it("displayWidth sums per code point — the cursor math base", () => {
		expect(displayWidth("hello")).toBe(5);
		expect(displayWidth("\u4f60\u597da")).toBe(5); // 2+2+1
		expect(displayWidth("\u4e2d\u6587\u8f93\u5165")).toBe(8); // 4 wide chars
		expect(PROMPT_WIDTH).toBe(2); // ▌ + space (TUI v4 #16d)
	});
});

describe("the editor's editing surface", () => {
	const make = () => {
		const events: string[] = [];
		const editor = new Editor(() => events.push("render"));
		return { editor, events };
	};

	it("UTF-8 printable inserts; dockState reports the visible line and the WIDTH-based cursor column", () => {
		const { editor } = make();
		editor.feed(enc("ab"));
		editor.feed(enc("\u4f60")); // wide — split across the buffer boundary too
		expect(editor.line()).toBe("ab\u4f60");
		const st = editor.dockState();
		expect(st.line).toBe("ab\u4f60");
		expect(st.cursor).toBe(4); // 1+1+2 — display columns, not chars
	});

	it("the cursor moves by display width — ←→, Home/End, Ctrl+A/E", () => {
		const { editor } = make();
		editor.feed(enc("\u4f60\u597d"));
		expect(editor.dockState().cursor).toBe(4);
		editor.feed(enc("\x1b[D")); // ← over the wide char (2 cells)
		expect(editor.dockState().cursor).toBe(2);
		editor.feed(enc("\x1b[C")); // →
		expect(editor.dockState().cursor).toBe(4);
		editor.feed(enc("\x1b[H")); // Home
		expect(editor.dockState().cursor).toBe(0);
		editor.feed(enc("\x1b[F")); // End
		expect(editor.dockState().cursor).toBe(4);
		editor.feed(enc("\x01")); // Ctrl+A
		expect(editor.dockState().cursor).toBe(0);
		editor.feed(enc("\x05")); // Ctrl+E
		expect(editor.dockState().cursor).toBe(4);
	});

	it("Backspace/Delete edit at the code-point boundary, wide chars intact", () => {
		const { editor } = make();
		editor.feed(enc("\u4f60\u597dab"));
		editor.feed(enc("\x7f")); // backspace over 'b'
		expect(editor.line()).toBe("\u4f60\u597da");
		editor.feed(enc("\x7f")); // backspace over 'a'
		expect(editor.line()).toBe("\u4f60\u597d");
		editor.feed(enc("\x7f")); // backspace over the wide char — ONE key removes the whole 2-cell char
		expect(editor.line()).toBe("\u4f60");
		editor.feed(enc("\x01")); // home
		editor.feed(enc("\x1b[3~")); // Delete removes the first char
		expect(editor.line()).toBe("");
	});

	it("Ctrl+U/K/W kill to start/end/word", () => {
		const { editor } = make();
		editor.feed(enc("hello world"));
		editor.feed(enc("\x01")); // home
		editor.feed(enc("\x1b[C".repeat(6))); // → past "hello " — cursor after the space
		editor.feed(enc("\x15")); // Ctrl+U — kill the head
		expect(editor.line()).toBe("world");
		editor.feed(enc("\x0b")); // Ctrl+K — kill the tail (cursor is at 0 now)
		expect(editor.line()).toBe("");
		editor.feed(enc("hello world"));
		editor.feed(enc("\x17")); // Ctrl+W at the end — kill the last word
		expect(editor.line()).toBe("hello ");
	});

	// KC1 (2026-08-16) — DECLARED SUPERSESSION #1: the paste's internal
	// newlines no longer become spaces; they are inserted literally (the
	// composer's whole point). The unwrap itself is unchanged.
	it("bracketed paste unwraps; internal newlines are INSERTED (the KC1 multi-line composer)", () => {
		const { editor } = make();
		editor.feed(enc("\x1b[200~multi\nline\x1b[201~"));
		expect(editor.line()).toBe("multi\nline");
	});

	// KC1 — DECLARED SUPERSESSION #2 (the "became a space" half only):
	// the no-submit-during-paste contract below is UNCHANGED — it is the
	// declared survivor; only the submitted text moves (space → newline).
	it("a paste's Enter does NOT submit; a real Enter does", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("\x1b[200~a\nb\x1b[201~"));
		expect(lines).toEqual([]); // the paste's newline became a NEWLINE — and never a submit
		editor.feed(enc("\r"));
		expect(lines).toEqual(["a\nb"]);
		expect(editor.line()).toBe(""); // the buffer cleared on submit
	});

	it("question mode: the NEXT submit answers, not a turn", () => {
		const { editor } = make();
		const lines: string[] = [];
		const answers: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.question("q?", (a) => answers.push(a));
		editor.feed(enc("y\r"));
		expect(answers).toEqual(["y"]);
		expect(lines).toEqual([]);
		editor.feed(enc("next\r"));
		expect(lines).toEqual(["next"]); // the turn path resumed
	});

	it("a cancelled question keeps the buffer — its text becomes the next turn", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.question("q?", () => {});
		editor.feed(enc("typed answer"));
		editor.cancelQuestion();
		editor.feed(enc("\r"));
		expect(lines).toEqual(["typed answer"]);
	});

	it("submits before onLine is wired are queued, never dropped (the startup race)", () => {
		const { editor } = make();
		editor.feed(enc("early\r"));
		expect(editor.line()).toBe("");
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		expect(lines).toEqual(["early"]);
	});

	it("Esc / Ctrl+C / Ctrl+D dispatch to the CLI handlers", () => {
		const { editor } = make();
		let sigint = 0;
		let eot = 0;
		let escape = 0;
		editor.onSigint(() => sigint += 1);
		editor.onEot(() => eot += 1);
		editor.onEscape(() => escape += 1);
		editor.feed(enc("\x1b"));
		editor.feed(enc("\x03"));
		editor.feed(enc("\x04"));
		expect(sigint).toBe(1);
		expect(eot).toBe(1);
		expect(escape).toBe(1);
	});
});

describe("v3 §04: the slash-command menu", () => {
	const make = () => {
		const events: string[] = [];
		const editor = new Editor(() => events.push("render"));
		return { editor, events };
	};

	it("opens on a slash prefix, filters by the buffer, closes on a bare slash or a non-slash line", () => {
		const { editor } = make();
		expect(editor.menuState()).toBeNull();
		editor.feed(enc("/"));
		expect(editor.menuState()).toBeNull(); // a bare "/" waits
		editor.feed(enc("m"));
		const s1 = editor.menuState();
		expect(s1?.items.map((m) => m.name)).toEqual(["/mode", "/model"]);
		editor.feed(enc("ode"));
		// "/model" has "/mode" as a prefix — both match; the buffer narrows
		// further only at the divergent character.
		expect(editor.menuState()?.items.map((m) => m.name)).toEqual(["/mode", "/model"]);
		editor.feed(enc("l"));
		expect(editor.menuState()?.items.map((m) => m.name)).toEqual(["/model"]);
		editor.feed(enc("x")); // "/modelx" matches nothing — closed
		expect(editor.menuState()).toBeNull();
	});

	it("↑↓ stay within the filtered list (the command table has no shared prefix — the selection logic still bounds); Tab completes", () => {
		const { editor } = make();
		editor.feed(enc("/st"));
		expect(editor.menuState()!.items.map((m) => m.name)).toEqual(["/status"]);
		editor.feed(enc("\x1b[B")); // ↓ at the bottom — stays
		expect(editor.menuState()!.selected).toBe(0);
		editor.feed(enc("\x1b[A")); // ↑ at the top — stays
		expect(editor.menuState()!.selected).toBe(0);
		editor.feed(enc("\t")); // Tab completes to the selection
		expect(editor.line()).toBe("/status");
	});

	it("A1: a PARTIAL Enter completes without executing; the EXACT Enter submits directly; Esc closes the menu and clears the buffer", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("/st"));
		editor.feed(enc("\x1b[B")); // ↓ → /status
		editor.feed(enc("\r")); // A1: partial — COMPLETES, nothing submits
		expect(lines).toEqual([]);
		expect(editor.line()).toBe("/status");
		expect(editor.menuState()).not.toBeNull(); // still open — review and Enter again
		editor.feed(enc("\r")); // the exact match now submits directly
		expect(lines).toEqual(["/status"]);
		expect(editor.line()).toBe("");
		expect(editor.menuState()).toBeNull();
		// A1: typing the FULL command and pressing Enter ONCE executes it.
		editor.feed(enc("/mode"));
		editor.feed(enc("\r"));
		expect(lines).toEqual(["/status", "/mode"]);
		expect(editor.line()).toBe("");
		// Esc: open the menu, then cancel it — the buffer clears, nothing submits.
		editor.feed(enc("/mo"));
		expect(editor.menuState()).not.toBeNull();
		editor.feed(enc("\x1b"));
		expect(editor.menuState()).toBeNull();
		expect(editor.line()).toBe("");
		expect(lines).toEqual(["/status", "/mode"]); // nothing new submitted
	});
});

describe("A2 (the feel): the session-scoped input history", () => {
	const make = () => {
		const events: string[] = [];
		const editor = new Editor(() => events.push("render"));
		return { editor, events };
	};

	it("↑ from an EMPTY input browses the newest entry; ↑↑ older; ↓ past the newest exits; Enter submits the browsed line", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("hello"));
		editor.feed(enc("\r"));
		editor.feed(enc("world"));
		editor.feed(enc("\r"));
		expect(editor.line()).toBe("");
		editor.feed(enc("\x1b[A")); // ↑ — the newest
		expect(editor.line()).toBe("world");
		editor.feed(enc("\x1b[A")); // ↑ — older
		expect(editor.line()).toBe("hello");
		editor.feed(enc("\x1b[A")); // ↑ at the oldest — stays
		expect(editor.line()).toBe("hello");
		editor.feed(enc("\x1b[B")); // ↓ — newer
		expect(editor.line()).toBe("world");
		editor.feed(enc("\x1b[B")); // ↓ past the newest — exits to the empty input
		expect(editor.line()).toBe("");
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("world");
		editor.feed(enc("\r")); // Enter submits the browsed line
		expect(lines).toEqual(["hello", "world", "world"]);
		expect(editor.line()).toBe("");
	});

	it("Esc exits the browse back to the empty input; an edit leaves the browse; ↑↓ mid-edit do nothing", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("first"));
		editor.feed(enc("\r"));
		// Esc during the browse restores the empty input.
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("first");
		editor.feed(enc("\x1b"));
		expect(editor.line()).toBe("");
		expect(lines).toEqual(["first"]); // nothing submitted
		// Typing while browsing leaves the browse — ↑↓ then do nothing
		// (the input is non-empty and not browsing: cursor semantics).
		editor.feed(enc("\x1b[A"));
		editor.feed(enc("x"));
		expect(editor.line()).toBe("firstx");
		editor.feed(enc("\x1b[A")); // mid-edit — no navigation
		expect(editor.line()).toBe("firstx");
	});

	it("the history is capped at 100 and collapses adjacent duplicates", () => {
		const { editor } = make();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		for (let i = 0; i < 105; i++) {
			editor.feed(enc(`line-${i}`));
			editor.feed(enc("\r"));
		}
		editor.feed(enc("line-104")); // duplicate of the newest — collapsed
		editor.feed(enc("\r"));
		// The oldest (line-0..line-4) fell off the cap.
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("line-104");
		for (let up = 0; up < 100; up++) editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("line-5"); // 100 entries back from 104
	});
});
