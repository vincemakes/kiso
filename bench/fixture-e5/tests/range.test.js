// The E5 Leg 0/1 contract — the 5-step refactor's verify. Covers ONLY the
// four functions the 5-step prompt asks for (the fixture starts with just
// parseRange + clamp; this contract is the target state).
import { clamp, isWithin, minOf, maxOf } from "../src/range.js";
import assert from "node:assert";
assert.equal(clamp(0, 1, 4), 1);
assert.equal(clamp(2, 1, 4), 2);
assert.equal(clamp(5, 1, 4), 4); // the off-by-one fix: inclusive upper bound
assert.equal(isWithin(3, 1, 4), true);
assert.equal(isWithin(5, 1, 4), false);
assert.equal(isWithin(4, 1, 4), true);
assert.equal(minOf([3, 1, 2]), 1);
assert.equal(minOf([]), null);
assert.equal(maxOf([1, 9, 4]), 9);
assert.equal(maxOf([]), null);
console.log("e5 ok");
