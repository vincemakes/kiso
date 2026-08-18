/**
 * TUI2-R3v2 slice ③ — parsing the model's safer-options answer.
 *
 * The whole file is about refusing to be clever. The temptation with a
 * model answer is to salvage a half-parse: coerce a bare string into a
 * command, accept an object where an array was asked for, keep the two
 * entries that looked right out of three that did not. Every one of
 * those produces a list of "alternatives the model proposed" that the
 * model did not propose — shown to a human deciding whether to run a
 * destructive command, with a click-to-confirm bar on it.
 *
 * So the rule is: exactly the requested shape, or null. Null degrades to
 * one honest line, which is a state the human can act on.
 */
import { describe, expect, it } from "vitest";
import { parseSaferOptions } from "../src/chat.js";

const GOOD = JSON.stringify([
	{ command: "npm run build", why: "rebuild in place, keep build/" },
	{ command: "rm -rf build/cache && npm run build", why: "only clear the cache" },
]);

describe("TUI2-R3v2 ③ — parseSaferOptions accepts the requested shape", () => {
	it("a clean JSON array", () => {
		expect(parseSaferOptions(GOOD)).toEqual([
			{ command: "npm run build", why: "rebuild in place, keep build/" },
			{ command: "rm -rf build/cache && npm run build", why: "only clear the cache" },
		]);
	});

	it("a FENCED array — the one accommodation, because models emit it constantly", () => {
		expect(parseSaferOptions("```json\n" + GOOD + "\n```")).toHaveLength(2);
		expect(parseSaferOptions("```\n" + GOOD + "\n```")).toHaveLength(2);
	});

	it("prose around the array — the array is found, the prose ignored", () => {
		expect(parseSaferOptions(`Here you go:\n${GOOD}\nHope that helps!`)).toHaveLength(2);
	});

	it("caps at THREE — the panel offers a choice, not a catalogue", () => {
		const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ command: `cmd${i}`, why: "w" })));
		expect(parseSaferOptions(many)).toHaveLength(3);
	});

	it("a missing `why` is tolerated — the command is the load-bearing half", () => {
		expect(parseSaferOptions('[{"command":"npm test"}]')).toEqual([{ command: "npm test", why: "" }]);
	});
});

describe("TUI2-R3v2 ③ — everything else is a FAILURE, and fails to null", () => {
	it("the empty answer the prompt itself asks for when nothing is safer", () => {
		expect(parseSaferOptions("[]")).toBeNull();
	});

	for (const [label, text] of [
		["not JSON at all", "I think you should just run it."],
		["truncated JSON", '[{"command":"npm run build"'],
		["an object, not an array", '{"command":"npm run build","why":"x"}'],
		["an array of strings", '["npm run build","npm test"]'],
		["an array of nulls", "[null,null]"],
		["an entry with no command", '[{"why":"safer somehow"}]'],
		["an empty command", '[{"command":"   ","why":"x"}]'],
		["a numeric command", '[{"command":42,"why":"x"}]'],
		["the empty string", ""],
		["whitespace", "   \n  "],
	] as const) {
		it(`${label} → null, never a salvaged half-list`, () => {
			expect(parseSaferOptions(text)).toBeNull();
		});
	}

	it("ONE bad entry poisons the batch — a partial list would misattribute", () => {
		// the model proposed three things; we could not read one of them.
		// Showing the other two as "what the model proposed" is a claim
		// about an answer we did not understand.
		expect(parseSaferOptions('[{"command":"a","why":"x"},{"nope":1},{"command":"c","why":"z"}]')).toBeNull();
	});
});
