import test from "node:test";
import assert from "node:assert/strict";
import { lintr } from "./_cli.mjs";

test("list --kind json: the rules that apply, as a table", () => {
	const r = lintr("list", "--kind", "json");
	assert.equal(r.status, 0);
	assert.equal(
		r.stdout,
		"id                      level  files  note\n" +
			"json-no-comments        error  json\n" +
			"json-no-trailing-comma  error  json\n" +
			"no-hardcoded-secret     error  *\n" +
			"no-http-url             warn   *\n" +
			"no-trailing-space       warn   *\n",
	);
});

test("list: every rule, with its note", () => {
	const r = lintr("list");
	assert.equal(r.status, 0);
	const lines = r.stdout.split("\n");
	assert.equal(lines.length, 32);
	assert.equal(lines[1], "base-naming             off    *         disabled");
	assert.equal(lines[18], "no-nested-ternary       warn   js,ts     deprecated");
});

test("check: findings and the summary line; exit 1 on an error-level finding", () => {
	const r = lintr("check", "fixtures/sample.ts", "fixtures/README.md", "fixtures/data.json");
	assert.equal(r.status, 1);
	assert.equal(
		r.stdout,
		"fixtures/sample.ts:1: warn ts-no-any: explicit any\n" +
			"fixtures/sample.ts:2: warn ts-no-non-null: non-null assertion\n" +
			"fixtures/sample.ts:3: error no-only-tests: focused test\n" +
			"fixtures/sample.ts:4: error no-debugger: debugger statement\n" +
			"fixtures/README.md:1: error md-heading-space: heading without a space\n" +
			"fixtures/README.md:2: warn md-no-bare-url: bare URL\n" +
			"fixtures/data.json:2: error json-no-comments: comment in JSON\n" +
			"fixtures/data.json:3: error json-no-trailing-comma: trailing comma\n" +
			"8 findings, 5 errors\n",
	);
	const clean = lintr("check", "fixtures/clean.js");
	assert.equal(clean.status, 0);
	assert.equal(clean.stdout, "0 findings, 0 errors\n");
});

test("validate: every rule file is well-formed", () => {
	const r = lintr("validate");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "30 rules ok\n");
});

test("errors: unreadable file exits 2, usage exits 1", () => {
	assert.deepEqual(lintr("check", "nope.js"), { status: 2, stdout: "", stderr: "lintr: cannot read nope.js\n" });
	assert.equal(lintr("frob").status, 1);
	assert.equal(lintr("check").status, 1);
	assert.deepEqual(lintr("list", "--frob"), { status: 1, stdout: "", stderr: "lintr: unknown option --frob\n" });
});
