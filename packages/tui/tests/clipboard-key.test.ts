/**
 * REL-0152-D15 — ctrl+V is the gesture that fetches the clipboard.
 *
 * REL-0152-D11 shipped image paste keyed on an EMPTY bracketed paste,
 * reasoning that a terminal cannot put binary into a byte stream so the
 * paste would arrive with no content. The owner tested it and neither
 * cmd+V nor ctrl+V attached anything.
 *
 * The reasoning was half right. A terminal cannot send the image — but
 * with no text on the clipboard it does not send a bracketed paste
 * either. There is no empty paste to react to; there is no event at all.
 * The hook was waiting for a signal the terminal never emits.
 *
 * ctrl+V does arrive: it is 0x16, a real byte the editor already
 * receives and has always thrown away as "other control". That is the
 * gesture, and it works whatever the terminal decides to do about cmd+V.
 *
 * The empty-paste route stays, because a terminal that DOES send an
 * empty paste (they differ) should behave the same way. Two doors, one
 * room.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CTRL_V = "\x16";

describe("REL-0152-D15 — ctrl+V asks for the clipboard", () => {
	it("ctrl+V calls the hook and inserts what it returns", () => {
		const editor = new Editor(() => {});
		let asked = 0;
		editor.onClipboardPaste(() => {
			asked += 1;
			return "/tmp/shot.png";
		});
		editor.feed(enc(CTRL_V));
		expect(asked).toBe(1);
		// DECLARED SUPERSESSION (REL-0152-D16): what lands is the CAPSULE,
		// not the path. Inserting the path was this feature's last bug —
		// it begins with `/`, so the composer sent it to the slash-command
		// dispatcher. What this case is for is that ctrl+V ASKS and
		// something lands, and both are unchanged.
		expect(editor.line()).toBe("[Image #1]");
		expect(editor.attachments().get(1)).toBe("/tmp/shot.png");
	});

	it("ctrl+V inserts AT THE CURSOR, keeping the words around it", () => {
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => "/tmp/shot.png");
		editor.feed(enc("what is wrong here? "));
		editor.feed(enc(CTRL_V));
		editor.feed(enc(" thanks"));
		expect(editor.line()).toBe("what is wrong here? [Image #1] thanks");
	});

	it("a hook that finds nothing leaves the line untouched — no stray byte", () => {
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => null);
		editor.feed(enc("typed"));
		editor.feed(enc(CTRL_V));
		expect(editor.line()).toBe("typed");
	});

	it("with NO hook wired, ctrl+V is inert — it must never insert 0x16", () => {
		const editor = new Editor(() => {});
		editor.feed(enc(`a${CTRL_V}b`));
		expect(editor.line()).toBe("ab");
	});

	it("an EMPTY bracketed paste still asks too — terminals differ", () => {
		const editor = new Editor(() => {});
		let asked = 0;
		editor.onClipboardPaste(() => {
			asked += 1;
			return "/tmp/x.png";
		});
		editor.feed(enc("\x1b[200~\x1b[201~"));
		expect(asked).toBe(1);
		expect(editor.line()).toBe("[Image #1]");
	});

	it("a paste WITH content never asks — that is ordinary text", () => {
		const editor = new Editor(() => {});
		let asked = 0;
		editor.onClipboardPaste(() => {
			asked += 1;
			return "/tmp/x.png";
		});
		editor.feed(enc("\x1b[200~hello\x1b[201~"));
		expect(asked).toBe(0);
		expect(editor.line()).toBe("hello");
	});
});
