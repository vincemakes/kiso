#!/usr/bin/env node
/**
 * EX-0 verifier selftest — the verifier's own red/green. An
 * experience-binding checker that cannot tell a bound experience from
 * an unbound one certifies nothing (the RD-1/PE-1 selftest law, one
 * layer up). Each case builds a tiny experience + evidence slice in a
 * temp dir and asserts the verifier's verdict.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER = join(HERE, "verifier.mjs");
let bad = 0;
const check = (name, ok) => { if (!ok) bad += 1; console.log(`[ex0:selftest] ${ok ? "ok " : "RED"} — ${name}`); };

function runCase(exp, slices) {
	const tmp = mkdtempSync(join(tmpdir(), "ex0-"));
	mkdirSync(join(tmp, "experiences"));
	mkdirSync(join(tmp, "evidence"));
	writeFileSync(join(tmp, "experiences", `${exp.id}.json`), JSON.stringify(exp));
	for (const [name, ev] of Object.entries(slices)) writeFileSync(join(tmp, "evidence", name), JSON.stringify(ev));
	let code = 0;
	try {
		execFileSync(process.execPath, [VERIFIER, join(tmp, "experiences"), join(tmp, "evidence")], { stdio: "pipe" });
	} catch {
		code = 1;
	}
	rmSync(tmp, { recursive: true, force: true });
	return code;
}

const goodSlice = { events: [] }; // 0 task_set events
const good = {
	id: "BE-T1", assertion: "a bound experience",
	boundEvidence: [{ slice: "evidence/s.json", source: "x",
		predicate: { kind: "event_count", name: "task_set", type: "tool_execution_started", op: "==", value: 0 } }],
	support: { n: 1, of: 1 }, scope: { model: "m" }, antiEvidence: [],
	validity: { status: "corroborated" },
};
check("a fully-bound experience PASSES", runCase(good, { "s.json": goodSlice }) === 0);

// ① binding fails: the slice contradicts the predicate (1 task_set, want 0)
const contra = { events: [{ name: "task_set", type: "tool_execution_started", seq: 1 }] };
check("a predicate the evidence contradicts is UNBOUND", runCase(good, { "s.json": contra }) === 1);

// ② no scope → rejected (model-specific may not become universal)
check("an experience with NO scope is UNBOUND", runCase({ ...good, scope: {} }, { "s.json": goodSlice }) === 1);

// ③ no validity → rejected (a correct experience that outlives its world is poison)
const noVal = { ...good }; delete noVal.validity;
check("an experience with NO validity is UNBOUND", runCase(noVal, { "s.json": goodSlice }) === 1);

// ④ un-checkable predicate kind → rejected (an un-checkable binding is no binding)
const badPred = { ...good, boundEvidence: [{ slice: "evidence/s.json", source: "x", predicate: { kind: "vibes" } }] };
check("an un-checkable predicate is UNBOUND", runCase(badPred, { "s.json": goodSlice }) === 1);

// ⑤ empty boundEvidence → rejected (unbound by definition)
check("an experience with NO boundEvidence is UNBOUND", runCase({ ...good, boundEvidence: [] }, {}) === 1);

// ⑥ missing antiEvidence field → rejected (a record with no counter-evidence slot is a bias incubator)
const noAnti = { ...good }; delete noAnti.antiEvidence;
check("an experience missing the antiEvidence field is UNBOUND", runCase(noAnti, { "s.json": goodSlice }) === 1);

console.log(`[ex0:selftest] ${bad === 0 ? "PASS" : "FAIL"} — ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
