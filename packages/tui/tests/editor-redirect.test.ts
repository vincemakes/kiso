/**
 * KC2 T-R1 — the redirect GESTURE at the editor's raw-byte level.
 *
 * The contract (KC2 §2): Alt+Enter arrives as ESC and CR in ONE chunk
 * and is ONE gesture; the SAME two bytes split across chunks are NOT
 * combined — today's two gestures fire instead (the bare Esc at once,
 * then the Enter). There is NO timer and NO hold on a bare Esc: its
 * immediacy is the thing the composer round is forbidden to spend.
 * Ctrl+Enter rides the two encodings terminals actually send (kitty's
 * CSI-u 13;5u, xterm's modifyOtherKeys 27;5;13~), chunk-split-safe
 * through the existing #pending CSI resume.
 *
 * The editor FORWARDS; it never interprets. What a redirect MEANS — abort
 * the run, jump the queue — is the CLI's (chat.ts). The two degeneracies
 * that ARE the editor's: an empty buffer has no correction to send (the
 * bare Esc alone), and an unwired editor still submits (a line is never
 * lost to a missing binding).
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);

const ALT_ENTER = "\x1b\x0d";
const KITTY_CTRL_ENTER = "\x1b[13;5u";
const XTERM_CTRL_ENTER = "\x1b[27;5;13~";

/** an editor with every chain wired, each recording what it saw */
function wired() {
	const editor = new Editor(() => {});
	const seen = { redirected: [] as string[], escaped: 0, lines: [] as string[] };
	editor.onRedirect((line) => seen.redirected.push(line));
	editor.onEscape(() => {
		seen.escaped += 1;
	});
	editor.onLine((line) => seen.lines.push(line));
	return { editor, seen };
}

describe("KC2 T-R1: Alt+Enter — ESC and CR in ONE chunk are ONE gesture", () => {
	it("forwards the buffer's text to the redirect chain and clears the composer", () => {
		const { editor, seen } = wired();
		editor.feed(enc("no, use ripgrep"));
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual(["no, use ripgrep"]);
		expect(editor.line()).toBe("");
	});

	it("is ONE gesture — neither the bare-Esc chain nor the submit chain also fires", () => {
		const { editor, seen } = wired();
		editor.feed(enc("switch to the other file"));
		editor.feed(enc(ALT_ENTER));
		expect(seen.escaped).toBe(0);
		expect(seen.lines).toEqual([]);
	});

	it("carries a MULTI-LINE composer whole — the KC1 buffer is flat, the redirect takes all of it", () => {
		const { editor, seen } = wired();
		editor.feed(enc("first\x0asecond")); // Ctrl+J is the everywhere newline
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual(["first\nsecond"]);
	});

	it("A2: the redirected line joins the session history like any submitted turn", () => {
		const { editor } = wired();
		editor.feed(enc("redirected text"));
		editor.feed(enc(ALT_ENTER));
		editor.feed(enc("\x1b[A")); // ↑ from the empty line — the browse
		expect(editor.line()).toBe("redirected text");
	});
});

describe("KC2 T-R1: the SPLIT pair is NOT combined — the two gestures survive", () => {
	it("ESC alone in a chunk fires the interrupt AT ONCE (no timer, no hold)", () => {
		const { editor, seen } = wired();
		editor.feed(enc("half typed"));
		editor.feed(enc("\x1b"));
		expect(seen.escaped).toBe(1); // immediate — nothing parked waiting for a CR
		expect(seen.redirected).toEqual([]);
	});

	it("the CR arriving in the NEXT chunk submits — abort then send, exactly as today", () => {
		const { editor, seen } = wired();
		editor.feed(enc("half typed"));
		editor.feed(enc("\x1b"));
		editor.feed(enc("\x0d"));
		expect(seen.escaped).toBe(1);
		expect(seen.lines).toEqual(["half typed"]);
		expect(seen.redirected).toEqual([]);
	});

	it("bare-Esc timing is untouched with an EMPTY buffer too — the interrupt is the first thing that happens", () => {
		const { editor, seen } = wired();
		editor.feed(enc("\x1b"));
		expect(seen.escaped).toBe(1);
	});
});

describe("KC2 T-R1: Ctrl+Enter, progressively encoded", () => {
	it("kitty's CSI-u (ESC [ 13;5 u) redirects", () => {
		const { editor, seen } = wired();
		editor.feed(enc("kitty correction"));
		editor.feed(enc(KITTY_CTRL_ENTER));
		expect(seen.redirected).toEqual(["kitty correction"]);
	});

	it("xterm's modifyOtherKeys (ESC [ 27;5;13 ~) redirects", () => {
		const { editor, seen } = wired();
		editor.feed(enc("xterm correction"));
		editor.feed(enc(XTERM_CTRL_ENTER));
		expect(seen.redirected).toEqual(["xterm correction"]);
	});

	it("is chunk-split-safe — the sequence torn in half still fires exactly ONCE", () => {
		const { editor, seen } = wired();
		editor.feed(enc("torn correction"));
		editor.feed(enc("\x1b[13")); // an incomplete CSI parks in #pending
		expect(seen.redirected).toEqual([]);
		editor.feed(enc(";5u")); // the resume completes it
		expect(seen.redirected).toEqual(["torn correction"]);
	});

	it("does NOT collide with Shift+Enter's 13;2 / 27;2;13 — those still insert a newline", () => {
		const { editor, seen } = wired();
		editor.feed(enc("line"));
		editor.feed(enc("\x1b[13;2u"));
		editor.feed(enc("\x1b[27;2;13~"));
		expect(seen.redirected).toEqual([]);
		expect(editor.line()).toBe("line\n\n");
	});

	it("a plain-terminal CR still just submits — the safe degrade", () => {
		const { editor, seen } = wired();
		editor.feed(enc("plain terminal"));
		editor.feed(enc("\x0d"));
		expect(seen.lines).toEqual(["plain terminal"]);
		expect(seen.redirected).toEqual([]);
	});
});

