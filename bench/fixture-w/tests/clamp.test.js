import { clamp } from "../src/range.js";
import assert from "node:assert";
assert.equal(clamp(0, 1, 4), 1);
assert.equal(clamp(2, 1, 4), 2);
assert.equal(clamp(5, 1, 4), 4); // inclusive upper bound
console.log("clamp ok");
