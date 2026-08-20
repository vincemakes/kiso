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
const verbose = probe(ws, ["bin/tool.mjs", "--config", "fixtures/app.json", "--verbose"]);
const quiet = probe(ws, ["bin/tool.mjs", "--config", "fixtures/app.json"]);
verdict("t3-trap", [
  ["visible suite green", visible.ok, visible.output],
  ["--verbose exits 0", verbose.code === 0, `code ${verbose.code} stderr ${verbose.stderr}`],
  ["--verbose stderr is exactly the documented line", verbose.stderr === "config loaded from fixtures/app.json\n", JSON.stringify(verbose.stderr)],
  ["--verbose stdout unchanged", verbose.stdout === "hello, pe1\n", JSON.stringify(verbose.stdout)],
  ["without the flag stderr stays empty", quiet.code === 0 && quiet.stderr === "" && quiet.stdout === "hello, pe1\n", JSON.stringify({ code: quiet.code, stderr: quiet.stderr, stdout: quiet.stdout })],
]);