describe("KC2 T-R1: precedence — the gesture is live only in the normal composer state", () => {
	it("the approval panel OWNS its keys: esc backs the panel out, nothing redirects", () => {
		const { editor, seen } = wired();
		editor.feed(enc("pre-panel text"));
		editor.beginPanel(
			{
				flavor: "approval",
				name: "shell",
				title: "shell",
				speaker: "mode:default",
				statusText: "▸ run paused",
				args: { kind: "text", lines: ["ls"] },
				fallbackQuestion: "approve shell? (y/n) ",
			},
			() => {},
		);
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual([]);
		expect(seen.escaped).toBe(0);
	});

	it("Ctrl+Enter is inert while the panel is up", () => {
		const { editor, seen } = wired();
		editor.beginPanel(
			{
				flavor: "simple",
				name: "project trust",
				title: "/tmp/p",
				speaker: "kiso",
				statusText: "▸ project trust",
				args: { kind: "text", lines: [] },
				fallbackQuestion: "trust? (y/n) ",
			},
			() => {},
		);
		editor.feed(enc(KITTY_CTRL_ENTER));
		expect(seen.redirected).toEqual([]);
		expect(editor.panelState()).not.toBeNull();
	});

	it("the slash menu OWNS its keys: the esc closes the menu, the CR then submits the emptied line", () => {
		const { editor, seen } = wired();
		editor.feed(enc("/mo")); // the menu opens
		expect(editor.menuState()).not.toBeNull();
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual([]);
		expect(editor.menuState()).toBeNull(); // the esc closed it (CA-4: it consumed its byte)
		expect(seen.lines).toEqual([""]); // the CR submitted the now-empty buffer
	});

	it("the history browse OWNS its keys: the esc exits the browse, no redirect", () => {
		const { editor, seen } = wired();
		editor.feed(enc("remembered"));
		editor.feed(enc("\x0d"));
		editor.feed(enc("\x1b[A")); // ↑ — browsing
		expect(editor.line()).toBe("remembered");
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual([]);
		expect(editor.line()).toBe(""); // the pre-browse input returned
	});

	it("the queue-pop walk OWNS its keys: the esc pops once more, then the CR submits it — the two gestures", () => {
		const { editor, seen } = wired();
		const queue = ["a", "b"];
		editor.bindQueue(
			() => queue,
			() => queue.pop() ?? null,
		);
		editor.feed(enc("\x1b[A")); // pops "b" — the pop-mode is on
		editor.feed(enc(ALT_ENTER));
		expect(seen.redirected).toEqual([]);
		expect(seen.lines).toEqual(["a"]); // the esc's extra pop, then the CR's plain submit
		expect(queue).toEqual([]);
	});

	it("a bracketed PASTE is literal text: an ESC CR inside it never redirects", () => {
		const { editor, seen } = wired();
		editor.feed(enc(`\x1b[200~one${ALT_ENTER}two\x1b[201~`));
		expect(seen.redirected).toEqual([]);
		expect(editor.line()).toBe("one\ntwo"); // the CR is the paste's own newline
	});
});

describe("KC2 T-R1: the degeneracies", () => {
	it("an EMPTY buffer degenerates to the bare Esc — a plain abort, nothing submitted", () => {
		const { editor, seen } = wired();
		editor.feed(enc(ALT_ENTER));
		expect(seen.escaped).toBe(1);
		expect(seen.redirected).toEqual([]);
		expect(seen.lines).toEqual([]);
	});

	it("an empty buffer under Ctrl+Enter degenerates the same way", () => {
		const { editor, seen } = wired();
		editor.feed(enc(XTERM_CTRL_ENTER));
		expect(seen.escaped).toBe(1);
		expect(seen.redirected).toEqual([]);
	});

	it("an UNWIRED editor submits instead — a line is never lost to a missing binding", () => {
		const editor = new Editor(() => {});
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("no redirect chain here"));
		editor.feed(enc(ALT_ENTER));
		expect(lines).toEqual(["no redirect chain here"]);
		expect(editor.line()).toBe("");
	});
});

describe("KC2 T-R6: the manual two-gesture path behaves exactly as today", () => {
	it("esc then Enter, typed as separate keys, still aborts and then submits", () => {
		const { editor, seen } = wired();
		editor.feed(enc("manual"));
		editor.feed(enc("\x1b")); // the user's own esc
		editor.feed(enc("\x0d")); // ...and then the user's own Enter
		expect(seen.escaped).toBe(1);
		expect(seen.lines).toEqual(["manual"]);
		expect(seen.redirected).toEqual([]);
	});

	it("the esc-at-rest interrupt still fires after a submit (the W22 chain is intact)", () => {
		const { editor, seen } = wired();
		editor.feed(enc("done"));
		editor.feed(enc("\x0d"));
		editor.feed(enc("\x1b"));
		expect(seen.escaped).toBe(1);
	});
});
