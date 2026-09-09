/**
 * TMUX-F1 (kiso-doc/kiso-finding-tmux-wheel-2026-09-10.md) — two editor
 * defects the tmux chain exposed, each on the real byte shape.
 *
 * ① A CSI carrying an INTERMEDIATE byte, or a `>`/`=` parameter, never
 *    matched the parser's class, was parked as "incomplete", and every later
 *    keystroke was appended to a sequence that could never complete: the
 *    editor went deaf for the session. tmux answers DECRQM with
 *    `ESC[?69;0$y`; a DA2 reply is `ESC[>0;95;0c`. A reply kiso did not ask
 *    for must be skipped whole, and what follows it must still type.
 * ② Apple Terminal turns wheel/trackpad scrolling into arrow keys for an
 *    alternate-screen app (tmux's client is one), so a wheel notch arrives as
 *    a BURST of identical arrows in ONE read — three or more, which a hand
 *    never produces in one read — and each one walked the history. Owner
 *    ruling (2026-09-10, option c): a burst is one press.
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function withHistory(entries: string[]): Editor {
	const e = new Editor(() => {});
	e.bindHistory(entries, () => {});
	return e;
}

describe("TMUX-F1 ① — a CSI with an intermediate byte is skipped whole, never parked", () => {
	it("tmux's DECRQM answer `ESC[?69;0$y` does not deafen the editor", () => {
		const e = new Editor(() => {});
		e.feed(enc("\x1b[?69;0$y"));
		e.feed(enc("abc"));
		expect(e.line()).toBe("abc");
	});
	it("a DA2 reply `ESC[>0;95;0c` in the same chunk as typing", () => {
		const e = new Editor(() => {});
		e.feed(enc("\x1b[>0;95;0cabc"));
		expect(e.line()).toBe("abc");
	});
	it("the reply split across two reads still completes and is still skipped", () => {
		const e = new Editor(() => {});
		e.feed(enc("\x1b[?69;0"));
		e.feed(enc("$yabc"));
		expect(e.line()).toBe("abc");
	});
	it("a runaway parameter string past the cap is dropped, not held forever", () => {
		const e = new Editor(() => {});
		e.feed(enc(`\x1b[${"1;".repeat(60)}`)); // 120 bytes of parameters and no final
		e.feed(enc("abc"));
		expect(e.line()).toBe("abc");
	});
});

describe("TMUX-F1 ② — a burst of identical arrows in one read is one press", () => {
	it("four Up in one chunk move ONE entry back", () => {
		const e = withHistory(["one", "two", "three"]);
		e.feed(enc(UP.repeat(4)));
		expect(e.line()).toBe("three");
	});
	it("the same four Up in separate reads are four presses (a hand)", () => {
		const e = withHistory(["one", "two", "three"]);
		e.feed(enc(UP));
		e.feed(enc(UP));
		expect(e.line()).toBe("two");
	});
	it("two in one read are still two — the threshold is three", () => {
		const e = withHistory(["one", "two", "three"]);
		e.feed(enc(UP.repeat(2)));
		expect(e.line()).toBe("two");
	});
	it("a recall by burst is REPAINTED — the render callback fires (an early return once skipped it: r3a red)", () => {
		let renders = 0;
		const e = new Editor(() => {
			renders += 1;
		});
		e.bindHistory(["one", "two", "three"], () => {});
		const before = renders;
		e.feed(enc(UP.repeat(4)));
		expect(e.line()).toBe("three");
		expect(renders, "the recalled entry never reached the screen").toBeGreaterThan(before);
	});
	it("bursts and presses interleaved: a burst up, a press up, a burst down", () => {
		const e = withHistory(["one", "two", "three"]);
		e.feed(enc(UP.repeat(5))); // one step: "three"
		e.feed(enc(UP)); // a hand: "two"
		e.feed(enc(DOWN.repeat(5))); // one step: "three" (before: past the newest, the empty draft)
		expect(e.line()).toBe("three");
	});
});
