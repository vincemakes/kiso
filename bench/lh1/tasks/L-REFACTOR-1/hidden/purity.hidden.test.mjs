import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseCsv, aggregate, median, StatzError, parseArgs, summary, top, exportRows } from "../src/index.mjs";

const sample = readFileSync("fixtures/sample.csv", "utf8");
const cli = (...args) => spawnSync(process.execPath, ["src/cli.mjs", ...args], { encoding: "utf8" });
const statzError = (code, message) => (e) => e instanceof StatzError && e.code === code && e.message === message;

test("hidden: parseCsv row shape and messages", () => {
	assert.deepEqual(parseCsv("name,value,unit,tags\na,1.5,ms,x;y\nb,2,s,\n"), [
		{ name: "a", value: 1.5, unit: "ms", tags: ["x", "y"] },
		{ name: "b", value: 2, unit: "s", tags: [] },
	]);
	assert.throws(() => parseCsv("nope\n"), statzError(3, "bad header"));
	assert.throws(() => parseCsv("name,value,unit,tags\na,x,ms,\n"), statzError(3, "bad value on line 2"));
	assert.throws(() => parseCsv("name,value,unit,tags\na,1,ms\n"), statzError(3, "bad line 2"));
});

test("hidden: aggregate and median", () => {
	assert.equal(median([1, 2, 3]), 2);
	assert.equal(median([1, 2, 3, 4]), 2.5);
	const groups = aggregate(parseCsv(sample));
	assert.deepEqual(
		groups.map((g) => g.name),
		["errors", "latency", "throughput"],
	);
	assert.deepEqual(groups[1], { name: "latency", count: 3, min: 7.25, max: 12.5, mean: 29.75 / 3, p50: 10, unit: "ms" });
	assert.deepEqual(aggregate([]), []);
});

test("hidden: StatzError", () => {
	const e = new StatzError(3, "x");
	assert.equal(e instanceof Error, true);
	assert.equal(e.code, 3);
	assert.equal(e.message, "x");
});

test("hidden: parseArgs applies the defaults and keeps the messages", () => {
	const t = parseArgs(["top", "f.csv", "--n", "2"]);
	assert.equal(t.command, "top");
	assert.equal(t.file, "f.csv");
	assert.equal(t.options.n, 2);
	assert.equal(t.options.by, "mean");
	const s = parseArgs(["summary", "f.csv"]);
	assert.equal(s.options.sort, "name");
	assert.equal(s.options.unit, undefined);
	assert.equal(parseArgs(["export", "f.csv"]).options.format, "json");
	assert.throws(() => parseArgs(["top", "f.csv", "--n", "0"]), statzError(1, "bad value for --n"));
	assert.throws(() => parseArgs(["summary", "f.csv", "--frob"]), statzError(1, "unknown option --frob"));
	assert.throws(() => parseArgs(["summary", "f.csv", "--unit"]), statzError(1, "missing value for --unit"));
	assert.throws(() => parseArgs(["frob", "f.csv"]), (e) => e instanceof StatzError && e.usage === true);
	assert.throws(() => parseArgs(["summary"]), (e) => e instanceof StatzError && e.usage === true);
	assert.throws(() => parseArgs([]), (e) => e instanceof StatzError && e.usage === true);
});

test("hidden: the pure commands return exactly what the CLI prints", () => {
	const rows = parseCsv(sample);
	assert.equal(summary(rows, { unit: undefined, sort: "name" }), cli("summary", "fixtures/sample.csv").stdout);
	assert.equal(summary(rows, { unit: "ms", sort: "mean" }), cli("summary", "fixtures/sample.csv", "--unit", "ms", "--sort", "mean").stdout);
	assert.equal(top(rows, { n: 2, by: "max" }), cli("top", "fixtures/sample.csv", "--n", "2", "--by", "max").stdout);
	assert.equal(top(rows, { n: 3, by: "mean" }), cli("top", "fixtures/sample.csv").stdout);
	assert.equal(exportRows(rows, { format: "csv" }), cli("export", "fixtures/sample.csv", "--format", "csv").stdout);
	assert.equal(exportRows(rows, { format: "json" }), cli("export", "fixtures/sample.csv").stdout);
});
