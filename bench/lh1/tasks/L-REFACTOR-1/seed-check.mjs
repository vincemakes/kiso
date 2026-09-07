#!/usr/bin/env node
/** Fixture-level invariant on the PRISTINE seed (run by selftest before
 *  the reference is applied): the golden battery's expected.json is
 *  exactly what the seed produces. A golden that drifted from the seed
 *  would score behavior nobody specified. usage: seed-check.mjs <workspace> */
import { compareCases } from "./golden/run-cases.mjs";
const ws = process.argv[2];
if (!ws) {
	console.error("usage: seed-check.mjs <workspace>");
	process.exit(2);
}
const { bad, total } = compareCases(ws);
console.log(`[lh1:seed-check] L-REFACTOR-1 goldens ${total - bad.length}/${total} are the seed's own output${bad.length ? ` — differ: ${bad.join(",")}` : ""}`);
process.exit(bad.length ? 1 : 0);
