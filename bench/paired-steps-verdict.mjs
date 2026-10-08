#!/usr/bin/env node
/**
 * paired-steps-verdict.mjs <runs root> <round> --task=T6 --expect-pairs=N
 *     [--bar=-0.08] [--seed=20261008] [--draws=20000]
 *
 * The edit-discipline round's verdict (kiso-doc
 * kit-edit-discipline-FROZEN-2026-10-08.md). The primary is STEPS — the
 * requests a leg made — because on the long curve every extra step pays
 * its output and re-sends the whole context, and the per-leg request
 * count disperses about a sixth as much as cost (CV 9.0% against 15.7%
 * on the 2026-10-07 baseline). Cost and wall are guards, as BM-1 has
 * them (bm1-a1: median ≤ +20% and ≤ +25%).
 *
 * Legs come from launch-report.mjs's own reader (the part `<round>-t6`),
 * named kiso-T6-rc<N> and kiso-T6-ctl<N> by run-paired.sh; a re-run of a
 * void pair is rc<N>b / ctl<N>b. A pair counts when both legs are valid:
 * no `void` file, status complete, usage known, effort on the wire
 * `none`. Any other number of usable pairs than --expect-pairs is
 * INVALID: no verdict, ever (the 0.48.0 kit's rule, after wait-r1).
 *
 * The mechanism counters read each leg's captured request bodies (the
 * longest one carries the whole conversation): edit calls, hunks,
 * back-to-back edits of one file, reads of a file the leg had edited,
 * failed edits. They are reported, and the failed-edit rate is a guard.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { report } from "./launch-report.mjs";

const args = Object.fromEntries(process.argv.slice(4).map((a) => a.replace(/^--/, "").split("=")));
const [root, round] = process.argv.slice(2);
if (!root || !round) { console.error("usage: paired-steps-verdict.mjs <runs root> <round> --task=T6 --expect-pairs=N"); process.exit(2); }
const TASK = args.task ?? "T6";
const PART = TASK.toLowerCase();
const EXPECT = Number(args["expect-pairs"]);
const BAR = Number(args.bar ?? -0.08);
const SEED = Number(args.seed ?? 20261008);
const DRAWS = Number(args.draws ?? 20000);
const COST_MARGIN = 0.2, WALL_MARGIN = 0.25, FAILED_EDIT_TOLERANCE_PP = 2;

// mulberry32 — a fixed, documented PRNG, so the interval is reproducible
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export function bootstrapMedianCI(xs, seed = SEED, draws = DRAWS) {
	const r = rng(seed); const meds = [];
	for (let d = 0; d < draws; d++) meds.push(median(Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)])));
	meds.sort((a, b) => a - b);
	return [meds[Math.floor(0.025 * draws)], meds[Math.ceil(0.975 * draws) - 1]];
}

export function mechanism(work) {
	const cap = join(work, "capture");
	if (!existsSync(cap)) return null;
	let longest = null;
	for (const f of readdirSync(cap).filter((x) => x.startsWith("req-") && x.endsWith(".json"))) {
		try { const j = JSON.parse(readFileSync(join(cap, f), "utf8")); const b = j.body ?? j; if (Array.isArray(b.messages) && (!longest || b.messages.length > longest.messages.length)) longest = b; } catch {}
	}
	if (!longest) return null;
	const results = new Map();
	for (const m of longest.messages) if (m.role === "tool") results.set(m.tool_call_id, typeof m.content === "string" ? m.content : JSON.stringify(m.content));
	const c = { editCalls: 0, hunks: 0, backToBack: 0, failedEdits: 0, reads: 0, readsOfEdited: 0 };
	const edited = new Set(); let prevEdit = null;
	for (const m of longest.messages) for (const tc of m.tool_calls ?? []) {
		const n = tc.function?.name; let a = {}; try { a = JSON.parse(tc.function?.arguments ?? "{}"); } catch {}
		const p = String(a.path ?? "");
		if (n === "edit_file") {
			c.editCalls++; c.hunks += Array.isArray(a.edits) ? a.edits.length : 1;
			if (prevEdit === p) c.backToBack++;
			prevEdit = p; edited.add(p);
			if (/^edit_file: pattern not found|refused|stale revision/i.test(results.get(tc.id) ?? "")) c.failedEdits++;
		} else {
			prevEdit = null;
			if (n === "read_file") { c.reads++; if (edited.has(p)) c.readsOfEdited++; }
		}
	}
	return c;
}

const r = report(root, round);
const part = r.parts[PART];
if (!part) { console.error(`no part ${round}-${PART} under ${root}`); process.exit(2); }
const partdir = join(root, `${round}-${PART}`);
const legs = new Map(part.legs.map((l) => [l.run, l]));
const valid = (l) => l && !l.void && l.status === "complete" && !l.unknownUsage && l.effortWire === "none";
const ids = [...new Set(part.legs.map((l) => l.run.replace(/^(rc|ctl)/, "")))].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
const pairs = [];
const dropped = [];
for (const id of ids) {
	const rc = legs.get(`rc${id}`), ctl = legs.get(`ctl${id}`);
	if (valid(rc) && valid(ctl)) pairs.push({ id, rc, ctl, mrc: mechanism(join(partdir, rc.leg)), mctl: mechanism(join(partdir, ctl.leg)) });
	else dropped.push(`${id}: ${[["rc", rc], ["ctl", ctl]].filter(([, l]) => !valid(l)).map(([a, l]) => `${a} ${!l ? "missing" : l.void ? "void" : l.status !== "complete" ? l.status : l.unknownUsage ? "unknown usage" : `effort ${l.effortWire}`}`).join(", ")}`);
}
const d = (f) => pairs.map((p) => (p.rc[f] - p.ctl[f]) / p.ctl[f]);
const dReq = d("requests"), dCost = d("costV2"), dWall = d("wall");
const pct = (x) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

console.log(`paired-steps-verdict — round ${round}, ${TASK}, rc vs ctl, d = (rc - ctl) / ctl`);
console.log(`usable pairs ${pairs.length} (expected ${EXPECT})${dropped.length ? ` · dropped: ${dropped.join("; ")}` : ""}`);
console.log("pair  requests rc/ctl     d_req    d_cost    d_wall   verify rc/ctl");
for (let i = 0; i < pairs.length; i++) {
	const p = pairs[i];
	console.log(`${p.id.padEnd(5)} ${String(p.rc.requests).padStart(4)}/${String(p.ctl.requests).padEnd(4)}        ${pct(dReq[i]).padStart(7)}  ${pct(dCost[i]).padStart(7)}  ${pct(dWall[i]).padStart(7)}   ${p.rc.verify}/${p.ctl.verify}`);
}
if (!Number.isFinite(EXPECT) || pairs.length !== EXPECT) {
	console.log(`\nVERDICT: INVALID — ${pairs.length} usable pairs, the kit registered ${EXPECT}. No verdict.`);
	process.exit(3);
}
const ciReq = bootstrapMedianCI(dReq), ciCost = bootstrapMedianCI(dCost);
const mReq = median(dReq), mCost = median(dCost), mWall = median(dWall);
const verifyFail = (arm) => pairs.filter((p) => p[arm].verify !== "pass").length;
const mech = (arm, k) => sum(pairs.map((p) => (p[arm === "rc" ? "mrc" : "mctl"] ?? {})[k] ?? 0));
const failRate = (arm) => (mech(arm, "editCalls") ? mech(arm, "failedEdits") / mech(arm, "editCalls") : 0);
const checks = [
	["PRIMARY  median d_requests <= " + pct(BAR), mReq <= BAR, pct(mReq)],
	["PRIMARY  bootstrap 95% of the median excludes zero (upper < 0)", ciReq[1] < 0, `[${pct(ciReq[0])}, ${pct(ciReq[1])}]`],
	["guard    verify: rc failures <= ctl failures", verifyFail("rc") <= verifyFail("ctl"), `rc ${verifyFail("rc")} · ctl ${verifyFail("ctl")}`],
	[`guard    failed-edit rate: rc <= ctl + ${FAILED_EDIT_TOLERANCE_PP} pp`, failRate("rc") <= failRate("ctl") + FAILED_EDIT_TOLERANCE_PP / 100, `rc ${(failRate("rc") * 100).toFixed(1)}% · ctl ${(failRate("ctl") * 100).toFixed(1)}%`],
	[`guard    median d_cost <= +${COST_MARGIN * 100}% (bm1-a1)`, mCost <= COST_MARGIN, pct(mCost)],
	[`guard    median d_wall <= +${WALL_MARGIN * 100}% (bm1-a1)`, mWall <= WALL_MARGIN, pct(mWall)],
];
console.log("\nagainst the criteria frozen before the runs:");
for (const [what, ok, val] of checks) console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}  -> ${val}`);
console.log(`\nREPORTED (never a bar): median d_cost ${pct(mCost)} [${pct(ciCost[0])}, ${pct(ciCost[1])}] · pairs with fewer requests ${dReq.filter((x) => x < 0).length}/${pairs.length}`);
console.log("mechanism, summed over the round       rc      ctl");
for (const k of ["editCalls", "hunks", "backToBack", "failedEdits", "reads", "readsOfEdited"]) console.log(`  ${k.padEnd(28)} ${String(mech("rc", k)).padStart(6)} ${String(mech("ctl", k)).padStart(8)}`);
const supported = checks.every(([, ok]) => ok);
console.log(`\nVERDICT: ${supported ? "SUPPORTED" : "NOT SUPPORTED"}`);
process.exit(supported ? 0 : 1);
