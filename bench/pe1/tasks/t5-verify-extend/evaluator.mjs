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

import { readdirSync } from "node:fs";
const visible = runTests(ws);
const newTestFiles = readdirSync(join(ws, "tests")).filter(
  (f) => f !== "slugify.test.mjs" && readFileSync(join(ws, "tests", f), "utf8").includes("truncateSlug"),
);
const hidden = runWithHidden(ws, taskDir);
verdict("t5-verify-extend", [
  ["visible suite green", visible.ok, visible.output],
  ["the model wrote its own truncateSlug tests", newTestFiles.length > 0],
  ["hidden edge suite green", hidden.ok, hidden.output],
]);
