import test from "node:test";
import assert from "node:assert/strict";
import { add, remove, list, reset } from "../src/store.mjs";

test("remove deletes an existing note", () => {
  reset();
  const id = add("gone soon");
  assert.equal(remove(id), true);
  assert.equal(list().length, 0);
});

test("remove of a missing id reports false", () => {
  reset();
  assert.equal(remove(99), false);
});
