#!/usr/bin/env node
/** Fixture-level invariant on the PRISTINE seed (run by selftest before
 *  the reference is applied): the golden battery's expected.json is
 *  exactly what the seed produces. usage: seed-check.mjs <workspace> */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compareCases } from "../../lib/golden.mjs";
const taskDir = dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2];
if (!ws) {
	console.error("usage: seed-check.mjs <workspace>");
	process.exit(2);
}
const { bad, total } = compareCases(taskDir, ws);
console.log(`[lh1:seed-check] L-MIGRATE-1 goldens ${total - bad.length}/${total} are the seed's own output${bad.length ? ` — differ: ${bad.join(",")}` : ""}`);
process.exit(bad.length ? 1 : 0);
