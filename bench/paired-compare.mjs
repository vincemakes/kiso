#!/usr/bin/env node
/**
 * BM-1 — the paired verdict (the blocker since 0.12.0).
 *
 * The interleave runs rc+control in matched pairs; common-mode provider
 * drift hits both arms of a pair, so the per-pair RELATIVE delta is the
 * regression signal and the absolute band demotes to an anomaly
 * detector (reported, never blocking). Findings TUI2-B1/B2 are the
 * evidence record behind this amendment.
 *
 *   node paired-compare.mjs <rc.json> <ctl.json> [--causal=ui|request|execution|provider]
 *
 * Inputs are extractor row arrays; rows pair by (task, run). The
 * criteria are FROZEN (BM-1, margins derived from the n=8 historical
 * pairs, provisional until the 0.13.0 re-derivation — never tuned to
 * the round under judgment):
 *   verify 100% · median(d_cost) <= +6% · max pair <= +50% ·
 *   median(d_wall) <= +25%,  where d = (rc - ctl) / ctl.
 *
 * The causal tier decides whether a FAIL blocks the release or is
 * informational (BM-1 §3); the tier comes from the round spec's
 * declared change surface.
 */
import { readFileSync } from "node:fs";

const ALIAS = { costWeighted: "cost_weighted" };
function norm(r) {
	for (const [camel, snake] of Object.entries(ALIAS)) {
		if (r[camel] === undefined && r[snake] !== undefined) r[camel] = r[snake];
	}
	return r;
}
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function pairedVerdict(rcRows, ctlRows) {
	const key = (r) => `${r.task}-${r.run}`;
	const ctl = new Map(ctlRows.map(norm).map((r) => [key(r), r]));
	const pairs = [];
	for (const r of rcRows.map(norm)) {
		const c = ctl.get(key(r));
		if (c) pairs.push({ id: key(r), rc: r, ctl: c });
	}
	const dCost = pairs.map((p) => (p.rc.costWeighted - p.ctl.costWeighted) / p.ctl.costWeighted);
	const dWall = pairs.map((p) => (p.rc.wall - p.ctl.wall) / p.ctl.wall);
	const verifies = pairs.flatMap((p) => [p.rc.verify, p.ctl.verify]);
	const criteria = {
		verifyAllPass: verifies.every((v) => v === "pass"),
		medianCost: median(dCost),
		medianCostOk: median(dCost) <= 0.06,
		maxPair: Math.max(...dCost),
		maxPairOk: Math.max(...dCost) <= 0.5,
		medianWall: median(dWall),
		medianWallOk: median(dWall) <= 0.25,
	};
	const pass = criteria.verifyAllPass && criteria.medianCostOk && criteria.maxPairOk && criteria.medianWallOk;
	return {
		method: "BM-1 paired (frozen margins, provisional until 0.13.0)",
		pairs: pairs.map((p, i) => ({
			id: p.id,
			rcCost: p.rc.costWeighted,
			ctlCost: p.ctl.costWeighted,
			dCost: dCost[i],
			dWall: dWall[i],
			verify: `${p.rc.verify}/${p.ctl.verify}`,
		})),
		criteria,
		verdict: pass ? "PASS" : "FAIL",
	};
}

const CAUSAL_BLOCKING = { ui: false, request: true, execution: false, provider: true };

function main() {
	const [rcPath, ctlPath, ...rest] = process.argv.slice(2);
	if (!rcPath || !ctlPath) {
		process.stderr.write("usage: paired-compare.mjs <rc.json> <ctl.json> [--causal=tier]\n");
		process.exit(1);
	}
	const causal = (rest.find((a) => a.startsWith("--causal=")) ?? "--causal=request").slice(9);
	const rows = (x) => (Array.isArray(x) ? x : (x.runs ?? []));
	const v = pairedVerdict(rows(JSON.parse(readFileSync(rcPath, "utf8"))), rows(JSON.parse(readFileSync(ctlPath, "utf8"))));
	v.causalTier = causal;
	v.blocking = CAUSAL_BLOCKING[causal] ?? true;
	v.disposition =
		v.verdict === "PASS"
			? "PASS — ships (proposed, for the reviewer)"
			: v.blocking
				? "FAIL — BLOCKS the release (the causal tier makes the paired bench a blocker)"
				: "FAIL — informational only (the causal tier does not block on live cost); file the finding";
	process.stdout.write(JSON.stringify(v, null, 1) + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
