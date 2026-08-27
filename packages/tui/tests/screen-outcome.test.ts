/**
 * REL-0152-D1 — the acceptance the frame-size gates cannot give.
 *
 * `apple-terminal-frames.test.ts` asserts how MUCH a frame writes. That
 * is a proxy, and a proxy is what let this defect ship: sixty-three D1
 * tests were green — every one of them counting control sequences —
 * while the owner watched a complete answer never reach the screen.
 *
 * Forensics on the owner's session (2026-08-25T07-29-29-32d9) closed
 * two of the three links in the chain and left the last one open:
 *
 *   runtime had the data        proven — the answer and the typed line
 *                               are both in the durable log
 *   compositor emitted it       proven — replaying that session through
 *                               the real Body emits the answer's opening
 *                               words 23 times and the user's line 10
 *   the SCREEN keeps it         THIS FILE
 *
 * So these assertions are about the cell model, not the byte stream:
 * after the frames are fed to a real-terminal screen, what does a human
 * see? The answer must be there, exactly once, with the chrome intact —
 * and "exactly once" matters as much as "there", because the emission
 * count above is 23 and a screen that keeps every copy is the A7
 * duplication defect wearing a new hat.
 */

import { describe, expect, it } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const W = 120;
const H = 40;
const ANSWER = "the complete answer the owner never saw";
const TYPED = "why did you stop";

/** Drive a turn the shape the owner's session had: a typed line, a tool
 *  call, then a long streamed answer — flushing every event, as a live
 *  session frames it. */
function runTurn(): Screen {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s), termProgram: "Apple_Terminal" });
	body.enter();
	const screen = new Screen(W, H);
	const flush = (): void => {
		body.render();
		screen.feed(writes.join(""));
		writes.length = 0;
	};
	body.userLine(TYPED);
	flush();
	body.toolStart("read_file", "c1", { path: "kiso.json" });
	flush();
	body.toolRunning("c1");
	flush();
	body.toolSucceeded("c1");
	body.toolResult("c1", { content: "{}", isError: false });
	flush();
	// the answer, streamed in deltas the way a model produces it
	for (const word of `${ANSWER} — and here is a good deal more of it so the band has to wrap and scroll, which is exactly the condition the owner was in when the reply vanished`.split(" ")) {
		body.textAppend(`${word} `);
		flush();
	}
	body.textEnd();
	body.endTurn(0);
	flush();
	return screen;
}

const occurrences = (screen: Screen, needle: string): number =>
	screen.allLines().join("\n").split(needle).length - 1;

describe("REL-0152-D1 — what the screen KEEPS, not what the frame wrote", () => {
	it("the typed line survives on the screen", () => {
		expect(occurrences(runTurn(), TYPED)).toBeGreaterThanOrEqual(1);
	});

	it("the answer reaches the screen EXACTLY once — not lost, not duplicated", () => {
		const n = occurrences(runTurn(), ANSWER);
		expect(n, n === 0 ? "the answer never reached the screen" : `the answer is on the screen ${n} times`).toBe(1);
	});

	it("the box chrome is intact in the final state", () => {
		const rows = runTurn().rows.map((r) => r.join(""));
		const top = rows.findIndex((r) => r.trimStart().startsWith("\u254c"));
		const bottom = rows.map((r, i) => (r.trimStart().startsWith("\u254c") ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
		expect(top, "no box top on the final screen").toBeGreaterThanOrEqual(0);
		expect(bottom, "the box bottom must sit below the box top").toBeGreaterThan(top);
	});
});
