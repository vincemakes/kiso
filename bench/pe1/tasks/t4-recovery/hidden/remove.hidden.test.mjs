import test from "node:test";
import assert from "node:assert/strict";
import { add, remove, list, reset } from "../src/store.mjs";

test("hidden: remove is precise — the other notes survive", () => {
  reset();
  add("keep-a");
  const mid = add("drop");
  add("keep-b");
  assert.equal(remove(mid), true);
  assert.deepEqual(list().map((n) => n.text), ["keep-a", "keep-b"]);
});

test("hidden: double remove reports false the second time", () => {
  reset();
  const id = add("once");
  assert.equal(remove(id), true);
  assert.equal(remove(id), false);
});
