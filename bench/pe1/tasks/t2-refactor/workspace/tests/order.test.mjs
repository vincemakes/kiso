import test from "node:test";
import assert from "node:assert/strict";
import { createOrder, checkout, describeOrder } from "../src/index.mjs";

test("an order accumulates lines and checks out", () => {
  const o = createOrder().add("a", 2).add("b", 1);
  assert.equal(checkout(o), 6);
  assert.equal(describeOrder(o), "2 lines");
});

test("zero qty refuses", () => {
  assert.throws(() => createOrder().add("a", 0), RangeError);
});
