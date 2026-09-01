/**
 * DC-35 — ctrl+r must not print the same expansion again and again.
 *
 * The owner pressed ctrl+r a few times on a turn with ONE folded
 * stretch and got the identical block appended three times over, each
 * headed `expanded · listed 1 directory · 0 turns back` and each
 * closing with `ctrl+r opens the one before it` — a footer naming
 * something that does not exist.
 *
 * The ring itself is not wrong: `#opened` walks newest-back and
 * restarts the cycle when every entry has been seen (R4/C1, so the
 * walk is immune to the ring growing underneath it). With a ring of
 * ONE the restart is immediate, and the key re-prints its only entry
 * for as long as it is held.
 *
 * The rule these gates state: an expansion earns its rows by showing
 * something the screen does not already end with. Re-opening after
 * other content has arrived is still useful — that is how a reader
 * gets back an expansion that scrolled away — so the bar is the
 * BOTTOM of the transcript, not "ever shown".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function turnWithOneFold(): Body {
	const body = new Body({ active: () => true, height: () => 26, width: () => 90, editCol: () => 1, write: () => {} });
	body.enter();
	body.userLine("what is in this project");
	body.thinkingAppend("Let me look.");
	body.thinkingEnd();
	body.toolStart("list_dir", "a", { path: "." });
	body.toolRunning("a");
	body.toolResult("a", { content: "x\n".repeat(81), isError: false });
	body.toolStart("search_text", "b", { pattern: "foo" });
	body.toolRunning("b");
	body.toolResult("b", { content: "search_text failed: EPERM", isError: true });
	body.textAppend("Here is what I found.");
	body.textEnd();
	body.endTurn(0);
	vi.advanceTimersByTime(40);
	return body;
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("DC-35 — the expansion key on a ring of one", () => {
	it("the second press does not append the first press again", () => {
		const body = turnWithOneFold();
		const first = body.expandNext();
		expect(first.kind, "the first press opened nothing").toBe("appended");
		vi.advanceTimersByTime(40);
		const second = body.expandNext();
		expect(second.kind, "the same expansion was appended a second time").not.toBe("appended");
		// and it says WHICH kind of nothing: the reader had something to
		// open and was already looking at it. "[nothing to expand]" would
		// be a false sentence here.
		expect(second.kind === "none" ? second.why : undefined).toBe("already-last");
	});

	it("a turn with NOTHING folded still reports the other kind of nothing", () => {
		const body = new Body({ active: () => true, height: () => 26, width: () => 90, editCol: () => 1, write: () => {} });
		body.enter();
		body.userLine("hello");
		body.textAppend("Hi.");
		body.textEnd();
		body.endTurn(0);
		vi.advanceTimersByTime(40);
		const r = body.expandNext();
		expect(r.kind).toBe("none");
		expect(r.kind === "none" ? r.why : "set").toBeUndefined();
	});

	it("holding the key does not fill the screen with copies", () => {
		const body = turnWithOneFold();
		const heads: string[] = [];
		for (let n = 0; n < 5; n += 1) {
			const r = body.expandNext();
			if (r.kind === "appended") heads.push(plain(r.lines[0] ?? ""));
			vi.advanceTimersByTime(40);
		}
		expect(heads.length, `five presses appended ${heads.length} blocks: ${JSON.stringify(heads)}`).toBe(1);
	});

	it("re-opening IS allowed once other content has arrived — the bar is the bottom, not 'ever shown'", () => {
		const body = turnWithOneFold();
		expect(body.expandNext().kind).toBe("appended");
		vi.advanceTimersByTime(40);
		// a new turn pushes the expansion up; the reader may want it back
		body.userLine("and now?");
		body.thinkingAppend("Thinking again.");
		body.thinkingEnd();
		body.textAppend("Done.");
		body.textEnd();
		body.endTurn(0);
		vi.advanceTimersByTime(40);
		expect(body.expandNext().kind, "the expansion became unreachable").toBe("appended");
	});
});
