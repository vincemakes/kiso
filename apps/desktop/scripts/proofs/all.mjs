// Run proofs as their own processes; the exit code is the verdict. Output goes to the terminal and to a log file:
// KISO_DESKTOP_PROOF_LOG, else kiso-desktop-proofs.log in the temporary directory (not written if it cannot be).
//   node scripts/proofs/all.mjs fast | full | name ...
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fast: no Electron, no kill -9 (a few seconds to a minute); full: everything, for the end of a milestone, before a push, before a release
const FAST = ["guard", "history", "desk", "files", "panels", "settings", "stream", "stream default", "model", "usage", "policy", "control", "tasks"];
const FULL = [...FAST, "crash", "stream-ui", "sidebar-ui", "rail-ui", "panels-ui", "layout-ui", "home-ui", "unadmitted", "electron", "electron main", "electron packaged", "interrupt"];
const log = process.env.KISO_DESKTOP_PROOF_LOG ?? join(tmpdir(), "kiso-desktop-proofs.log");
/** Append to the log (or start it); false when it cannot be written: no log is better than no proofs. */
const save = (text, fresh = false) => { try { mkdirSync(dirname(log), { recursive: true }); (fresh ? writeFileSync : appendFileSync)(log, text); return true; } catch { return false; } };
const arg = process.argv[2] ?? "fast";
const PROOFS = arg === "fast" ? FAST : arg === "full" ? FULL : FULL.filter((e) => process.argv.slice(2).includes(e.split(" ")[0]));
let failed = 0;
const logging = save("", true);
for (const entry of PROOFS) {
	const [name, ...args] = entry.split(" ");
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), ...args], { encoding: "utf8" });
	if (logging) save(`## ${entry}\n${r.stdout}${r.stderr}\n`);
	if (r.status !== 0) (failed += 1, !logging && console.log(`${r.stdout}${r.stderr}`));
	console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${entry.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(failed === 0 ? "all proofs pass" : `${failed} proof(s) failed (see ${logging ? log : "the output above"})`);
process.exit(failed === 0 ? 0 : 1);
