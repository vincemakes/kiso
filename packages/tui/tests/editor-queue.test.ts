/**
 * W22 — the editor's pop routing: ↑ with a non-empty queue pops the
 * LAST queued message into the buffer and enters the pop-mode (the
 * walk — repeated ↑ pops older ones, each replacing the line); esc in
 * the pop-mode pops once more and ENDS the mode, so the next esc at
 * rest rides the escapeCbs (the interrupt survives the walk); a
 * mid-edit ↑ never pops (the A2 non-destructive feel); an empty queue
 * pops nothing. The chips themselves are the compositor's bindQueue —
 * the tui-v2c e2e pins them; this gate pins the raw-byte routing.
 */
import { describe, expect, it } from "vitest";
import { Editor } from "../src/editor.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** The editor reads the queue state + pop through the bind — the CLI
 *  supplies both (chat.ts); here the fake mirrors the CLI's semantics
 *  (pop takes the LAST slot). */
function makeEditor() {
	const editor = new Editor(() => {});
	const queue: string[] = [];
	let popCalls = 0;
	editor.bindQueue(
		() => queue,
		() => {
			popCalls += 1;
			return queue.length > 0 ? (queue.pop() ?? null) : null;
		},
	);
	return { editor, queue, popCalls };
}

describe("W22: the queue pop keys (the editor's raw-byte routing)", () => {
	it("↑ pops the last queued message into the buffer", () => {
		const { editor, queue } = makeEditor();
		queue.push("one", "two");
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("two");
		expect(queue).toEqual(["one"]);
	});

	it("repeated ↑ walks older queued messages", () => {
		const { editor, queue } = makeEditor();
		queue.push("one", "two", "three");
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("three");
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("two");
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("one");
		expect(queue).toEqual([]);
	});

	it("esc pops once + cancels the pop-mode — the next esc fires the escapeCbs (the interrupt survives)", () => {
		const { editor, queue } = makeEditor();
		queue.push("one", "two");
		let escaped = 0;
		editor.onEscape(() => {
			escaped += 1;
		});
		editor.feed(enc("\x1b[A")); // "two" into the buffer — the pop-mode on
		editor.feed(enc("\x1b")); // one more pop ("one") + the mode ends
		expect(editor.line()).toBe("one");
		expect(queue).toEqual([]);
		editor.feed(enc("\x1b")); // at rest — the escapeCbs chain
		expect(escaped).toBe(1);
	});

	it("a mid-edit ↑ never pops (the A2 non-destructive feel)", () => {
		const { editor, queue } = makeEditor();
		queue.push("one");
		editor.feed(enc("half"));
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("half");
		expect(queue).toEqual(["one"]);
	});

	it("↑ with an empty queue does nothing", () => {
		const { editor, queue } = makeEditor();
		editor.feed(enc("\x1b[A"));
		expect(editor.line()).toBe("");
		expect(queue).toEqual([]);
	});
});
