/**
 * DC-7 — an OSC is a message from the TERMINAL, never a keystroke.
 *
 * `feed()`'s escape dispatch had branches for CSI, SS3 and Alt+Enter and
 * nothing for `ESC ]`, so an OSC fell through to the literal-text path
 * and the terminal's own answer was typed into the user's draft. This is
 * the same latent shape as the SGR-1006 mouse report documented inside
 * `feed()` itself: a sequence class with no branch, harmless only for as
 * long as nothing emits it.
 *
 * The terminator is BEL **or** ST, because Apple Terminal answers the
 * background query with BEL:
 *
 *     \e]11;rgb:ffff/ffff/ffff\a
 */

import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const BEL_REPLY = "\x1b]11;rgb:ffff/ffff/ffff\x07";
const ST_REPLY = "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\";

describe("DC-7 — the editor swallows OSC", () => {
	it("a BEL-terminated reply never reaches the draft", () => {
		const e = new Editor(() => {});
		e.feed(enc(BEL_REPLY));
		expect(e.line()).toBe("");
	});

	it("an ST-terminated reply never reaches the draft", () => {
		const e = new Editor(() => {});
		e.feed(enc(ST_REPLY));
		expect(e.line()).toBe("");
	});

	it("typing that follows a reply in the same chunk is kept", () => {
		const e = new Editor(() => {});
		e.feed(enc(`${BEL_REPLY}hi`));
		expect(e.line()).toBe("hi");
	});

	it("survives a split at every byte boundary after the introducer", () => {
		for (let cut = 2; cut < BEL_REPLY.length; cut += 1) {
			const e = new Editor(() => {});
			e.feed(enc(BEL_REPLY.slice(0, cut)));
			e.feed(enc(BEL_REPLY.slice(cut)));
			e.feed(enc("ok"));
			expect(e.line(), `cut at ${cut}`).toBe("ok");
		}
	});

	/**
	 * The ONE split that cannot be recovered, pinned deliberately.
	 *
	 * A chunk ending in a bare ESC is not held: Esc is a gesture whose
	 * immediacy is the point (it stops a run), and nothing follows a real
	 * Esc keypress, so parking it would hang the gesture forever. The
	 * product already made this trade for Alt+Enter — "the identical two
	 * bytes arriving in SEPARATE chunks are NOT combined". An OSC split
	 * between its ESC and its `]` therefore leaks, and that is the same
	 * trade rather than a new hole. Terminals write a report in one write.
	 */
	it("a chunk boundary between ESC and ] is known to leak — Esc stays immediate", () => {
		const e = new Editor(() => {});
		e.feed(enc("\x1b"));
		e.feed(enc("]11;rgb:ffff/ffff/ffff\x07"));
		expect(e.line()).not.toBe("");
	});

	it("hands the body to the report callback, once, parsed or not", () => {
		const seen: string[] = [];
		const e = new Editor(() => {});
		e.onOsc((body) => seen.push(body));
		e.feed(enc(BEL_REPLY));
		e.feed(enc(ST_REPLY));
		expect(seen).toEqual(["11;rgb:ffff/ffff/ffff", "11;rgb:1e1e/1e1e/1e1e"]);
	});

	it("a runaway OSC with no terminator cannot deafen the editor", () => {
		const e = new Editor(() => {});
		e.feed(enc(`\x1b]52;c;${"A".repeat(4000)}`));
		e.feed(enc("still here"));
		expect(e.line()).toBe("still here");
	});

	it("does not disturb a CSI arriving right after one", () => {
		const e = new Editor(() => {});
		e.feed(enc(`abc${BEL_REPLY}\x1b[D\x1b[D!`));
		expect(e.line()).toBe("a!bc");
	});
});
