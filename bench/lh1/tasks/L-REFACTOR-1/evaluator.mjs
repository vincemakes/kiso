import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runTests, runWithHidden, changedSinceSeed, outsideAllowed, unchangedSinceSeed, readJson, verdict } from "../../lib/eval-kit.mjs";
import { compareCases } from "./golden/run-cases.mjs";

const taskDir = dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2];
if (!ws) {
	console.error("usage: evaluator.mjs <workspaceDir>");
	process.exit(2);
}
const expected = readJson(join(taskDir, "expected.json"));
const testsUntouched = changedSinceSeed(ws, "tests/").length === 0;
const fixturesUntouched = changedSinceSeed(ws, "fixtures/").length === 0;
const offenders = outsideAllowed(ws, expected.allowed);
const frozenUntouched = unchangedSinceSeed(ws, "SPEC.md") && unchangedSinceSeed(ws, "package.json");
const oldModules = ["src/summary.mjs", "src/top.mjs", "src/export.mjs", "src/util.mjs"].filter((p) => existsSync(join(ws, p)));
const readme = existsSync(join(ws, "README.md")) ? readFileSync(join(ws, "README.md"), "utf8") : "";
const visible = runTests(ws);
// the behavior-preservation truth: the seed's own outputs, byte for byte,
// on more inputs than the visible suite shows (including every error path)
const golden = compareCases(ws);
const hidden = runWithHidden(ws, taskDir);
verdict("L-REFACTOR-1", [
	["tests/ untouched since seed", testsUntouched, changedSinceSeed(ws, "tests/").join(",")],
	["fixtures/ untouched since seed", fixturesUntouched, changedSinceSeed(ws, "fixtures/").join(",")],
	["every changed path under src/** or README.md", offenders.length === 0, offenders.join(",")],
	["SPEC.md and package.json byte-identical", frozenUntouched, "changed"],
	["visible suite green (byte-untouched)", visible.ok, visible.output],
	[`golden battery byte-identical to the seed (${golden.total} cases)`, golden.bad.length === 0, golden.bad.join(",")],
	["old modules removed", oldModules.length === 0, oldModules.join(",")],
	["README has a Modules section", /^## Modules\s*$/m.test(readme), "no `## Modules` heading"],
	["hidden suite green (layout invariants, purity)", hidden.ok, hidden.output],
]);
