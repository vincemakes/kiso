/**
 * K15a (0.48.0, owner-approved 2026-10-07): a schema refusal for an
 * argument the tool does not declare names that argument. Before, the
 * model read "/ must NOT have additional properties" and could not tell
 * which of its own fields to drop.
 *
 * The rule: the diagnostic carries the smallest thing that makes the call
 * fixable. The rejected name is the model's own input — it reveals nothing
 * of the schema — so it is named, JSON-quoted (a quote or a newline in it
 * cannot blur the line) and bounded (a runaway invented name cannot flood
 * the context). Every other refusal reads exactly as before: a missing
 * property is already named, and an enum's allowed values stay unlisted
 * (K15b, deferred — a host's validation schema may hold values its
 * model-facing schema does not show).
 */

import { describe, expect, it } from "vitest";
import { validateArgs } from "../src/tools/validate.js";

const schema = {
	type: "object",
	properties: {
		prompt: { type: "string" },
		mode: { enum: ["edit", "restyle", "inpaint"] },
		opts: { type: "object", properties: { seed: { type: "number" } }, additionalProperties: false },
	},
	required: ["prompt"],
	additionalProperties: false,
};

describe("K15a: an undeclared argument is named in the refusal", () => {
	it("at the root", () => {
		expect(validateArgs(schema, { prompt: "a cat", quality: "high" })).toBe('/ must NOT have additional properties: "quality"');
	});

	it("nested: the path and the name, both", () => {
		expect(validateArgs(schema, { prompt: "a cat", opts: { seed: 1, steps: 9 } })).toBe('/opts must NOT have additional properties: "steps"');
	});

	it("a name with a quote or a newline is escaped — the refusal stays one line", () => {
		const why = validateArgs(schema, { prompt: "a cat", 'a"b\nc': 1 });
		expect(why).toBe('/ must NOT have additional properties: "a\\"b\\nc"');
		expect(why).not.toContain("\n");
	});

	it("a runaway name is cut at 96 characters and says so", () => {
		const long = "x".repeat(500);
		const why = validateArgs(schema, { prompt: "a cat", [long]: 1 })!;
		expect(why).toBe(`/ must NOT have additional properties: "${"x".repeat(96)}…"`);
		expect(why.length).toBeLessThan(160);
	});
});

describe("K15a: every other refusal reads exactly as before", () => {
	it("a missing property (already named by the validator)", () => {
		expect(validateArgs(schema, { mode: "edit" })).toBe("/ must have required property 'prompt'");
	});

	it("an enum: the allowed values are NOT listed (K15b deferred)", () => {
		expect(validateArgs(schema, { prompt: "a cat", mode: "zoom" })).toBe("/mode must be equal to one of the allowed values");
	});

	it("a wrong type", () => {
		expect(validateArgs(schema, { prompt: 3 })).toBe("/prompt must be string");
	});

	it("valid input is null", () => {
		expect(validateArgs(schema, { prompt: "a cat", mode: "edit", opts: { seed: 1 } })).toBeNull();
	});
});
