/**
 * REL-0152-D7 — a committed user chip is erased by the live band.
 *
 * Forensics on the owner's session (2026-08-25T07-29-29-32d9, 6,581
 * events) replayed through the real compositor and the A7 cell model:
 *
 *   #3074 APPEARS  (user_input)   the chip reaches the screen
 *   #3075 GONE     (thinking)     the next thinking frame erases it
 *   #3496 APPEARS  (tool_result)
 *   #5067 GONE     (text_delta)   the streamed answer erases it for good
 *
 * Both losses happen the moment the LIVE band grows. The chip is
 * committed content — it belongs to the frozen band and the scrollback —
 * and an erase range meant for the old live copies is reaching past its
 * boundary into it.
 *
 * The same miscalculation shows on the other side: the FIRST chip in
 * that session ends up on the screen 17 times. Erasing the wrong rows
 * and repainting elsewhere loses content in one place and duplicates it
 * in another, which is the A7/A8/A8b family this file's neighbours
 * document.
 *
 * NOT the tearing (REL-0152-D1). This is deterministic: a terminal that
 * applies every byte correctly still ends up without the chip, so no
 * amount of frame atomicity fixes it.
 */

import { describe, expect, it } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

const W = 100;
const H = 24;
const CHIP = "why did you stop";

/** The session's shape, compressed: enough committed turns to push the
 *  window down, then the chip, then a thinking burst and a streamed
 *  answer — the two moments the real session lost it. */
function replay(): { screen: Screen; transitions: string[] } {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s), termProgram: "Apple_Terminal" });
	body.enter();
	const screen = new Screen(W, H);
	const transitions: string[] = [];
	let prev = false;
	let armed = false;
	const flush = (label: string): void => {
		body.render();
		const frame = writes.join("");
		writes.length = 0;
		// where is the chip sitting BEFORE this frame lands?
		const rowBefore = screen.rows.findIndex((r) => r.join("").includes(CHIP));
		screen.feed(frame);
		if (!armed) return;
		const here = screen.allLines().join("\n").includes(CHIP);
		if (here !== prev) {
			if (!here && rowBefore >= 0) {
				const erased = [...frame.matchAll(/\x1b\[(\d+);1H\x1b\[0K/g)].map((m) => Number(m[1]));
				const scrolls = (frame.match(/\n/g) ?? []).length;
				transitions.push(`GONE@${label}[chipRow=${rowBefore + 1} erased=${JSON.stringify(erased.slice(0, 14))} LFs=${scrolls}]`);
			} else {
				transitions.push(`${here ? "APPEARS" : "GONE"}@${label}`);
			}
			prev = here;
		}
	};

	// a first turn that commits enough rows to move the window
	body.userLine("first request");
	flush("u1");
	for (let i = 0; i < 30; i += 1) {
		body.textAppend(`committed line ${i} — filler that scrolls the window down past a screenful\n`);
		flush("t1");
	}
	body.textEnd();
	body.endTurn(0);
	flush("end1");

	// the chip whose fate is under test
	body.userLine(CHIP);
	armed = true;
	flush("chip");

	// the two moments the real session lost it
	for (let i = 0; i < 20; i += 1) {
		body.thinkingAppend(`thinking about it, at some length, line ${i}\n`);
		flush("thinking");
	}
	body.toolStart("read_file", "c1", { path: "x" });
	body.toolRunning("c1");
	body.toolSucceeded("c1");
	body.toolResult("c1", { content: "{}", isError: false });
	flush("tool");
	for (let i = 0; i < 40; i += 1) {
		body.textAppend(`the answer streams on, line ${i}, long enough to wrap and scroll the live band\n`);
		flush("stream");
	}
	body.textEnd();
	body.endTurn(0);
	flush("end2");
	return { screen, transitions };
}

describe("REL-0152-D7 — a committed chip survives the live band", () => {
	// `it.fails` pins the defect without leaving the tree red. The body is
	// what a correct renderer must satisfy; it throws today. When the
	// scroll-without-commit fix lands this case starts FAILING — that is
	// the alarm — and the fix flips it back to a plain `it` in the same
	// commit.
	it.fails("the chip is still on the screen after a thinking burst and a streamed answer — RED until REL-0152-D7 is fixed", () => {
		const { screen, transitions } = replay();
		const n = screen.allLines().join("\n").split(CHIP).length - 1;
		expect(n, `the chip is on the screen ${n} times; transitions: ${transitions.join(" ")}`).toBe(1);
	});
});
