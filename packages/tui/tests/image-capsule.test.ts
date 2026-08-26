/**
 * REL-0152-D16 — an attached image is a CAPSULE, not a path.
 *
 * REL-0152-D15 made ctrl+V fetch the clipboard, and it worked: the owner
 * pasted a screenshot and kiso wrote it to a temp file. Then it inserted
 * the PATH, the path began with `/`, and the composer sent it to the
 * slash-command dispatcher:
 *
 *   unknown command: /var/folders/rr/…/paste-89210-…png — /help lists
 *   the commands
 *
 * A feature that reaches the last step and hands the result to the wrong
 * parser has not shipped. The reference implementation avoids it by
 * showing `[image1]`, and the shape was already in this file: D8's paste
 * capsule holds the content beside the buffer and shows a short token.
 *
 * The token is what the LINE carries — so the dispatcher sees
 * `[Image #1]`, which is not a command and never was — and the CLI
 * resolves it to the file when it builds the turn. The path never
 * appears in the composer, in the transcript, or in a command.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CTRL_V = "\x16";

describe("REL-0152-D16 — the image capsule", () => {
	it("ctrl+V shows a capsule, never the path", () => {
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => "/var/folders/rr/zz/T/paste-1.png");
		editor.feed(enc(CTRL_V));
		expect(editor.line()).toBe("[Image #1]");
		expect(editor.line()).not.toContain("/var/");
	});

	it("the submitted LINE is the capsule — the dispatcher never sees a path", () => {
		const seen: string[] = [];
		const editor = new Editor(() => {});
		editor.onLine((l) => seen.push(l));
		editor.onClipboardPaste(() => "/var/folders/rr/zz/T/paste-1.png");
		editor.feed(enc(CTRL_V));
		editor.feed(enc("\r"));
		expect(seen).toEqual(["[Image #1]"]);
		expect(seen[0]!.startsWith("/"), "the line still looks like a command").toBe(false);
	});

	it("the editor hands over WHICH file each capsule stands for", () => {
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => "/tmp/a.png");
		editor.feed(enc(CTRL_V));
		expect(editor.attachments()).toEqual(new Map([[1, "/tmp/a.png"]]));
	});

	it("words around it survive, and two images are two capsules", () => {
		let n = 0;
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => `/tmp/shot-${(n += 1)}.png`);
		editor.feed(enc("what is wrong in "));
		editor.feed(enc(CTRL_V));
		editor.feed(enc(" versus "));
		editor.feed(enc(CTRL_V));
		editor.feed(enc("?"));
		expect(editor.line()).toBe("what is wrong in [Image #1] versus [Image #2]?");
		expect(editor.attachments().get(2)).toBe("/tmp/shot-2.png");
	});

	it("deleting the capsule drops the attachment from the LINE — the map is not the turn", () => {
		const editor = new Editor(() => {});
		editor.onClipboardPaste(() => "/tmp/a.png");
		editor.feed(enc(CTRL_V));
		for (let i = 0; i < "[Image #1]".length; i += 1) editor.feed(enc("\x7f"));
		expect(editor.line()).toBe("");
	});

	it("a TEXT paste is still a text capsule — the two do not collide", () => {
		const editor = new Editor(() => {});
		const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		editor.feed(enc(`\x1b[200~${big}\x1b[201~`));
		expect(editor.line()).toBe("[Pasted text #1 +40 lines]");
	});
});
