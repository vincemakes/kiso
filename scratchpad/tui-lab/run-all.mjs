#!/usr/bin/env node
/**
 * Run all five lab scenarios; exit 1 on any failure.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scenarios = ["01-startup-first-frame", "02-logo-rows", "03-no-same-row-dupes", "04-approval-slot", "05-no-concatenated-lines"];

let failed = 0;
for (const s of scenarios) {
	try {
		execFileSync(process.execPath, [join(here, "scenarios", `${s}.mjs`)], { stdio: "inherit", timeout: 150_000 });
	} catch {
		failed += 1;
	}
}
if (failed > 0) {
	console.error(`\n${failed}/${scenarios.length} scenarios FAILED`);
	process.exit(1);
}
console.log("\nall 5 lab scenarios passed");
