#!/usr/bin/env node
/**
 * summary.mjs <round dir> — per cell, per arm: legs, verify passes, and the
 * medians of requests, cost-weighted input, output tokens, wall; then the two
 * contrasts that attribute a gain, inside the reference runtime:
 *   P-direct   vs P-deferred   (lazy loading)
 *   P-codemode vs P-deferred   (orchestration / filtering, by the cell's axis)
 * and the cross-harness line K-direct vs P-direct, LABELLED as cross-harness.
 * REPORT-ONLY. A P-codemode leg with zero script-tool calls is UNEXERCISED and a
 * P-deferred leg with zero tool_search calls while the task needed tools is
 * listed too: a contrast over legs that never used the mechanism is not a
 * contrast of the mechanism.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: summary.mjs <round dir>"); process.exit(2); }
const rows = readFileSync(join(dir, "ledger.tsv"), "utf8").trim().split("\n").slice(1).map((l) => {
	const [leg, arm, cell, rep, , , verify, status, voided] = l.split("\t");
	const p = join(dir, leg, "mcp-metrics.json");
	return { leg, arm, cell, rep: Number(rep), verify, status, voided, m: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {} };
}).filter((r) => r.voided === "-");
const med = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? `${a / b - 1 >= 0 ? "+" : ""}${(100 * (a / b - 1)).toFixed(0)}%` : "n/a");
const METRICS = ["requests", "cw", "output", "wallSeconds", "usd"];
const cells = [...new Set(rows.map((r) => r.cell))];
const ARMS = ["K-direct", "K-program", "K-program-index", "K-plan", "P-direct", "P-deferred", "P-codemode", "P-codemode-only"];
for (const cell of cells) {
	console.log(`\n== cell ${cell}`);
	const by = {};
	for (const arm of ARMS) {
		const rs = rows.filter((r) => r.cell === cell && r.arm === arm); if (!rs.length) continue;
		by[arm] = Object.fromEntries(METRICS.map((k) => [k, med(rs.map((r) => r.m[k]))]));
		by[arm].n = rs.length; by[arm].pass = rs.filter((r) => r.verify === "pass").length;
		by[arm].script = rs.filter((r) => (r.m.codemodeCalls ?? 0) > 0).length; by[arm].search = rs.filter((r) => (r.m.toolSearchCalls ?? 0) > 0).length;
		console.log(`${arm.padEnd(11)} n=${rs.length} verify ${by[arm].pass}/${rs.length}  requests ${by[arm].requests}  cw ${Math.round(by[arm].cw)}  out ${Math.round(by[arm].output)}  usd ${by[arm].usd}  wall ${by[arm].wallSeconds}s${arm === "P-codemode" || arm === "P-codemode-only" || arm === "K-program" ? `  script-tool used in ${by[arm].script}/${rs.length}` : ""}${arm === "P-deferred" ? `  tool_search used in ${by[arm].search}/${rs.length}` : ""}`);
	}
	const line = (label, a, b) => by[a] && by[b] && console.log(`  ${label.padEnd(36)} ${METRICS.map((k) => `${k} ${pct(by[a][k], by[b][k])}`).join("  ")}`);
	line("lazy loading   P-direct vs P-deferred", "P-direct", "P-deferred");
	line("script tool    P-codemode vs P-deferred", "P-codemode", "P-deferred");
	line("CROSS-HARNESS  K-direct vs P-direct", "K-direct", "P-direct");
	line("HEAD-TO-HEAD   K-program vs P-codemode-only", "K-program", "P-codemode-only");
	line("INDEX          K-program-index vs K-program", "K-program-index", "K-program");
	line("IR             K-plan vs K-program", "K-plan", "K-program");
	line("IR vs index    K-plan vs K-program-index", "K-plan", "K-program-index");
	line("script only    P-codemode-only vs P-codemode", "P-codemode-only", "P-codemode");
}
