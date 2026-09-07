import test from "node:test";
import assert from "node:assert/strict";
import { statz } from "./_cli.mjs";

test("export: JSON by default, raw numbers, two-space indent", () => {
	const r = statz("export", "fixtures/sample.csv");
	assert.equal(r.status, 0);
	const parsed = JSON.parse(r.stdout);
	assert.equal(parsed.length, 3);
	assert.deepEqual(parsed[1], { name: "latency", count: 3, min: 7.25, max: 12.5, mean: 9.916666666666666, p50: 10, unit: "ms" });
	assert.equal(r.stdout, `${JSON.stringify(parsed, null, 2)}\n`);
});

test("export --format csv", () => {
	const r = statz("export", "fixtures/sample.csv", "--format", "csv");
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "name,count,min,max,mean,p50,unit\n" + "errors,1,3.00,3.00,3.00,3.00,count\n" + "latency,3,7.25,12.50,9.92,10.00,ms\n" + "throughput,2,80.00,120.00,100.00,100.00,rps\n");
});
