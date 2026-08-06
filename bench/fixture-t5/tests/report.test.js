// plain node test — the bench convention. Covers report.js summarize.
import assert from "node:assert";
import { summarize } from "../src/report.js";
assert.strictEqual(summarize("1-2,3-4"), 2);
assert.strictEqual(summarize("x"), 0);
console.log("report ok");
