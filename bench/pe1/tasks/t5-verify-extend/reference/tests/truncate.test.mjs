import test from "node:test";
import assert from "node:assert/strict";
import { truncateSlug } from "../src/index.mjs";

test("a fitting slug is unchanged", () => {
  assert.equal(truncateSlug("a-b", 10), "a-b");
});

test("cuts at the last whole word", () => {
  assert.equal(truncateSlug("alpha-beta-gamma", 12), "alpha-beta");
});

test("a too-long first word hard-cuts", () => {
  assert.equal(truncateSlug("supercalifragilistic", 5), "super");
});

test("bad max refuses", () => {
  assert.throws(() => truncateSlug("a", 0), RangeError);
});
