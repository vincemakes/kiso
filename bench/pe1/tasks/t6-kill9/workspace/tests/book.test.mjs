import test from "node:test";
import assert from "node:assert/strict";
import { openBook, balance, describeBook } from "../src/index.mjs";

test("a book records and balances", () => {
  const b = openBook().record("in", 10).record("out", -4);
  assert.equal(balance(b), 6);
  assert.equal(describeBook(b), "2 entries");
});

test("a non-finite amount refuses", () => {
  assert.throws(() => openBook().record("bad", Number.NaN), RangeError);
});
