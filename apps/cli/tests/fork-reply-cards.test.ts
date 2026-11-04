/**
 * /fork's rows (replyCards): each finished run, newest first, by the person's message it answered (without a fork
 * note) and when it ended; the opened row shows the reply's first line (inline code read as plain text) under it; a
 * run that did not finish is not offered; the card's id is the seq of the run's terminal, where SessionStore.fork
 * cuts.
 */

import { describe, expect, it } from "vitest";
import { replyCards } from "../src/dispatch.js";

const at = (ts: number, event: Record<string, unknown>) => ({ runId: "r", ts, event }) as never;

describe("replyCards", () => {
	it("lists finished runs newest first, by the message each answered, with the reply's first line under it", () => {
		const cards = replyCards([
			at(1, { seq: 0, type: "user_input", content: "what does calc.js export?" }),
			at(2, { seq: 1, type: "text_delta", text: "\nIt exports `add` and `sub`.\nMore." }),
			at(3, { seq: 2, type: "terminal", outcome: { kind: "completed" } }),
			at(4, { seq: 3, type: "user_input", content: [{ type: "text", text: 'This session was forked from the session "x" at the end of one of its runs.' }, { type: "text", text: "which one is wrong?" }] }),
			at(5, { seq: 4, type: "text_delta", text: "Let me read it." }),
			at(6, { seq: 5, type: "tool_result", callId: "c", content: "...", isError: false }),
			at(7, { seq: 6, type: "text_delta", text: "sub adds." }),
			at(8, { seq: 7, type: "terminal", outcome: { kind: "completed" } }),
			at(9, { seq: 8, type: "user_input", content: "then?" }),
			at(10, { seq: 9, type: "terminal", outcome: { kind: "aborted", by: "user" } }),
		]);
		expect(cards.map((c) => [c.id, c.title, c.detail, c.updatedAt])).toEqual([
			["7", "which one is wrong?", "└ sub adds.", 8],
			["2", "what does calc.js export?", "└ It exports add and sub.", 3],
		]);
	});

	it("offers nothing before a run has finished", () => {
		expect(replyCards([at(1, { seq: 0, type: "user_input", content: "hi" })])).toEqual([]);
	});
});
