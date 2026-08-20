import test from "node:test";
import assert from "node:assert/strict";
import { discountedUnitPrice } from "../src/pricing.mjs";

test("hidden: floor equality is exact", () => {
  assert.equal(discountedUnitPrice(100, 30, 70), 70);
});

test("hidden: 90% discount still floors", () => {
  assert.equal(discountedUnitPrice(200, 90, 25), 25);
});

test("hidden: no floor interference when discount stays above it", () => {
  assert.equal(discountedUnitPrice(80, 25, 10), 60);
});
