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

const visible = runTests(ws);
const hidden = runWithHidden(ws, taskDir);
verdict("t4-recovery", [
  ["suite green (environment healed + feature landed)", visible.ok, visible.output],
  ["hidden remove() semantics green", hidden.ok, hidden.output],
]);
