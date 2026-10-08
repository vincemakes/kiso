#!/usr/bin/env node
/**
 * gates-chain.mjs <round-dir> [--legs=N] — S-chain, the 0.48.0 kit's direct
 * test of the chain budget (ADR-0058 Amendment 9): two rounds of background
 * subagents, the second started inside the wake run the first one's end
 * caused. Reads every non-void S2 leg's own records (tasks-counters.mjs).
 *
 *   rc legs (gated)   verify pass (all six answers, the repo unchanged) ·
 *                     groups.count >= 2 · every child delivered exactly once
 *                     (groups.deliveredOnce) · wakes >= 2 (BOTH groups' ends
 *                     woke the session; the second is the one lineage depth 1
 *                     refused) · no child left running
 *   ctl legs          the same numbers, REPORTED, never gating: the control
 *                     still has depth 1, so its second group's end notifies
 *                     instead of waking and the leg idles out without
 *                     answers 4-6. A control leg that passes every rc gate
 *                     means the premise is wrong — an instrument failure.
 *
 * `--legs=N`: the rc arm must have exactly N valid legs (the registered n).
 * Exit: 0 every rc gate passes; 1 a gate blocks; 2 the round did not
 * measure (no rc legs, not N, or a control leg passed — the premise).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../scripts/is-main.mjs";
import { counters } from "./tasks-counters.mjs";

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);

function judge(w) {
	const c = counters(w);
	const verify = read(join(w, "verify"));
	const fails = [];
	if (verify !== "pass") fails.push(`verify ${verify ?? "missing"}`);
	if (c.groups.count < 2) fails.push(`groups ${c.groups.count} < 2`);
	if (c.groups.deliveredOnce !== true) fails.push(`deliveredOnce ${c.groups.deliveredOnce}`);
	if (c.wakes < 2) fails.push(`wakes ${c.wakes} < 2`);
	if (c.children.leftRunning > 0) fails.push(`children left running ${c.children.leftRunning}`);
	return { fails, wakes: c.wakes, groups: c.groups.count, members: c.groups.members, children: c.children.count, verify };
}

export function gates(root, expectLegs = undefined) {
	const out = { rc: [], ctl: [], blocks: [], instrument: [] };
	const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^kiso-S2-(rc|ctl)/.test(d)).sort() : [];
	for (const d of dirs) {
		const w = join(root, d);
		if (existsSync(join(w, "void"))) continue;
		const arm = /^kiso-S2-rc/.test(d) ? "rc" : "ctl";
		const j = judge(w);
		out[arm].push({ leg: d, pass: j.fails.length === 0, ...j });
		if (arm === "rc") for (const f of j.fails) out.blocks.push(`${d}: ${f}`);
		else if (j.fails.length === 0) out.instrument.push(`${d}: the control passed every rc gate — the premise (lineage depth 1 stops the second wake) is wrong; stop the round for a finding`);
	}
	if (out.rc.length === 0) out.instrument.push(`no S2 rc legs under ${root}`);
	if (expectLegs !== undefined && out.rc.length !== expectLegs) out.instrument.push(`S2: ${out.rc.length} valid rc legs, ${expectLegs} registered — INVALID, run the missing legs`);
	return out;
}

function main(argv) {
	const root = argv[0];
	if (!root) {
		console.error("usage: gates-chain.mjs <round-dir> [--legs=N]");
		process.exit(2);
	}
	const legsArg = argv.find((a) => a.startsWith("--legs="));
	const out = gates(root, legsArg === undefined ? undefined : Number(legsArg.slice(7)));
	console.log(JSON.stringify(out, null, 1));
	process.exit(out.instrument.length > 0 ? 2 : out.blocks.length > 0 ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
