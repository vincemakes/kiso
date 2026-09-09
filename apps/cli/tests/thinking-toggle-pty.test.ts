/**
 * §2.3 — ctrl+t folds the thinking blocks, and folds them back.
 *
 * On a terminal a completed thinking block is full paragraphs, indented
 * one column deeper than prose (DC-47). That is the right default — the
 * reasoning is worth reading — and it is a lot of screen when you have
 * stopped wanting it. ctrl+t is the switch.
 *
 * It rides ctrl+o's own mechanism (DC-50 / R14): the key flips ONE
 * boolean and the session is reprinted, so the blocks ALREADY on screen
 * obey it rather than only the next ones. Nothing durable moves: the
 * events are untouched and `/think` still prints the last block whole.
 *
 * The keys ride `delays`, not `feeds`: a needle matched against raw
 * bytes is this repo's most repeated harness mistake, and the thing this
 * asserts on is dim-wrapped.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

/** A turn whose thinking is long enough to be several rows, and prose
 *  after it so the block is settled content rather than the live tail. */
const THOUGHT =
	"Weighing the two shapes for this. The first keeps every character on the screen and pays for it in rows; the second is quieter and leaves nothing behind, which reads as a fault even when the log still holds it.";

function turns(): unknown[] {
	return [
		{
			events: [
				{ type: "thinking", text: THOUGHT },
				{ type: "text_delta", text: "the answer is the first one." },
				{ type: "stop", reason: "end_turn" },
			],
		},
		...spares(4),
	];
}

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("§2.3 — ctrl+t folds the committed thinking blocks", () => {
	it("the block is paragraphs, ctrl+t folds it to one line, ctrl+t again brings it back", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(turns()) });
		const raw = ptyRun(["think-toggle"], env as NodeJS.ProcessEnv, {
			feeds: [["▌ ", "go\r"]],
			delays: [
				[6, "\x14"], // ctrl+t — fold
				[9, "\x14"], // ctrl+t — and back
				[12, "exit\r"],
			],
		});
		const out = strip(raw);

		// ① the default: the thinking reached the screen as its own words
		expect(out, "the block rendered in full").toContain("leaves nothing behind");

		// ② the fold: foldThinking's shape — the leading ellipsis, the
		//    first 100 characters, and the way back to the whole thing
		expect(out, "the folded line carries its own way back").toContain("/think");
		expect(out, "and it is the first 100 characters").toContain("Weighing the two shapes for this.");

		// ③ the answer is untouched by either press — the toggle is about
		//    the reasoning, never the prose beside it
		expect(out).toContain("the answer is the first one.");
	}, 240_000);
});
