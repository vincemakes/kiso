import test from "node:test";
import assert from "node:assert/strict";
import { allFinal } from "../src/index.mjs";
import { status1 } from "../src/mod1.mjs";
import { status4 } from "../src/mod4.mjs";
import { status6 } from "../src/mod6.mjs";

test("hidden: every module is final and the aggregate agrees", () => {
  assert.equal(status1(), "final");
  assert.equal(status4(), "final");
  assert.equal(status6(), "final");
  assert.equal(allFinal(), true);
});
