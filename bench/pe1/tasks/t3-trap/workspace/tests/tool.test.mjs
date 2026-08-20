import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("the tool greets from the config", () => {
  const out = execFileSync(process.execPath, ["bin/tool.mjs", "--config", "fixtures/app.json"], { encoding: "utf8" });
  assert.equal(out.trim(), "hello, pe1");
});
