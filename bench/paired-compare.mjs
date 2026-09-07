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
 *   node paired-compare.mjs <rc.json> <ctl.json> [--causal=ui|request|execution|provider] [--margins=bm1-a1|bm1-frozen]
 *
 * Inputs are extractor row arrays; rows pair by (task, run). The
 * margins are FROZEN before any round and never tuned to the round
 * under judgment. Two sets exist:
 *   bm1-a1 (DEFAULT since the rel-030 freeze) — BM-1 Amendment 1,
 *     owner-ratified 2026-08-27 from the 0.16 null batch's own
 *     distribution (kiso-doc/kiso-016-null-verdict.md): verify 100% ·
 *     median(d_cost) <= +20% (the null's bootstrap p95 of |median|) ·
 *     median(d_wall) <= +25%; the single-pair +50% guard is an ANOMALY
 *     DETECTOR — reported per pair, never blocking on its own (a null
 *     diff produced +255.7%; no calibratable per-pair level exists at
 *     n=12 on this model's trajectory tails).
 *   bm1-frozen — the original set (margins from the n=8 historical
 *     pairs): verify 100% · median(d_cost) <= +6% · max pair <= +50% ·
 *     median(d_wall) <= +25%. Kept for re-reading old records.
 *   where d = (rc - ctl) / ctl.
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

const MARGINS = {
	"bm1-a1": { medianCost: 0.2, maxPairBlocks: false, medianWall: 0.25, method: "BM-1 paired, Amendment 1 margins (2026-08-27; median +20%, single pair an anomaly note)" },
	"bm1-frozen": { medianCost: 0.06, maxPairBlocks: true, medianWall: 0.25, method: "BM-1 paired (frozen margins, provisional until 0.13.0)" },
};

export function pairedVerdict(rcRows, ctlRows, marginSet = "bm1-a1") {
	const m = MARGINS[marginSet];
	if (m === undefined) throw new Error(`unknown margin set: ${marginSet}`);
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
		marginSet,
		verifyAllPass: verifies.every((v) => v === "pass"),
		medianCost: median(dCost),
		medianCostOk: median(dCost) <= m.medianCost,
		maxPair: Math.max(...dCost),
		// bm1-a1: the +50% single-pair level is an anomaly note, never a block
		maxPairOk: Math.max(...dCost) <= 0.5,
		maxPairBlocks: m.maxPairBlocks,
		anomalies: pairs.filter((_, i) => dCost[i] > 0.5).map((p) => p.id),
		medianWall: median(dWall),
		medianWallOk: median(dWall) <= m.medianWall,
	};
	const pass = criteria.verifyAllPass && criteria.medianCostOk && (!m.maxPairBlocks || criteria.maxPairOk) && criteria.medianWallOk;
	return {
		method: m.method,
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
	const marginSet = (rest.find((a) => a.startsWith("--margins=")) ?? "--margins=bm1-a1").slice(10);
	const rows = (x) => (Array.isArray(x) ? x : (x.runs ?? []));
	const v = pairedVerdict(rows(JSON.parse(readFileSync(rcPath, "utf8"))), rows(JSON.parse(readFileSync(ctlPath, "utf8"))), marginSet);
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
