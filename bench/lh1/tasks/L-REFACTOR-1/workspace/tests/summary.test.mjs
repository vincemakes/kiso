import test from "node:test";
import assert from "node:assert/strict";
import { statz } from "./_cli.mjs";

test("summary: one row per name, sorted by name, padded columns", () => {
	const r = statz("summary", "fixtures/sample.csv");
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.equal(
		r.stdout,
		"name        count  min    max     mean    p50     unit\n" +
			"errors      1      3.00   3.00    3.00    3.00    count\n" +
			"latency     3      7.25   12.50   9.92    10.00   ms\n" +
			"throughput  2      80.00  120.00  100.00  100.00  rps\n",
	);
});

test("summary --unit filters rows before aggregating", () => {
	const r = statz("summary", "fixtures/sample.csv", "--unit", "ms");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "name     count  min   max    mean  p50    unit\n" + "latency  3      7.25  12.50  9.92  10.00  ms\n");
});

test("summary --sort mean orders by mean descending", () => {
	const r = statz("summary", "fixtures/sample.csv", "--sort", "mean");
	assert.equal(r.status, 0);
	assert.equal(
		r.stdout,
		"name        count  min    max     mean    p50     unit\n" +
			"throughput  2      80.00  120.00  100.00  100.00  rps\n" +
			"latency     3      7.25   12.50   9.92    10.00   ms\n" +
			"errors      1      3.00   3.00    3.00    3.00    count\n",
	);
});

test("summary skips a blank line", () => {
	const r = statz("summary", "fixtures/mixed.csv");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "name  count  min     max     mean    p50     unit\n" + "cpu   2      0.50    0.75    0.63    0.63    ratio\n" + "mem   2      256.00  512.00  384.00  384.00  mb\n");
});
