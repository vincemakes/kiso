import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRules } from "../src/loader.mjs";
import { applicable, check, kindOf } from "../src/engine.mjs";

const rules = loadRules("rules");

test("kindOf: the lower-cased extension, or empty", () => {
	assert.equal(kindOf("a/b.JS"), "js");
	assert.equal(kindOf("README.md"), "md");
	assert.equal(kindOf("Makefile"), "");
});

test("applicable: enabled, not deprecated, not off, listed for the kind or *", () => {
	const ids = applicable(rules, "md").map((r) => r.id);
	assert.deepEqual(ids, ["max-line-120", "md-heading-space", "md-no-bare-url", "no-hardcoded-secret", "no-http-url", "no-todo", "no-trailing-space"]);
	assert.equal(applicable(rules, "js").some((r) => r.id === "no-with"), false);
	assert.equal(applicable(rules, "js").some((r) => r.id === "prefer-const"), false);
});

test("check: findings sorted by line then rule", () => {
	const findings = check(readFileSync("fixtures/sample.js", "utf8"), "js", rules);
	assert.deepEqual(
		findings.map((f) => `${f.line} ${f.level} ${f.ruleId}`),
		["1 warn camel-case-vars", "1 error no-var", "2 error no-console", "2 error no-tabs", "3 warn no-todo", "4 error pascal-case-classes", "5 warn no-http-url", "7 warn no-empty-catch"],
	);
	assert.equal(findings[3].message, "tab found");
});
