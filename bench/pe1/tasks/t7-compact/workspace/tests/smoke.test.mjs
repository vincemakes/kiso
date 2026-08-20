import test from "node:test";
import assert from "node:assert/strict";
import { status1 } from "../src/mod1.mjs";

test("modules load", () => {
  assert.ok(["draft", "final"].includes(status1()));
});
