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
const oldGone = !existsSync(join(ws, "src/basket.mjs"));
const newThere = existsSync(join(ws, "src/cart.mjs"));
const noOldName = grepTree(ws, "src", "basket").length === 0;
const visible = runTests(ws);
verdict("t2-refactor", [
  ["tests/ untouched since seed", testsUntouched, changedSinceSeed(ws, "tests/").join(",")],
  ["src/basket.mjs is gone", oldGone],
  ["src/cart.mjs exists", newThere],
  ["no 'basket' remains under src/", noOldName, grepTree(ws, "src", "basket").join(",")],
  ["suite green through the stable factory", visible.ok, visible.output],
]);
