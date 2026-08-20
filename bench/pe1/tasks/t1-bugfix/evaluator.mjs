import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runTests, runWithHidden, changedSinceSeed, probe, grepTree, verdict } from "../../lib/eval-kit.mjs";

const taskDir = dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2];
if (!ws) {
  console.error("usage: evaluator.mjs <workspaceDir>");
  process.exit(2);
}

const testsUntouched = changedSinceSeed(ws, "tests/").length === 0;
const visible = runTests(ws);
const hidden = runWithHidden(ws, taskDir);
verdict("t1-bugfix", [
  ["tests/ untouched since seed", testsUntouched, changedSinceSeed(ws, "tests/").join(",")],
  ["visible suite green", visible.ok, visible.output],
  ["hidden edge suite green", hidden.ok, hidden.output],
]);
