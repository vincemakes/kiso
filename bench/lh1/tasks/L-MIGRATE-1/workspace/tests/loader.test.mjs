import test from "node:test";
import assert from "node:assert/strict";
import { loadRules } from "../src/loader.mjs";

const rules = loadRules("rules");
const byId = Object.fromEntries(rules.map((r) => [r.id, r]));

test("loadRules: every rule, sorted by id", () => {
	assert.equal(rules.length, 30);
	assert.deepEqual(
		rules.map((r) => r.id),
		[...rules.map((r) => r.id)].sort(),
	);
});

test("loadRules: the normalized shape of a plain rule", () => {
	assert.deepEqual(byId["no-tabs"], {
		id: "no-tabs",
		description: "Tabs are not allowed in source files.",
		extends: null,
		level: "error",
		files: ["js", "ts"],
		enabled: true,
		pattern: "\\t",
		message: "tab found",
		fix: null,
		options: { allowInStrings: false },
		tags: ["style"],
		examples: { bad: ["\tx"], good: ["  x"] },
		deprecated: false,
	});
});

test("loadRules: kinds are trimmed, a numeric-string severity is a level, a missing enabled means on", () => {
	assert.deepEqual(byId["max-line-120"].files, ["js", "ts", "md"]);
	assert.equal(byId["no-fixme"].level, "error");
	assert.equal(byId["no-fixme"].enabled, true);
	assert.deepEqual(byId["no-fixme"].tags, ["hygiene"]);
	assert.deepEqual(byId["no-trailing-space"].files, ["*"]);
});

test("loadRules: disabled, off and deprecated are distinct", () => {
	assert.equal(byId["prefer-const"].enabled, false);
	assert.equal(byId["md-trailing-hashes"].level, "off");
	assert.equal(byId["no-with"].deprecated, true);
	assert.deepEqual(byId["no-with"].tags, ["security", "modern"]);
	assert.equal(byId["no-nested-ternary"].deprecated, true);
});

test("loadRules: a rule that extends another inherits what it omits", () => {
	const child = byId["camel-case-vars"];
	assert.equal(child.extends, "base-naming");
	assert.equal(child.level, "warn");
	assert.deepEqual(child.files, ["js", "ts"]);
	assert.equal(child.enabled, true);
	assert.deepEqual(child.options, { style: "camel" });
	assert.deepEqual(child.tags, ["naming"]);
	assert.deepEqual(child.examples, { bad: [], good: [] });
	assert.equal(child.fix, null);
	assert.deepEqual(byId["pascal-case-classes"].tags, ["naming", "classes"]);
	assert.equal(byId["base-naming"].enabled, false);
});
