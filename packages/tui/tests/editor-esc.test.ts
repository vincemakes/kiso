/**
 * CA-4 (the 2026-08-09 corrective action) — the esc-chain byte
 * consumption: the menu-close and history-exit branches missed the
 * `i += 1` (the convention of the escapeCbs and W22 pop branches) — a
 * bare esc that closes the menu (or exits the history browse) fell
 * through to the escapeCbs on the SAME byte and ABORTED the turn
 * mid-run, while the user was just closing the menu. With the fix,
 * the closing esc consumes its own byte — the interrupt fires only on
 * a LATER esc, exactly as the W22 pop-esc contract.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("CA-4: the esc-chain byte consumption", () => {
	it("an esc closing the menu never fires the interrupt — a later esc at rest does", () => {
		const editor = new Editor(() => {});
		let escaped = 0;
		editor.onEscape(() => {
			escaped += 1;
		});
		editor.feed(enc("/m")); // the slash menu opens ("/mode" matches)
		expect(editor.menuState()).not.toBeNull();
		editor.feed(enc("\x1b")); // one esc closes the menu
		expect(editor.menuState()).toBeNull(); // the menu closed
		expect(escaped).toBe(0); // the closing esc never aborts the turn
		editor.feed(enc("\x1b")); // a LATER esc at rest
		expect(escaped).toBe(1); // the interrupt survives the close
	});

	it("an esc exiting the history browse never fires the interrupt — a later esc at rest does", () => {
		const editor = new Editor(() => {});
		let escaped = 0;
		editor.onEscape(() => {
			escaped += 1;
		});
		editor.feed(enc("hello"));
		editor.feed(enc("\r")); // submit (CR — a real terminal's Enter) — the history records "hello"
		editor.feed(enc("\x1b[A")); // ↑ from the empty line — the browse on
		expect(editor.line()).toBe("hello"); // the browse shows the history
		editor.feed(enc("\x1b")); // one esc exits the browse
		expect(editor.line()).toBe(""); // the pre-browse (empty) input returned
		expect(escaped).toBe(0); // the exiting esc never aborts the turn
		editor.feed(enc("\x1b")); // a LATER esc at rest
		expect(escaped).toBe(1); // the interrupt survives the exit
	});
});
