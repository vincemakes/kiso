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

import { writeFileSync } from "node:fs";
const visible = runTests(ws);
const def = probe(ws, ["bin/app.mjs"]);
const cfgPath = join(ws, "config.json");
const original = readFileSync(cfgPath, "utf8");
writeFileSync(cfgPath, JSON.stringify({ logLevel: "warn" }) + "\n");
const silenced = probe(ws, ["bin/app.mjs"]);
writeFileSync(cfgPath, original);
const loggerSrc = existsSync(join(ws, "src/logger.mjs")) ? readFileSync(join(ws, "src/logger.mjs"), "utf8") : "";
const binSrc = readFileSync(join(ws, "bin/app.mjs"), "utf8");
verdict("t8-ordering", [
  ["visible suite green", visible.ok, visible.output],
  ["default run greets at info level", def.code === 0 && def.stdout === "[info] hello from app\n", JSON.stringify(def.stdout)],
  ["logLevel=warn silences the greeting (CLI goes through the logger)", silenced.code === 0 && silenced.stdout === "", JSON.stringify(silenced.stdout)],
  ["logger reads the config module", loggerSrc.includes("config.mjs")],
  ["the CLI logs through the logger and never reads config.json itself", binSrc.includes("logger.mjs") && !binSrc.includes("config.json")],
]);
