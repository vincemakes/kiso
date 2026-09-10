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
	/**
	 * THE BUDGET IS A HANG DETECTOR, NOT A PERFORMANCE GATE.
	 *
	 * This case sweeps ten thousand scripted sessions, so its wall time is
	 * a property of the MACHINE and not of the product. vitest's 5000ms
	 * default was never a measured budget for it — 1.2s here, 6.5s on a
	 * two-core CI runner (2026-09-03), and the default sat between the
	 * two, so the same green suite went red on the slower machine with
	 * nothing changed.
	 *
	 * 60s is ten times the slowest machine known to run it. What this gate
	 * asserts is the INVARIANT — any gesture that destroyed two or more
	 * characters is undone exactly, and redone exactly — and that is not a
	 * claim about seconds. The cost of the wider budget is that a genuine
	 * hang here surfaces 55 seconds later than it would have; the cost of
	 * the narrow one was a gate that reported the runner's core count.
	 *
	 * Shrinking the sweep instead was considered and declined: it would
	 * trade real coverage for a number with no argument behind it.
	 */
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
	}, 60_000);
});

/**
 * DC-61 — a paste is an archive point too.
 *
 * UD-1's invariant was written around DESTRUCTIVE gestures: no single
 * gesture may discard more than one code point without a checkpoint. A
 * paste discards nothing, so it never took one — and the consequence is
 * the same loss from the other side. ctrl+z after a paste either did
 * nothing at all, or, where an older checkpoint existed, restored THAT
 * state and threw away the paste plus everything typed since it.
 *
 * The invariant is amended: a paste is an archive point too. It is the
 * one gesture that puts an arbitrary amount of text in at once, and
 * "what a single gesture did, one ctrl+z undoes" is the property the
 * human actually relies on — in both directions.
 *
 * Driven on the REAL BYTE SHAPE, `ESC[200~ … ESC[201~`, because that is
 * the only way into the paste path and because a test that called an
 * internal would not have caught this: the checkpoint is missing from
 * the byte path, not from a helper.
 */
describe("DC-61 — a paste is undoable", () => {
	it("ctrl+z after a paste restores the pre-paste buffer AND cursor; ctrl+y brings it back", () => {
		const { editor, feed } = make();
		feed("before ");
		feed("\x1b[200~pasted words\x1b[201~");
		expect(editor.line()).toBe("before pasted words");
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "before ", cursor: 7 });
		feed(REDO);
		expect(state(editor)).toEqual({ line: "before pasted words", cursor: 19 });
	});

	it("the paste does not take an OLDER checkpoint's state with it", () => {
		// the shape the owner hit: a kill leaves a checkpoint, then a paste
		// lands, and ctrl+z jumps past the paste to the kill — dropping the
		// pasted text and everything typed after it in one press.
		const { editor, feed } = make();
		feed("first draft");
		feed("\x15"); // ctrl+u — a checkpoint of "first draft"
		feed("second ");
		feed("\x1b[200~and pasted\x1b[201~");
		expect(editor.line()).toBe("second and pasted");
		feed(UNDO);
		expect(editor.line(), "one press undoes the PASTE, not everything back to the kill").toBe("second ");
	});

	it("a large paste — the capsule token — is undoable the same way", () => {
		// past #PASTE_LINES / #PASTE_CHARS the run is replaced by a capsule
		// token in the buffer; the checkpoint has to cover that path too,
		// because it is the same gesture wearing a different shape.
		const { editor, feed } = make();
		feed("head ");
		feed(`\x1b[200~${"x".repeat(950)}\x1b[201~`);
		const withCapsule = editor.line();
		expect(withCapsule.length, "the capsule is shorter than the run").toBeLessThan(950);
		expect(withCapsule.startsWith("head "), "and it sits where the paste landed").toBe(true);
		feed(UNDO);
		expect(state(editor)).toEqual({ line: "head ", cursor: 5 });
	});

	it("an EMPTY paste takes no checkpoint — nothing happened", () => {
		// the dedupe against the top already covers this, and it must: an
		// empty bracketed paste is the image case, and on a terminal with no
		// image it changes nothing at all. A checkpoint there would make
		// ctrl+z a no-op press that the human has to repeat.
		const { editor, feed } = make();
		feed("typed");
		feed("\x15"); // a real checkpoint of "typed"
		feed("\x1b[200~\x1b[201~"); // empty paste, no clipboard image
		feed(UNDO);
		expect(editor.line(), "ctrl+z reaches the kill, not a phantom paste").toBe("typed");
	});
});
