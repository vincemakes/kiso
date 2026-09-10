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

/**
 * DC-62 — DC-58's siblings, asked of every function beside it.
 *
 * DC-58 guarded three branches. The rule it stated is general, so the
 * question is whether the rest of the chain obeys it: the kills, the
 * backspace, the undo pair, the exit callbacks, the home/end moves. Each
 * of these is CLAIMED, so the "unclaimed control bytes are discarded"
 * fallback never sees them, and `#insert` only collects what reaches it.
 *
 * Driven on the real byte shape. If these pass on the current source, the
 * finding is not real and the per-branch guards are enough; if they fail,
 * the fix is one rule at the top of the chain rather than nine more
 * guards, and DC-58's three retire into it.
 */
describe("DC-62 — the rest of the chain, inside a paste", () => {
	it("a pasted backspace does not eat the text the human typed before pasting", () => {
		const { e } = wired();
		e.feed(enc("KEEP"));
		e.feed(enc(paste("\x08\x08 tail")));
		expect(e.line(), "the pre-paste text survives; the paste lands without the control bytes").toBe("KEEP tail");
	});

	it("a pasted kill-to-start does not empty the buffer", () => {
		const { e } = wired();
		e.feed(enc("KEEP"));
		e.feed(enc(paste("x\x15y")));
		expect(e.line()).toBe("KEEPxy");
	});

	it("a pasted kill-to-end and kill-word leave the line alone", () => {
		const { e } = wired();
		e.feed(enc("KEEP ME"));
		e.feed(enc(paste("\x0b\x17z")));
		expect(e.line()).toBe("KEEP MEz");
	});

	it("a pasted 0x03 / 0x04 fires no exit callback", () => {
		const fired: string[] = [];
		const e = new Editor(() => {});
		e.onSigint(() => fired.push("sigint"));
		e.onEot(() => fired.push("eot"));
		e.feed(enc(paste("a\x03b\x04c")));
		expect(fired, "a paste cannot end the session").toEqual([]);
		expect(e.line()).toBe("abc");
	});

	it("a pasted undo/redo does not rewind the buffer", () => {
		const { e } = wired();
		e.feed(enc("first"));
		e.feed(enc("\x15")); // a real checkpoint
		e.feed(enc("second"));
		e.feed(enc(paste("\x1a\x1a tail")));
		expect(e.line(), "the paste is text, not two presses of ctrl+z").toBe("second tail");
	});

	it("a pasted ESC[A does not walk the history", () => {
		const e = new Editor(() => {});
		e.bindHistory(["an older turn"], () => {});
		e.feed(enc("typed"));
		e.feed(enc(paste("\x1b[Amore")));
		expect(e.line(), "the history stays where it is").toBe("typedmore");
	});

	it("ESC[201~ still ENDS the paste — the parser must keep seeing it", () => {
		// the one CSI that must survive any rule applied to the chain
		const { e } = wired();
		e.feed(enc(paste("body")));
		e.feed(enc("!"));
		expect(e.line(), "the ! is ordinary input after the paste closed").toBe("body!");
	});
});

/**
 * DC-62b — the ESC-led siblings, the ones DC-62 consciously let through.
 *
 * DC-62's rule passes ESC so the parser can still see `ESC[201~` and end
 * the paste. That is necessary and it is also a hole: every OTHER
 * ESC-led shape rides through with it. The question DC-58 was asked and
 * DC-62 was asked is now asked of the escape chain, which is the third
 * time the same question has found something.
 *
 * The shapes that matter, all of them ordinary in captured terminal
 * output rather than exotic:
 *   - an OSC title string, which is what a shell's PROMPT_COMMAND leaves
 *     in any captured log, reaching the ground-probe reply handler;
 *   - `ESC[3~`, forward delete;
 *   - a bare or non-CSI ESC (`ESC(B`, `ESC=`), which falls to the
 *     escape callbacks and interrupts a running turn;
 *   - `ESC ESC`, the double-escape redirect.
 */
