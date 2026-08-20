import test from "node:test";
import assert from "node:assert/strict";
import { add, list, reset } from "../src/store.mjs";
import { fmtHelper } from "./helpers/fmt.mjs";

test("add + list round-trips", () => {
  reset();
  add("alpha");
  add("beta");
  assert.equal(fmtHelper(list()), "#1 alpha|#2 beta");
});
