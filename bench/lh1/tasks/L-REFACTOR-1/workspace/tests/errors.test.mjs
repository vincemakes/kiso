import test from "node:test";
import assert from "node:assert/strict";
import { statz } from "./_cli.mjs";

const USAGE = "usage: statz <summary|top|export> <file> [options]\n";

test("a file that cannot be read exits 2", () => {
	const r = statz("summary", "nope.csv");
	assert.equal(r.status, 2);
	assert.equal(r.stdout, "");
	assert.equal(r.stderr, "statz: cannot read nope.csv\n");
});

test("--n must be a positive integer", () => {
	const r = statz("top", "fixtures/sample.csv", "--n", "0");
	assert.equal(r.status, 1);
	assert.equal(r.stderr, "statz: bad value for --n\n");
});

test("an unknown option exits 1", () => {
	const r = statz("summary", "fixtures/sample.csv", "--frob");
	assert.equal(r.status, 1);
	assert.equal(r.stderr, "statz: unknown option --frob\n");
});

test("usage: unknown command, missing file, no arguments", () => {
	for (const args of [["frob", "x"], ["summary"], []]) {
		const r = statz(...args);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, "");
		assert.equal(r.stderr, USAGE);
	}
});
