#!/usr/bin/env node
/**
 * gates-0460b.mjs <round-root> — the eval-0460b gates that read legs, not
 * pairs (kiso-doc plan-0460-fix-b1-b2 §4). The paired verdicts stay with
 * paired-compare.mjs; this reads every non-void leg's own records through
 * tasks-counters.mjs (always recomputed, never a stale counters.json).
 *
 *   L2, every rc leg       verify pass, postFinalRequests 0 (0460-I4), readyRace 0 (0460-I5)
 *   F1b, every rc leg      ENGAGED when it started at least one background child; an engaged
 *                          leg passes with verify pass, every child named in exactly one
 *                          notice (groups.deliveredOnce) and no child left running.
 *                          A leg that never fanned out measured nothing: it is reported,
 *                          and fewer than PROBE_MIN_ENGAGED (4) engaged legs is an
 *                          instrument failure, not a pass.
 *
 * Exit: 0 every gate passes; 1 a gate blocks; 2 the probe did not measure
 * (no legs, or too few engaged). The JSON on stdout carries F1b's reported
 * figures (D6's child requests, groups, wakes, polls).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";
import { counters } from "./tasks-counters.mjs";

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : null);

const percentile = (xs, p) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function gates(root, minEngaged = Number(process.env.PROBE_MIN_ENGAGED ?? 4)) {
	const legs = existsSync(root) ? readdirSync(root).filter((d) => /^kiso-(L2|F1b)-rc/.test(d)) : [];
	const out = { l2: [], f1b: [], blocks: [], instrument: [], f1bReported: null };
	for (const d of legs.sort()) {
		const w = join(root, d);
		if (existsSync(join(w, "void"))) continue;
		const c = counters(w);
		const verify = read(join(w, "verify"));
		if (d.startsWith("kiso-L2-")) {
			const row = { leg: d, verify, postFinalRequests: c.postFinalRequests, readyRace: c.readyRace };
			row.pass = verify === "pass" && c.postFinalRequests === 0 && c.readyRace === 0;
			out.l2.push(row);
			if (!row.pass) out.blocks.push(`${d}: verify ${verify}, postFinalRequests ${c.postFinalRequests}, readyRace ${c.readyRace}`);
		} else {
			const engaged = c.children.count > 0;
			const row = { leg: d, verify, engaged, children: c.children.count, deliveredOnce: c.groups.deliveredOnce, leftRunning: c.children.leftRunning, counters: c };
			row.pass = engaged ? verify === "pass" && c.groups.deliveredOnce === true && c.children.leftRunning === 0 : null;
			out.f1b.push(row);
			if (row.pass === false) out.blocks.push(`${d}: verify ${verify}, deliveredOnce ${c.groups.deliveredOnce}, leftRunning ${c.children.leftRunning}`);
		}
	}
	const engaged = out.f1b.filter((r) => r.engaged);
	if (out.f1b.length > 0 && engaged.length < minEngaged) out.instrument.push(`F1b: ${engaged.length} of ${out.f1b.length} legs fanned out (at least ${minEngaged} needed)`);
	if (out.l2.length === 0 && out.f1b.length === 0) out.instrument.push("no L2 or F1b rc legs under the round root");
	if (engaged.length > 0) {
		const requests = engaged.flatMap((r) => r.counters.children.requests);
		out.f1bReported = {
			engagedLegs: engaged.length,
			childRequests: { p50: percentile(requests, 50), p90: percentile(requests, 90), max: Math.max(...requests) },
			budgetExhausted: engaged.reduce((n, r) => n + r.counters.children.budgetSpent, 0),
			membersPerGroup: engaged.flatMap((r) => r.counters.groups.members),
			groupDeliveries: engaged.map((r) => r.counters.groups.deliveries),
			wakes: engaged.map((r) => r.counters.wakes),
			wakeRequests: engaged.map((r) => r.counters.wakeRequests),
			sleepCalls: engaged.reduce((n, r) => n + r.counters.sleepCalls, 0),
			outputPolls: engaged.reduce((n, r) => n + r.counters.outputPolls, 0),
		};
	}
	for (const r of out.f1b) delete r.counters;
	out.verdict = out.blocks.length > 0 ? "BLOCK" : out.instrument.length > 0 ? "NOT MEASURED" : "PASS";
	return out;
}

if (isMain(import.meta.url)) {
	const g = gates(process.argv[2]);
	console.log(JSON.stringify(g, null, 1));
	process.exit(g.verdict === "BLOCK" ? 1 : g.verdict === "NOT MEASURED" ? 2 : 0);
}
