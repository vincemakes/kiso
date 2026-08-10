// plain node test — the bench convention. Covers the FINAL range.js API
// (the T6 chain's turns 1-10 and 18-21, all present from turn 0 — the
// progressive tasks build toward this contract, and the verify runs it).
import assert from "node:assert";
import {
	clamp,
	countDistinct,
	everyNth,
	formatRange,
	hasOverlap,
	isBetween,
	longestRun,
	maxOf,
	mergeOverlaps,
	minOf,
	overlaps,
	parseRangeList,
	startsOf,
	sumOf,
} from "../src/range.js";
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
assert.strictEqual(minOf([3, 1, 2]), 1);
assert.strictEqual(minOf([]), null);
assert.strictEqual(sumOf([1, 2, 3]), 6);
assert.strictEqual(sumOf([]), 0);
assert.deepStrictEqual(startsOf("1-2,9-10"), [1, 9]);
assert.strictEqual(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 }), true);
assert.strictEqual(overlaps({ start: 1, end: 2 }, { start: 3, end: 4 }), false);
assert.deepStrictEqual(mergeOverlaps([
	{ start: 1, end: 3 },
	{ start: 2, end: 5 },
	{ start: 7, end: 8 },
]), [
	{ start: 1, end: 5 },
	{ start: 7, end: 8 },
]);
assert.deepStrictEqual(everyNth("1-2,3-4,5-6,7-8", 2), [
	{ start: 1, end: 2 },
	{ start: 5, end: 6 },
]);
assert.strictEqual(hasOverlap("1-3,2-4"), true);
assert.strictEqual(hasOverlap("1-2,3-4"), false);
assert.strictEqual(countDistinct("1-3,2-5"), 5); // 1,2,3,4,5
assert.strictEqual(countDistinct("1-2,3-4"), 4);
assert.strictEqual(longestRun("1-2,4-5,6-6"), 3); // 4,5,6
assert.strictEqual(longestRun("1-2"), 2);
console.log("range ok");
