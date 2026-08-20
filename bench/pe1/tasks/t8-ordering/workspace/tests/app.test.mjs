import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("the app runs", () => {
  const out = execFileSync(process.execPath, ["bin/app.mjs"], { encoding: "utf8" });
  assert.ok(out.length > 0);
});
