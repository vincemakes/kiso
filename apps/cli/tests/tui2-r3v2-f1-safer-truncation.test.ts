/**
 * Finding R3v2-F1 — the safer-options truncation fix.
 *
 * THE FINDING, verified twice against the live flagship model: the side
 * query's flat 500-token cap cut the reply mid-JSON, so the parser could
 * never succeed. The canonical output was EXACTLY 500 tokens on the
 * failing attempt — the cap, not the model, ended the sentence. The
 * honest degradation held both times, which is why this was a finding
 * and not an incident; but a button whose success path is unreachable is
 * a button that does not work.
 *
 * Three causes, three fixes, tested here:
 *
 *   1. the prompt did not FORBID prose, so a verbose model spent its
 *      budget on an explanation and ran out mid-array;
 *   2. the cap was 500 — small enough that prose + JSON never fit;
 *   3. the parser found the JSON by `indexOf("[")` / `lastIndexOf("]")`,
 *      which a truncated reply defeats, and which a bracket in the
 *      trailing prose ALSO defeats — and every failure, whatever its
 *      cause, produced the same generic line.
 *
 * The strictness this file does NOT relax: one bad entry still poisons
 * the batch, an empty list is still a failure, a non-string command is
 * still a failure. Those rules exist because a salvaged half-list is a
 * claim about an answer we did not understand, made to someone deciding
 * whether to delete their build directory. Tolerating a FENCE, an
 * ENVELOPE, or a `reason` spelling of `why` misattributes nothing: the
 * content is verbatim either way.
 */
import { describe, expect, it } from "vitest";
import { SAFER_MAX_TOKENS, SAFER_SYSTEM_PROMPT, parseSaferOptions, saferFailureNote } from "../src/chat.js";

/** The shape the amended prompt asks for. */
const ENVELOPE = JSON.stringify({
	alternatives: [
		{ command: "npm run build", reason: "rebuild in place, keep build/" },
		{ command: "rm -rf build/cache && npm run build", reason: "only clear the cache" },
	],
});

/** What the live failure actually looked like: prose, a fence, and then
 *  the budget ran out mid-string. No closing quote, no closing brace, no
 *  closing bracket, no closing fence. */
const TRUNCATED = [
	"Sure — here are some safer ways to approach this. The original command",
	"removes the whole build directory, which is irreversible, so the",
	"alternatives below each narrow the blast radius in a different way.",
	"",
	"```json",
	'{"alternatives":[{"command":"npm run build","reason":"rebuilds in place and keeps build/"},',
	'{"command":"rm -rf build/cache && npm run build","reason":"clears only the ca',
].join("\n");

describe("R3v2-F1 (a) — a reply cut short says SO, distinctly", () => {
	it("the truncated live shape is detected as truncated, not as generic garbage", () => {
		expect(saferFailureNote(TRUNCATED)).toBe(
			"couldn't get safer options (the reply was cut short) — the original choices stand",
		);
	});

	it("an unterminated array with no fence and no prose is truncation too", () => {
		expect(saferFailureNote('[{"command":"npm run build","why":"keeps build/"')).toBe(
			"couldn't get safer options (the reply was cut short) — the original choices stand",
		);
	});

	it("a truncated reply still PARSES to null — the fix is the words, not a salvage", () => {
		expect(parseSaferOptions(TRUNCATED)).toBeNull();
	});

	it("every OTHER failure keeps the original line — the distinct copy is not a catch-all", () => {
		for (const text of ["I think you should just run it.", "", "   \n  ", "[]", '["npm test"]']) {
			expect(saferFailureNote(text)).toBe("couldn't get safer options — the original choices stand");
		}
	});

	it("a reply that closed its JSON and then failed our SHAPE is not truncation", () => {
		// the model finished its sentence; we simply could not use it.
		// Telling the human it was "cut short" would be a wrong diagnosis.
		expect(saferFailureNote('[{"command":"a","why":"x"},{"nope":1}]')).toBe(
			"couldn't get safer options — the original choices stand",
		);
	});
});

describe("R3v2-F1 (b) — a fenced or wrapped JSON body parses", () => {
	it("the ENVELOPE the amended prompt asks for", () => {
		expect(parseSaferOptions(ENVELOPE)).toEqual([
			{ command: "npm run build", why: "rebuild in place, keep build/" },
			{ command: "rm -rf build/cache && npm run build", why: "only clear the cache" },
		]);
	});

	it("the envelope FENCED — `reason` survives the trip (it used to be dropped)", () => {
		// the pre-fix parser found the inner array and kept it, but read
		// only `why`, so every alternative arrived with an EMPTY reason —
		// a safety list whose entries do not say why they are safer.
		expect(parseSaferOptions("```json\n" + ENVELOPE + "\n```")).toEqual([
			{ command: "npm run build", why: "rebuild in place, keep build/" },
			{ command: "rm -rf build/cache && npm run build", why: "only clear the cache" },
		]);
	});

	it("an UNCLOSED fence around a complete body — the reply ended, the fence did not", () => {
		expect(parseSaferOptions("Here you go:\n```json\n" + ENVELOPE)).toHaveLength(2);
	});

	it("trailing prose containing a BRACKET no longer defeats the scan", () => {
		// lastIndexOf("]") used to land in the prose, and the slice that
		// came back was not JSON.
		const good = JSON.stringify([{ command: "npm test", why: "runs nothing destructive" }]);
		expect(parseSaferOptions(`${good}\nPick whichever fits [I would take the first].`)).toHaveLength(1);
	});

	it("the legacy bare array with `why` is still exactly what it was", () => {
		expect(parseSaferOptions('[{"command":"npm test","why":"safe"}]')).toEqual([
			{ command: "npm test", why: "safe" },
		]);
	});
});

describe("R3v2-F1 (c) — the amended request-class declaration", () => {
	it("the prompt FORBIDS prose and names the exact schema", () => {
		expect(SAFER_SYSTEM_PROMPT).toContain("JSON ONLY");
		expect(SAFER_SYSTEM_PROMPT).toContain("no prose");
		expect(SAFER_SYSTEM_PROMPT).toContain('{"alternatives":[{"command":"...","reason":"..."}]}');
		expect(SAFER_SYSTEM_PROMPT).toContain("2-3");
		expect(SAFER_SYSTEM_PROMPT).toMatch(/one line|ONE line/);
	});

	it("the prompt still says what to do when nothing is safer", () => {
		// the empty answer is a legitimate verdict, and dropping it from
		// the prompt would make the model invent alternatives to fill the
		// schema it was just handed.
		expect(SAFER_SYSTEM_PROMPT).toContain('{"alternatives":[]}');
	});

	it("the cap is no longer the thing that breaks parsing", () => {
		// 500 WAS the observed truncation point. The JSON-only reply the
		// prompt now asks for lands near 200 tokens; the ceiling is a
		// runaway guard, not a budget the answer is expected to reach.
		expect(SAFER_MAX_TOKENS).toBe(1500);
	});
});