describe("DC-62b — ESC-led shapes inside a paste", () => {
	it("a pasted OSC title string does not reach the terminal-report handler", () => {
		const reports: string[] = [];
		const e = new Editor(() => {});
		e.onOsc((body) => reports.push(body));
		e.feed(enc(paste("before \x1b]0;my shell title\x07 after")));
		expect(reports, "a title in a pasted log is not a terminal report").toEqual([]);
		expect(e.line()).toBe("before  after");
	});

	it("a pasted ESC[3~ does not forward-delete the text after the cursor", () => {
		const e = new Editor(() => {});
		e.feed(enc("KEEPTAIL"));
		e.feed(enc("\x1b[D".repeat(4))); // cursor before TAIL
		e.feed(enc(paste("\x1b[3~x")));
		expect(e.line(), "the tail survives; the paste lands").toBe("KEEPxTAIL");
	});

	it("a pasted non-CSI escape does not fire the escape callbacks", () => {
		const fired: string[] = [];
		const e = new Editor(() => {});
		e.onEscape(() => fired.push("escape"));
		e.feed(enc(paste("a\x1b(Bb")));
		expect(fired, "a paste cannot stop a running turn").toEqual([]);
		// the ESC is nothing and what follows is CONTENT. An nF escape could
		// be consumed whole — the grammar is deterministic — but beside CSI
		// and OSC it is rare in pasted logs, and `(B` left visible is
		// recoverable where text eaten by a misread is not. The residual is
		// exactly this line: the intermediates and the final stay as text.
		expect(e.line()).toBe("a(Bb");
	});

	it("a pasted double escape does not fire the escape callbacks either", () => {
		const fired: string[] = [];
		const e = new Editor(() => {});
		e.onEscape(() => fired.push("escape"));
		e.feed(enc(paste("a\x1b\x1bb")));
		expect(fired).toEqual([]);
		expect(e.line()).toBe("ab");
	});

	it("ESC[201~ still ends the paste when it arrives in a SEPARATE feed", () => {
		// the chunk boundary: a CSI split across two feeds must park as
		// incomplete, not be dropped half-way by any rule applied here
		const e = new Editor(() => {});
		e.feed(enc("\x1b[200~body"));
		e.feed(enc("\x1b[20"));
		e.feed(enc("1~!"));
		expect(e.line(), "the paste closed and the ! is ordinary input").toBe("body!");
	});
});

/**
 * DC-62c — a lone trailing ESC inside a paste is HELD, not consumed.
 *
 * Measured, not reasoned: with the paste-end marker split immediately
 * after its ESC byte — the chunk ends on the bare ESC, the next begins
 * `[201~` — the marker was missed and `#pasting` never cleared. The
 * composer then went DEAF: every later keystroke was collected and
 * nothing reached the screen until some intact `ESC[201~` arrived and
 * flushed the lot. That is the TMUX-F1 shape, and it predates DC-62b
 * (byte-identical on d874af7's editor).
 *
 * The hold is free HERE and nowhere else. CA-4 says a bare Esc fires at
 * once rather than waiting for a possible CSI, because its immediacy is
 * what a hold would spend — esc interrupts a run. Inside a paste, after
 * DC-62b, a bare ESC already does NOTHING, so there is no promptness to
 * spend. Outside a paste CA-4 is untouched, and the third case pins that
 * so nobody widens this later.
 */
describe("DC-62c — the paste end split on its own ESC", () => {
	it("the marker is recognised across the split, and the composer is live again", () => {
		const e = new Editor(() => {});
		e.feed(enc("\x1b[200~body"));
		e.feed(enc("\x1b")); // the chunk ends on the bare ESC
		e.feed(enc("[201~after"));
		expect(e.line(), "the paste closed and the rest is ordinary input").toBe("bodyafter");
		e.feed(enc("X"));
		expect(e.line(), "and the composer is not deaf").toBe("bodyafterX");
	});

	it("a held ESC followed by an ordinary byte skips one and collects the byte", () => {
		const fired: string[] = [];
		const e = new Editor(() => {});
		e.onEscape(() => fired.push("escape"));
		e.feed(enc("\x1b[200~body"));
		e.feed(enc("\x1b"));
		e.feed(enc("x"));
		e.feed(enc("\x1b[201~"));
		expect(fired, "the held ESC is nothing, not a gesture").toEqual([]);
		expect(e.line()).toBe("bodyx");
	});

	it("OUTSIDE a paste a lone trailing ESC still fires at once — CA-4 unchanged", () => {
		const fired: string[] = [];
		const e = new Editor(() => {});
		e.onEscape(() => fired.push("escape"));
		e.feed(enc("\x1b"));
		expect(fired, "esc interrupts a run; its immediacy is the point").toEqual(["escape"]);
	});
});
