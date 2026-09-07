import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runTests, runWithHidden, changedSinceSeed, outsideAllowed, unchangedSinceSeed, readJson, verdict } from "../../lib/eval-kit.mjs";

const taskDir = dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2];
if (!ws) {
	console.error("usage: evaluator.mjs <workspaceDir>");
	process.exit(2);
}
const expected = readJson(join(taskDir, "expected.json"));
const testsUntouched = changedSinceSeed(ws, "tests/").length === 0;
const offenders = outsideAllowed(ws, expected.allowed);
const specUntouched = unchangedSinceSeed(ws, "SPEC.md");
const visible = runTests(ws);
// probes run BEFORE the hidden injection changes nothing in src/
const cli = join(ws, "src", "cli.mjs");
const dir = mkdtempSync(join(tmpdir(), "lh1-eval-"));
const usdJournal = join(dir, "usd.txt");
writeFileSync(usdJournal, "2026-01-05 | assets:cash | 12.50 | a\n2026-01-06 | expenses:food | -3.25 | b\n");
const balance = spawnSync(process.execPath, [cli, "balance", usdJournal], { encoding: "utf8" });
const usdBalanceIdentical = balance.status === 0 && balance.stdout === "assets:cash  12.50\nexpenses:food  -3.25\n";
const eurJournal = join(dir, "eur.txt");
writeFileSync(eurJournal, "2026-01-05 | assets:cash | 12.50 | a | EUR\n");
const rates = join(dir, "rates.txt");
writeFileSync(rates, "GBP USD 1.25\n");
const fx = spawnSync(process.execPath, [cli, "fx", eurJournal, "--base", "USD", "--rates", rates], { encoding: "utf8" });
const missingRateExit4 = fx.status === 4 && /no rate/.test(fx.stderr);
const hidden = runWithHidden(ws, taskDir);
verdict("L-IMPL-1", [
	["tests/ untouched since seed", testsUntouched, changedSinceSeed(ws, "tests/").join(",")],
	["every changed path under src/** or README.md", offenders.length === 0, offenders.join(",")],
	["SPEC.md byte-identical", specUntouched, "SPEC.md changed"],
	["visible suite green", visible.ok, visible.output],
	["USD-only `balance` byte-identical to seed", usdBalanceIdentical, `${balance.status} ${JSON.stringify(balance.stdout)}`],
	["`fx` with a missing rate exits 4", missingRateExit4, `${fx.status} ${fx.stderr}`],
	["hidden suite green", hidden.ok, hidden.output],
]);
