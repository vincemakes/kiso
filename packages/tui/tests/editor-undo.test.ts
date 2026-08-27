/**
 * UD-1 — minimal draft undo (the ratified mini-spec).
 *
 * The invariant: no single gesture may discard more than one code
 * point without first pushing a checkpoint, and ctrl+z restores the
 * most recent checkpoint exactly — text AND cursor. ctrl+y is the
 * mirror; undo never discards anything (what it replaces is always on
 * the redo stack). Checkpoints are frozen snapshots BESIDE the one
 * mutable buffer — the KC1 flat-buffer discipline holds.
 *
 * Sites: the kills (^U/^K/^W), the menu-esc clear (v3 §04), each
 * queue-pop replacement (W22), the @-apply splice. Stacks clear on
 * submit and clearLine (a submitted turn is in the log and the ↑
 * history — not a loss). Caps: 64 entries / 2 MiB code points.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

beforeEach(() => {
	// the property corpus must never engage the horizontal scroll — the
	// windowed legacy view would blur the exact-restore oracle
	Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const UNDO = "\x1a"; // ctrl+z
const UNDO2 = "\x1f"; // ctrl+_ (the readline alias)
const REDO = "\x19"; // ctrl+y
const UP = "\x1b[A";

function make() {
	const editor = new Editor(() => {});
	const lines: string[] = [];
	editor.onLine((l) => lines.push(l));
	return { editor, lines, feed: (s: string) => editor.feed(enc(s)) };
}

const state = (e: Editor) => {
	const st = e.dockState();
	return { line: st.line, cursor: st.cursor };
};

describe("UD-1 — the kills are undoable", () => {
	it("ctrl+u, then ctrl+z restores text and cursor", () => {
		const { editor, feed } = make();
		feed("a long instruction");
		feed("\x15");
		expect(editor.line()).toBe("");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "a long instruction", cursor: 18 });
	});

	it("ctrl+k mid-line, then ctrl+z", () => {
		const { editor, feed } = make();
		feed("keep THIS TAIL");
		feed("\x1b[D".repeat(9)); // cursor after "keep "
		feed("\x0b");
		expect(editor.line()).toBe("keep ");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "keep THIS TAIL", cursor: 5 });
	});

	it("ctrl+w, then ctrl+z", () => {
		const { editor, feed } = make();
		feed("two words");
		feed("\x17");
		expect(editor.line()).toBe("two ");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "two words", cursor: 9 });
	});

	it("ctrl+_ is the undo alias", () => {
		const { editor, feed } = make();
		feed("aliased");
		feed("\x15");
		feed(UNDO2);
		expect(editor.line()).toBe("aliased");
	});
});

describe("UD-1 — the menu-esc clear is undoable", () => {
	it("esc clears a /-line with the menu open; ctrl+z brings it back", () => {
		const { editor, feed } = make();
		feed("/clear");
		feed("\x1b"); // v3 §04: esc closes the menu AND clears the buffer
		expect(editor.line()).toBe("");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "/clear", cursor: 6 });
	});
});

describe("UD-1 — the queue-pop walk", () => {
	it("the pure walk is undoable: ctrl+z recovers the walked-past draft", () => {
		const { editor, feed } = make();
		const queued = ["q-one", "q-two", "q-three"];
		editor.bindQueue(
			() => queued,
			() => queued.pop() ?? null,
		);
		feed(UP); // pops "q-three"
		expect(editor.line()).toBe("q-three");
		feed(UP); // the walk replaces the line — checkpointed
		expect(editor.line()).toBe("q-two");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "q-three", cursor: 7 });
	});

	it("a mid-walk edit ends the walk (W22 stands) and stays undo-safe", () => {
		const { editor, feed } = make();
		const queued = ["q-one", "q-two", "q-three"];
		editor.bindQueue(
			() => queued,
			() => queued.pop() ?? null,
		);
		feed(UP);
		feed(" EDITED"); // typing exits the pop-mode — the A2 feel
		feed(UP); // inert: non-empty line, no pop-mode — W22's own defense
		expect(editor.line()).toBe("q-three EDITED");
		feed("\x15");
		feed(UNDO);
		expect(editor.line()).toBe("q-three EDITED");
	});
});

describe("UD-1 — undo never discards (the redo mirror)", () => {
	it("undo, redo round-trips exactly", () => {
		const { editor, feed } = make();
		feed("draft");
		feed("\x15");
		feed(UNDO);
		expect(editor.line()).toBe("draft");
		feed(REDO);
		expect(state(editor)).toEqual({ line: "", cursor: 0 });
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "draft", cursor: 5 });
	});

	it("text typed after the kill rides the redo stack — nothing is lost", () => {
		const { editor, feed } = make();
		feed("first");
		feed("\x15");
		feed("second");
		feed(UNDO); // back to "first" — "second" must be recoverable
		expect(editor.line()).toBe("first");
		feed(REDO);
		expect(state(editor)).toEqual({ line: "second", cursor: 6 });
	});

	it("a new destructive gesture clears the redo stack", () => {
		const { editor, feed } = make();
		feed("one");
		feed("\x15");
		feed(UNDO); // "one" back; redo holds ""
		feed("\x15"); // a NEW kill — redo must clear
		feed(REDO);
		expect(editor.line()).toBe(""); // redo was empty: no-op after the kill
		feed(UNDO);
		expect(editor.line()).toBe("one");
	});
});

describe("UD-1 — boundaries", () => {
	it("empty stacks: ctrl+z / ctrl+y are silent no-ops", () => {
		const { editor, feed } = make();
		feed(UNDO);
		feed(REDO);
		expect(state(editor)).toEqual({ line: "", cursor: 0 });
	});

	it("submit clears both stacks (a sent turn is not a loss)", () => {
		const { editor, feed, lines } = make();
		feed("send me");
		feed("\x15");
		feed(UNDO);
		feed("\x0d"); // Enter — submits "send me"
		expect(lines).toEqual(["send me"]);
		feed(UNDO);
		expect(editor.line()).toBe(""); // nothing to undo across a submit
	});

	it("clearLine clears both stacks", () => {
		const { editor, feed } = make();
		feed("draft");
		feed("\x15");
		editor.clearLine();
		feed(UNDO);
		expect(editor.line()).toBe("");
	});

	it("the entry cap evicts oldest: 70 checkpoints keep the last 64", () => {
		const { editor, feed } = make();
		for (let i = 1; i <= 70; i += 1) {
			feed(`w${i}`);
			feed("\x15");
		}
		for (let i = 0; i < 64; i += 1) feed(UNDO);
		expect(editor.line()).toBe("w7"); // w1..w6 evicted
		feed(UNDO); // the 65th — empty stack, no-op
		expect(editor.line()).toBe("w7");
	});
});

describe("UD-1 — the invariant, property-tested (seed 20260827)", () => {
	it("after any gesture that shrank the buffer by ≥2, one undo restores it exactly; redo returns", () => {
		let seed = 20260827;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const LETTERS = "abc \u5b57\u5bbdx";
		for (let script = 0; script < 10_000; script += 1) {
			const { editor, feed } = make();
			const queued: string[] = ["q-one", "q-two", "q-three"];
			editor.bindQueue(
				() => queued,
				() => queued.pop() ?? null,
			);
			const ops = 4 + Math.floor(rnd() * 20);
			for (let k = 0; k < ops; k += 1) {
				const before = state(editor);
				const r = rnd();
				const gesture = r < 0.45 ? LETTERS[Math.floor(rnd() * LETTERS.length)]! : r < 0.55 ? "\x7f" : r < 0.65 ? "\x15" : r < 0.72 ? "\x0b" : r < 0.79 ? "\x17" : r < 0.86 ? UP : r < 0.93 ? UNDO : REDO;
				feed(gesture);
				const after = state(editor);
				// the legacy cursor is a DISPLAY column (wide cells count 2),
				// so the sanity bound is 2× the code-point count
				expect(after.cursor).toBeGreaterThanOrEqual(0);
				expect(after.cursor).toBeLessThanOrEqual(2 * [...editor.line()].length);
				const shrank = [...before.line].length - [...after.line].length;
				const destructive = gesture === "\x15" || gesture === "\x0b" || gesture === "\x17" || gesture === UP;
				if (destructive && shrank >= 2) {
					feed(UNDO);
					expect(state(editor)).toEqual(before);
					feed(REDO);
					expect(state(editor)).toEqual(after);
				}
			}
		}
	});
});
