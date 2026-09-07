import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runTests, runWithHidden, changedSinceSeed, outsideAllowed, unchangedSinceSeed, readJson, verdict } from "../../lib/eval-kit.mjs";
import { compareCases } from "../../lib/golden.mjs";

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
const frozenUntouched = ["SPEC.md", "package.json", "docs/CHANGELOG.md"].every((p) => unchangedSinceSeed(ws, p));

// the completeness scan — zero stragglers, by a mechanical assertion over every rule file
const V1_KEYS = ["severity", "when", "deprecated", "pattern", "message"];
const stragglers = [];
const ids = [];
for (const name of readdirSync(join(ws, "rules")).filter((f) => f.endsWith(".json")).sort()) {
	let data;
	try {
		data = JSON.parse(readFileSync(join(ws, "rules", name), "utf8"));
	} catch {
		stragglers.push(`${name}: invalid JSON`);
		continue;
	}
	ids.push(name.slice(0, -5));
	if (data.schema !== 2) stragglers.push(`${name}: schema ${JSON.stringify(data.schema)}`);
	for (const k of V1_KEYS) if (Object.hasOwn(data, k)) stragglers.push(`${name}: ${k}`);
	if (typeof data.enabled !== "boolean") stragglers.push(`${name}: enabled ${JSON.stringify(data.enabled)}`);
}

// the semantics truth: the ORIGINAL tree's loader over the ORIGINAL rules, against the
// workspace's loader over the workspace's rules — rule for rule, canonical JSON
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const dump = (root) =>
	execFileSync(
		process.execPath,
		["--input-type=module", "-e", `import { loadRules } from ${JSON.stringify(join(root, "src", "loader.mjs"))}; process.stdout.write(JSON.stringify(loadRules(${JSON.stringify(join(root, "rules"))})));`],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
	);
const seedDir = mkdtempSync(join(tmpdir(), "lh1-seed-"));
execFileSync("sh", ["-c", `git -C ${JSON.stringify(ws)} archive seed | tar -x -C ${JSON.stringify(seedDir)}`], { stdio: "ignore" });
let seedRules;
let wsRules;
let semanticsDetail = "";
try {
	seedRules = JSON.parse(dump(seedDir));
	wsRules = JSON.parse(dump(ws));
} catch (err) {
	semanticsDetail = String(err.stderr ?? err.message).slice(0, 300);
}
rmSync(seedDir, { recursive: true, force: true });
const seedIds = seedRules ? seedRules.map((r) => r.id) : [];
const idsUnchanged = seedRules !== undefined && JSON.stringify(ids) === JSON.stringify(seedIds);
let semanticsSame = false;
if (seedRules && wsRules) {
	const a = JSON.stringify(canonical(seedRules));
	const b = JSON.stringify(canonical(wsRules));
	semanticsSame = a === b;
	if (!semanticsSame) {
		const bad = seedRules.filter((r, i) => JSON.stringify(canonical(r)) !== JSON.stringify(canonical(wsRules[i]))).map((r) => r.id);
		semanticsDetail = `differ: ${bad.join(",") || "count/order"}`;
	}
}

const docs = existsSync(join(ws, "docs", "RULE-FORMAT.md")) ? readFileSync(join(ws, "docs", "RULE-FORMAT.md"), "utf8") : "";
const docsOk = docs.includes('"schema": 2') && !['"severity"', '"when"'].some((s) => docs.includes(s));
const visible = runTests(ws);
const golden = compareCases(taskDir, ws);
const hidden = runWithHidden(ws, taskDir);
verdict("L-MIGRATE-1", [
	["tests/ untouched since seed", testsUntouched, changedSinceSeed(ws, "tests/").join(",")],
	["fixtures/ untouched since seed", fixturesUntouched, changedSinceSeed(ws, "fixtures/").join(",")],
	["every changed path under rules/**, src/**, scripts/**, docs/RULE-FORMAT.md or README.md", offenders.length === 0, offenders.join(",")],
	["SPEC.md, package.json, docs/CHANGELOG.md byte-identical", frozenUntouched, "changed"],
	["completeness: every rule file is schema 2 with no v1 key (zero stragglers)", stragglers.length === 0, stragglers.join("; ")],
	[`the set of rule ids is unchanged (${seedIds.length})`, idsUnchanged, `${ids.length} files`],
	["loadRules over the tree equals the original's, rule for rule", semanticsSame, semanticsDetail],
	["docs/RULE-FORMAT.md documents version 2 and neither \"severity\" nor \"when\"", docsOk, "docs"],
	["visible suite green (byte-untouched)", visible.ok, visible.output],
	[`golden battery byte-identical to the seed (${golden.total} cases)`, golden.bad.length === 0, golden.bad.join(",")],
	["hidden suite green (loader, validator messages, scaffold)", hidden.ok, hidden.output],
]);
