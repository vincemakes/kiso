import test from "node:test";
import assert from "node:assert/strict";
import { discountedUnitPrice } from "../src/pricing.mjs";
import { cartTotal } from "../src/cart.mjs";

test("a discount applies to the list price", () => {
  assert.equal(discountedUnitPrice(100, 20, 10), 80);
});

test("the floor holds: a deep discount never sells below cost", () => {
  // list 50, 40% off = 30, but the floor is 35 -> the price is 35
  assert.equal(discountedUnitPrice(50, 40, 35), 35);
});

test("cart total sums discounted lines", () => {
  assert.equal(cartTotal([
    { listPrice: 10, qty: 2, discountPct: 0, costFloor: 1 },
    { listPrice: 100, qty: 1, discountPct: 50, costFloor: 20 },
  ]), 70);
});
