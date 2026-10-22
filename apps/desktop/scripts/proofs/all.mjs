// Run every proof as its own process; the exit code is the verdict.
//   node scripts/proofs/all.mjs [name ...]     (default: all)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROOFS = [
	["guard", []],
	["stream", []],
	["stream", ["default"]],
	["thinking", []],
	["usage", []],
	["policy", []],
	["control", []],
	["tasks", []],
	["crash", []],
	["electron", []],
	["electron", ["main"]],
	["host-process", []],
];
const only = process.argv.slice(2);
let failed = 0;
for (const [name, args] of PROOFS) {
	if (only.length > 0 && !only.includes(name)) continue;
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), ...args], { stdio: ["ignore", "ignore", "inherit"] });
	const ok = r.status === 0;
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${[name, ...args].join(" ").padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(failed === 0 ? "all proofs pass" : `${failed} proof(s) failed`);
process.exit(failed === 0 ? 0 : 1);
