/**
 * DC-58 (0.32.1) — a control byte INSIDE a paste is content or nothing, never a gesture.
 *
 * `#pasting` is set on `ESC[200~` and the pasted characters are collected,
 * but the key dispatcher runs first, and three claimed control bytes had no
 * paste guard while tab and CR did: 0x07 (ctrl+g, the external editor),
 * 0x14 (ctrl+t, the thinking fold), 0x0f (ctrl+o, expand). A BEL in pasted
 * text — captured terminal output, a log, anything from a program that rang
 * the bell — opened $VISUAL mid-paste and the rest of the body went to that
 * child's stdin. DC-7's rule from the third side: a byte from the TERMINAL
 * must not become a keystroke (DC-7), a byte from a REPLY must not (§2.4's
 * gate), and a byte from a PASTE — data the human handed over — must not
 * become a command either. Found by the worker reading the dispatcher after
 * HF-1/HF-2; unrun by them, proved here.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const paste = (body: string) => `\x1b[200~${body}\x1b[201~`;

function wired(): { e: Editor; fired: string[] } {
	const fired: string[] = [];
	const e = new Editor(() => {});
	e.onExpand(() => fired.push("expand"));
	e.onThink(() => fired.push("think"));
	e.onEditor(() => fired.push("editor"));
	return { e, fired };
}

describe("DC-58 — control bytes inside a bracketed paste", () => {
	it("0x07 in a paste does not open the external editor; the text lands", () => {
		const { e, fired } = wired();
		e.feed(enc(paste("log line\x07 with a bell")));
		expect(fired).toEqual([]);
		expect(e.line()).toBe("log line with a bell");
	});
	it("0x14 and 0x0f in a paste fold nothing and expand nothing", () => {
		const { e, fired } = wired();
		e.feed(enc(paste("a\x14b\x0fc")));
		expect(fired).toEqual([]);
		expect(e.line()).toBe("abc");
	});
	it("the same bytes OUTSIDE a paste are still the gestures", () => {
		const { e, fired } = wired();
		e.feed(enc("\x07"));
		e.feed(enc("\x14"));
		e.feed(enc("\x0f"));
		expect(fired).toEqual(["editor", "think", "expand"]);
	});
});
