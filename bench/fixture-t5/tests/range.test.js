// plain node test — the bench convention. Covers the FINAL range.js API.
import assert from "node:assert";
import { clamp, isBetween, maxOf, formatRange, parseRangeList } from "../src/range.js";
assert.strictEqual(clamp(5, 1, 4), 4); // the off-by-one fix
assert.strictEqual(isBetween(3, 1, 4), true);
assert.strictEqual(isBetween(5, 1, 4), false);
assert.strictEqual(isBetween(4, 1, 4), true);
assert.strictEqual(maxOf([1, 9, 4]), 9);
assert.strictEqual(maxOf([]), null);
assert.strictEqual(formatRange(3, 1), "1-3");
assert.deepStrictEqual(parseRangeList("1-2,9-10,bad,4"), [
	{ start: 1, end: 2 },
	{ start: 9, end: 10 },
	{ start: 4, end: 4 },
]);
console.log("range ok");
