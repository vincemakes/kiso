import test from "node:test";
import assert from "node:assert/strict";
import { statz } from "./_cli.mjs";

test("top: three names by mean, descending", () => {
	const r = statz("top", "fixtures/sample.csv");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "throughput  100.00\n" + "latency     9.92\n" + "errors      3.00\n");
});

test("top --n 2 --by max", () => {
	const r = statz("top", "fixtures/sample.csv", "--n", "2", "--by", "max");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "throughput  120.00\n" + "latency     12.50\n");
});

test("top rejects a blank line (the reader that drifted)", () => {
	const r = statz("top", "fixtures/mixed.csv");
	assert.equal(r.status, 3);
	assert.equal(r.stdout, "");
	assert.equal(r.stderr, "statz: bad line 4\n");
});
