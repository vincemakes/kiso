// plain node test — the bench convention. Covers report.js's final API
// (the existing user report line + the T6 turns 11-13).
import assert from "node:assert";
import { mergedText, reportLine, totalSpan, widest } from "../src/report.js";
const line = reportLine({ name: "Ada", email: "a@b.c" }, 3);
assert.ok(line.includes("Ada <a@b.c>"));
assert.strictEqual(totalSpan("1-3,5-5"), 4);
assert.strictEqual(widest("1-3,7-10,2-2"), "7-10"); // a unique widest — ties resolve to the first
assert.strictEqual(mergedText("1-2,2-5"), "1-5");
assert.strictEqual(mergedText("1-2,3-4"), "1-2,3-4");
console.log("report ok");
