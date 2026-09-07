import test from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../src/schema.mjs";

const good = { schema: 2, id: "a", description: "a", level: "warn", files: ["js"], enabled: true, match: { pattern: "x", message: "m" }, fix: null, options: {}, tags: [], examples: { bad: [], good: [] } };
const sorted = (a) => [...a].sort();

test("hidden: a well-formed v2 rule has no problems; a v1 rule has the expected set", () => {
	assert.deepEqual(validateRule("a.json", good), []);
	const v1 = { id: "a", description: "a", severity: 2, when: "js", enabled: "yes", pattern: "x", message: "m" };
	assert.deepEqual(sorted(validateRule("a.json", v1)), sorted(["schema must be 2", "unknown key severity", "unknown key when", "unknown key pattern", "unknown key message", "enabled must be a boolean", "missing level", "missing files", "missing match"]));
});

test("hidden: every message in the specified wording", () => {
	const one = (patch, name = "a.json") => validateRule(name, { ...good, ...patch });
	assert.deepEqual(one({ schema: 1 }), ["schema must be 2"]);
	assert.deepEqual(one({ level: "high" }), ["level must be off, warn or error"]);
	assert.deepEqual(one({ files: [] }), ["files must be a non-empty array of strings"]);
	assert.deepEqual(one({ files: "js" }), ["files must be a non-empty array of strings"]);
	assert.deepEqual(one({ enabled: "no" }), ["enabled must be a boolean"]);
	assert.deepEqual(one({ match: { pattern: "x" } }), ["match must have pattern and message strings"]);
	assert.deepEqual(one({ match: "x" }), ["match must have pattern and message strings"]);
	assert.deepEqual(one({ fix: 3 }), ["fix must be null, a string or an object"]);
	assert.deepEqual(one({ options: [] }), ["options must be an object"]);
	assert.deepEqual(one({ tags: [1] }), ["tags must be an array of strings"]);
	assert.deepEqual(one({ examples: { bad: [] } }), ["examples must have bad and good arrays"]);
	assert.deepEqual(one({ extends: 1 }), ["extends must be a string"]);
	assert.deepEqual(one({ description: 1 }), ["description must be a string"]);
	assert.deepEqual(one({ id: "" }), ["id must be a non-empty string"]);
	assert.deepEqual(one({}, "b.json"), ["id must match the file name"]);
	assert.deepEqual(one({ deprecated: true }), ["unknown key deprecated"]);
	const { match, ...noMatch } = good;
	assert.deepEqual(validateRule("a.json", noMatch), ["missing match"]);
	assert.deepEqual(validateRule("a.json", []), ["not an object"]);
});
