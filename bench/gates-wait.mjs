#!/usr/bin/env node
/**
 * gates-wait.mjs <round-dir> [--legs=N] — the 0.47.0 kit's wait probes (§6),
 * read from every non-void W1 / W2 leg's own records (tasks-counters.mjs,
 * always recomputed). rc only: the control has no `wait`.
 *
 *   every leg    verify pass · waits.fired ≥ 2 · waits.expired + failed 0 ·
 *                sleepCalls 0 · waitOnWait 0 · subSecondTimers 0
 *   W1           wakes ≥ 2 · chainLen ≥ 2 — a chain of autonomous wakes
 *   W2           wakes ≥ 1 (one idle crossing proves the path; whether the
 *                second conclusion lands idle or in the live run is the
 *                provider's latency, not product correctness) · ghShellCalls 0
 *
 * `--legs=N`: each of W1 and W2 must have exactly N valid legs — the
 * registered n is a machine gate here too; fewer is INVALID, not a pass.
 * Reported, never gated: wakeColdPrefix, wakeRequests, emptyPromises.
 *
 * Exit: 0 every gate passes; 1 a gate blocks; 2 the probe did not measure
 * (no legs, or not the registered number of valid legs).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";
import { counters } from "./tasks-counters.mjs";

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);

export function gates(root, expectLegs = undefined) {
	const out = { legs: [], blocks: [], instrument: [], reported: {} };
	const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^kiso-W[12]-rc/.test(d)).sort() : [];
	const valid = { W1: 0, W2: 0 };
	for (const d of dirs) {
		const w = join(root, d);
		if (existsSync(join(w, "void"))) continue;
		const task = d.slice(5, 7);
		valid[task] += 1;
		const c = counters(w);
		const verify = read(join(w, "verify"));
		const fails = [];
		if (verify !== "pass") fails.push(`verify ${verify ?? "missing"}`);
		if (c.waits.fired < 2) fails.push(`waits.fired ${c.waits.fired} < 2`);
		if (c.waits.expired + c.waits.failed > 0) fails.push(`expired ${c.waits.expired} + failed ${c.waits.failed} > 0`);
		if (c.sleepCalls > 0) fails.push(`sleepCalls ${c.sleepCalls}`);
		if (c.waitOnWait > 0) fails.push(`waitOnWait ${c.waitOnWait}`);
		if (c.subSecondTimers > 0) fails.push(`subSecondTimers ${c.subSecondTimers}`);
		if (task === "W1" && c.wakes < 2) fails.push(`wakes ${c.wakes} < 2`);
		if (task === "W1" && c.chainLen < 2) fails.push(`chainLen ${c.chainLen} < 2`);
		if (task === "W2" && c.wakes < 1) fails.push(`wakes ${c.wakes} < 1`);
		if (task === "W2" && c.ghShellCalls > 0) fails.push(`ghShellCalls ${c.ghShellCalls}`);
		out.legs.push({ leg: d, pass: fails.length === 0, fails, wakes: c.wakes, chainLen: c.chainLen, wakeColdPrefix: c.wakeColdPrefix, wakeRequests: c.wakeRequests, emptyPromises: c.emptyPromises });
		for (const f of fails) out.blocks.push(`${d}: ${f}`);
	}
	if (dirs.length === 0) out.instrument.push(`no W1/W2 rc legs under ${root}`);
	if (expectLegs !== undefined) for (const t of ["W1", "W2"]) if (valid[t] !== expectLegs) out.instrument.push(`${t}: ${valid[t]} valid legs, ${expectLegs} registered — INVALID, run the missing legs`);
	out.reported.validLegs = valid;
	return out;
}

function main(argv) {
	const root = argv[0];
	if (!root) {
		console.error("usage: gates-wait.mjs <round-dir> [--legs=N]");
		process.exit(2);
	}
	const legsArg = argv.find((a) => a.startsWith("--legs="));
	const out = gates(root, legsArg === undefined ? undefined : Number(legsArg.slice(7)));
	console.log(JSON.stringify(out, null, 1));
	process.exit(out.instrument.length > 0 ? 2 : out.blocks.length > 0 ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
