// Run proofs as their own processes; the exit code is the verdict. Output goes to the terminal and to
// ~/kiso-worktrees/desktop-proofs.log.   node scripts/proofs/all.mjs fast | full | name ...
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fast: no Electron, no kill -9 (a few seconds to a minute); full: everything, for the end of a milestone, before a push, before a release
const FAST = ["guard", "stream", "stream default", "model", "usage", "policy", "control", "tasks"];
const FULL = [...FAST, "crash", "stream-ui", "electron", "electron main", "interrupt"];
const log = join(process.env.HOME, "kiso-worktrees", "desktop-proofs.log");
writeFileSync(log, "");
const arg = process.argv[2] ?? "fast";
const PROOFS = arg === "fast" ? FAST : arg === "full" ? FULL : FULL.filter((e) => process.argv.slice(2).includes(e.split(" ")[0]));
let failed = 0;
for (const entry of PROOFS) {
	const [name, ...args] = entry.split(" ");
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), ...args], { encoding: "utf8" });
	appendFileSync(log, `## ${entry}\n${r.stdout}${r.stderr}\n`);
	if (r.status !== 0) failed += 1;
	console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${entry.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(failed === 0 ? "all proofs pass" : `${failed} proof(s) failed (see ${log})`);
process.exit(failed === 0 ? 0 : 1);
