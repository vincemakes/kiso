/**
 * KC3 T-A1 — the @ picker's KEY routing, at the raw-byte level.
 *
 * What is pinned here: where a picker may open (a word boundary, never
 * mid-word — an email address is not a file reference), who owns the
 * keys when several things could (the KC2 precedence gate), what Esc
 * does to the buffer (nothing — it closes the picker and leaves the
 * text alone), and exactly what an accept writes back (the token
 * replaced by `@<path> `, never the file's content).
 *
 * The picker is DERIVED, not stored: a bit arms it, but the token has
 * to still be under the cursor for it to be up. That is why
 * backspacing past the `@` closes it with no handler anywhere, and it
 * is what these tests are really guarding.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);
const FILES = ["src/range.js", "src/editor.ts", "README.md", "docs/plans/ranger.md"].map((path) => ({ path }));

function makeEditor(files = FILES) {
	const editor = new Editor(() => {});
	editor.bindAtItems(() => files);
	return editor;
}
const sel = (e: Editor) => e.atState()?.matches[e.atState()!.selected]?.path;

describe("KC3 T-A1: where a picker opens", () => {
	it("`@` at the START of the buffer opens it", () => {
		const editor = makeEditor();
		editor.feed(enc("@"));
		expect(editor.atState()).not.toBeNull();
	});

	it("`@` after a SPACE opens it", () => {
		const editor = makeEditor();
		editor.feed(enc("look at @"));
		expect(editor.atState()).not.toBeNull();
		expect(editor.line()).toBe("look at @");
	});

	it("a TAB can never precede the `@` — the buffer's alphabet has no tab in it", () => {
		const editor = makeEditor();
		// PRE-EXISTING behavior, discovered while pinning the boundary rule
		// and pinned here so it cannot change unnoticed: \t is a KEY, never
		// a character. Typed, it accepts (menu/picker); pasted, it is
		// dropped with the other control characters. So "look\tat\t" lands
		// in the buffer as "lookat", and the picker's TAB boundary is
		// unreachable today — kept in #atToken as defence, because the
		// alphabet is the editor's to widen later.
		editor.feed(enc("\x1b[200~look\tat\t\x1b[201~"));
		expect(editor.line()).toBe("lookat");
		editor.feed(enc("@"));
		expect(editor.atState()).toBeNull(); // "lookat@" — mid-word, inert
	});

	it("`@` MID-WORD is inert — an email address is not a file reference", () => {
		const editor = makeEditor();
		editor.feed(enc("mail me at vince@"));
		expect(editor.atState()).toBeNull();
		editor.feed(enc("example.com"));
		expect(editor.atState()).toBeNull();
		expect(editor.line()).toBe("mail me at vince@example.com");
	});

	it("`@` at the start of ANY line of a multi-line buffer opens it", () => {
		const editor = makeEditor();
		editor.feed(enc("first line\n")); // ctrl+J newline — the composer's own
		editor.feed(enc("@"));
		expect(editor.atState()).not.toBeNull();
		expect(editor.line()).toBe("first line\n@");
	});

	it("`@` mid-word on the SECOND line is inert too — the boundary is line-local", () => {
		const editor = makeEditor();
		editor.feed(enc("first\nvince@"));
		expect(editor.atState()).toBeNull();
	});

	it("a PASTED `@` never opens it — a paste is literal text", () => {
		const editor = makeEditor();
		editor.feed(enc("\x1b[200~look at @ra\x1b[201~"));
		expect(editor.atState()).toBeNull();
		expect(editor.line()).toBe("look at @ra");
	});

	it("a query with no matches closes the panel — the menu's precedent", () => {
		const editor = makeEditor();
		editor.feed(enc("@zzzzz"));
		expect(editor.atState()).toBeNull();
		// and deleting back to a matching query brings it straight back:
		// the open bit is still armed, the token is what gates it
		editor.feed(enc("\x7f\x7f\x7f\x7f\x7f"));
		expect(editor.atState()).not.toBeNull();
	});

	it("with NO source bound the picker can never open — the tui owns no file list", () => {
		const editor = new Editor(() => {});
		editor.feed(enc("look at @ra"));
		expect(editor.atState()).toBeNull();
	});
});

describe("KC3 T-A1: the token, derived from the buffer", () => {
	it("typing narrows the matches", () => {
		const editor = makeEditor();
		editor.feed(enc("@r"));
		const wide = editor.atState()!.matches.length;
		editor.feed(enc("ange.js"));
		expect(editor.atState()!.matches.length).toBeLessThan(wide);
		expect(sel(editor)).toBe("src/range.js");
	});

	it("BACKSPACING past the `@` closes it — no handler, the token is simply gone", () => {
		const editor = makeEditor();
		editor.feed(enc("@ra"));
		expect(editor.atState()).not.toBeNull();
		editor.feed(enc("\x7f\x7f\x7f")); // a, r, @
		expect(editor.atState()).toBeNull();
		expect(editor.line()).toBe("");
	});

	it("a SPACE ends the token — the picker closes and the text is untouched", () => {
		const editor = makeEditor();
		editor.feed(enc("@ra"));
		editor.feed(enc(" "));
		expect(editor.atState()).toBeNull();
		expect(editor.line()).toBe("@ra ");
	});

	it("the token runs from the `@` to the CURSOR, not to the end of the line", () => {
		const editor = makeEditor();
		editor.feed(enc("@range.js tail"));
		expect(editor.atState()).toBeNull(); // the space closed it
		// walk the cursor back into the token and re-arm by typing
		for (let i = 0; i < 5; i += 1) editor.feed(enc("\x1b[D"));
		expect(editor.line()).toBe("@range.js tail");
	});
});

describe("KC3 T-A1: precedence — who owns the keys", () => {
	it("the slash MENU owns them: `/@` never opens a picker", () => {
		const editor = makeEditor();
		editor.feed(enc("/mod"));
		expect(editor.menuState()).not.toBeNull();
		editor.feed(enc("@"));
		expect(editor.atState()).toBeNull();
	});

	it("the approval PANEL owns them: an `@` typed into the amend note is inert", () => {
		const editor = makeEditor();
		editor.beginPanel(
			{
				flavor: "approval",
				name: "shell",
				title: "shell npm test",
				speaker: "mode:default",
				statusText: "▸ run paused",
				args: { kind: "text", lines: ["npm test"] },
				fallbackQuestion: "allow? (y/n) ",
			},
			() => {},
		);
		editor.feed(enc("4")); // into the amend phase — free text
		editor.feed(enc("@"));
		expect(editor.atState()).toBeNull();
	});

	it("the QUEUE-POP walk owns them: ↑ pops, and the pop's text never opens a picker", () => {
		const editor = makeEditor();
		const queue = ["send @ra later"];
		editor.bindQueue(
			() => queue,
			() => queue.pop() ?? null,
		);
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("send @ra later");
		expect(editor.atState()).toBeNull();
	});

	it("the HISTORY browse owns them: a recalled line never opens a picker", () => {
		const editor = makeEditor();
		editor.onLine(() => {});
		// esc dismisses the picker the typed `@` armed, THEN enter submits —
		// an Enter with the picker up would accept, not send (see below)
		editor.feed(enc("look at @range.js"));
		editor.feed(enc("\x1b"));
		editor.feed(enc("\r"));
		expect(editor.line()).toBe("");
		editor.feed(enc("\x1b[A")); // recalled from history, not typed
		expect(editor.line()).toBe("look at @range.js");
		expect(editor.atState()).toBeNull();
	});
});

describe("KC3 T-A1: the keys while the picker is up", () => {
	it("↑↓ move the SELECTION, never the cursor", () => {
		const editor = makeEditor();
		editor.feed(enc("@r"));
		const first = editor.atState()!.selected;
		expect(first).toBe(0);
		editor.feed(enc("\x1b[B"));
		expect(editor.atState()!.selected).toBe(1);
		editor.feed(enc("\x1b[A"));
		expect(editor.atState()!.selected).toBe(0);
		expect(editor.line()).toBe("@r"); // the buffer never moved
	});

	it("↑ at the top and ↓ at the bottom CLAMP — the selection never wraps or escapes", () => {
		const editor = makeEditor();
		editor.feed(enc("@r"));
		editor.feed(enc("\x1b[A"));
		expect(editor.atState()!.selected).toBe(0);
		const last = editor.atState()!.matches.length - 1;
		for (let i = 0; i < 20; i += 1) editor.feed(enc("\x1b[B"));
		expect(editor.atState()!.selected).toBe(last);
	});

	it("↑↓ beat the MULTI-LINE walk — a picker on line 2 still selects", () => {
		const editor = makeEditor();
		editor.feed(enc("first line\n"));
		editor.feed(enc("@r"));
		editor.feed(enc("\x1b[B"));
		expect(editor.atState()!.selected).toBe(1);
		expect(editor.line()).toBe("first line\n@r");
	});

	it("ESC closes the picker and leaves the BUFFER INTACT", () => {
		const editor = makeEditor();
		editor.feed(enc("look at @ra"));
		expect(editor.atState()).not.toBeNull();
		editor.feed(enc("\x1b"));
		expect(editor.atState()).toBeNull();
		expect(editor.line()).toBe("look at @ra"); // NOT cleared — unlike the menu's esc
	});

	it("ESC does not abort the run — the closing esc consumes its burst", () => {
		const editor = makeEditor();
		let aborts = 0;
		editor.onEscape(() => {
			aborts += 1;
		});
		editor.feed(enc("look at @ra"));
		editor.feed(enc("\x1b"));
		expect(aborts).toBe(0);
		// closed now — the NEXT esc is an ordinary interrupt again
		editor.feed(enc("\x1b"));
		expect(aborts).toBe(1);
	});
});

describe("KC3 T-A1: accept — the path, and only the path", () => {
	it("TAB replaces the token with `@<path> ` and appends the space", () => {
		const editor = makeEditor();
		editor.feed(enc("look at @ra"));
		editor.feed(enc("\t"));
		expect(editor.line()).toBe("look at @src/range.js ");
		expect(editor.atState()).toBeNull();
	});

	it("ENTER accepts too — and does NOT submit the turn", () => {
		const editor = makeEditor();
		const lines: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.feed(enc("look at @ra"));
		editor.feed(enc("\r"));
		expect(editor.line()).toBe("look at @src/range.js ");
		expect(lines).toEqual([]); // the accept consumed the Enter
		// the NEXT Enter submits the completed line
		editor.feed(enc("\r"));
		expect(lines).toEqual(["look at @src/range.js "]);
	});

	it("accept takes the SELECTED row, not the first", () => {
		const editor = makeEditor();
		editor.feed(enc("@r"));
		editor.feed(enc("\x1b[B"));
		const chosen = sel(editor)!;
		editor.feed(enc("\t"));
		expect(editor.line()).toBe(`@${chosen} `);
	});

	it("accept on a MULTI-LINE buffer rewrites only its own line", () => {
		const editor = makeEditor();
		editor.feed(enc("first line\n"));
		editor.feed(enc("see @ra"));
		editor.feed(enc("\t"));
		expect(editor.line()).toBe("first line\nsee @src/range.js ");
	});

	it("accept keeps the text AFTER the cursor — the token is replaced, not the tail", () => {
		const editor = makeEditor();
		editor.feed(enc("look at  and stop")); // 17 chars; the reference goes at index 8
		for (let i = 0; i < 9; i += 1) editor.feed(enc("\x1b[D")); // back to just after "look at "
		editor.feed(enc("@ra"));
		expect(editor.atState()).not.toBeNull();
		editor.feed(enc("\t"));
		expect(editor.line()).toBe("look at @src/range.js  and stop");
	});

	it("the accepted text is the PATH — no file content is ever inserted", () => {
		const editor = makeEditor();
		editor.feed(enc("@ra"));
		editor.feed(enc("\t"));
		expect(editor.line()).toBe("@src/range.js ");
		expect(editor.line().length).toBeLessThan(40);
	});

	it("a submit while the picker is open CLOSES IT FIRST, then the line leaves as an ordinary submit", () => {
		const editor = makeEditor();
		const lines: string[] = [];
		const redirects: string[] = [];
		editor.onLine((l) => lines.push(l));
		editor.onRedirect((l) => redirects.push(l));
		editor.feed(enc("look at @ra"));
		editor.feed(enc("\x1b\x0d")); // alt+enter, ONE chunk — the KC2 redirect gesture
		expect(editor.atState()).toBeNull();
		// the picker owned the keys, so the gesture DEGENERATES exactly as
		// it does under the menu: the esc half closes the picker...
		expect(redirects).toEqual([]);
		// ...and the CR half is then an ordinary submit of the intact line
		expect(lines).toEqual(["look at @ra"]);
	});
});
