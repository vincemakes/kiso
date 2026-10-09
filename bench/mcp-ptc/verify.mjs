#!/usr/bin/env node
/**
 * verify.mjs <task: SHORT|MID|DEEP> <snapshot.json> <answer.txt> — the verdict
 * of one leg: the END STATE the server wrote, never the call sequence.
 * Prints pass | fail and writes the detail (checks, waste) to stdout as JSON
 * on stderr. Exit 0 either way; non-zero means the verifier could not run.
 *
 * Gated: the end-state checks of the task and the answer's facts.
 * Reported, never gated: waste — assets beyond one per subject, credits spent
 * beyond the cheapest route, tool calls by name (from the server's counters).
 */
import { readFileSync } from "node:fs";

const [task, snapPath, answerPath] = process.argv.slice(2);
if (!task || !snapPath) { console.error("usage: verify.mjs <SHORT|MID|DEEP> <snapshot> <answer>"); process.exit(2); }
const s = JSON.parse(readFileSync(snapPath, "utf8"));
let answer = ""; try { answer = readFileSync(answerPath, "utf8"); } catch { /* unread */ }
const PASS_AT = 70;
const byName = (n) => Object.values(s.projects).find((p) => p.name === n);
const subjectsOf = (p) => Object.values(s.subjects).filter((x) => x.project === p.id);
const assetsOf = (p) => Object.entries(s.assets).filter(([, a]) => a.project === p.id).map(([id, a]) => ({ id, ...a }));
const spentOf = (p) => s.ledger.filter((l) => l.project === p.id && l.kind === "settle").reduce((t, l) => t + l.amount, 0);
const checks = {}, report = { calls: s.calls };

function everySubjectHasPassingAsset(p, names) {
	const subs = subjectsOf(p);
	const have = new Set(subs.map((x) => x.name));
	checks.subjects = names.every((n) => have.has(n)) && subs.length === names.length;
	checks.eachSubjectPasses = subs.every((x) => assetsOf(p).some((a) => a.subject === x.id && a.quality >= PASS_AT));
	report.extraAssets = assetsOf(p).length - subs.length;
}

if (task === "SHORT") {
	const p = byName("Harbor");
	checks.projectExists = !!p;
	const sub = p && subjectsOf(p).find((x) => x.name === "Wind Cartographer");
	checks.subjectAdded = !!sub;
	checks.assetGenerated = !!sub && assetsOf(p).some((a) => a.subject === sub.id && a.style === "noir");
	checks.spend = !!p && spentOf(p) === 20;
	checks.answerRemaining = /\b280\b/.test(answer);
} else if (task === "MID") {
	const p = byName("Atlas");
	checks.projectExists = !!p;
	if (p) {
		checks.budget = p.budget === 200;
		everySubjectHasPassingAsset(p, ["Brass Heron", "Quiet Engine", "Glass Orchard", "Salt Lantern", "Hollow Drum", "Night Ferry"]);
		checks.withinBudget = spentOf(p) <= p.budget;
		const revised = assetsOf(p).filter((a) => a.rev > 0).map((a) => a.id);
		report.revised = revised;
		checks.answerNamesRevised = revised.every((id) => answer.includes(id));
		report.spent = spentOf(p);
	}
} else if (task === "DEEP") {
	const p = byName("Meridian");
	checks.projectExists = !!p;
	if (p) {
		checks.budget = p.budget === 250;
		const names = ["Copper Gull", "Tide Clerk", "Ash Piano", "Velvet Lamp", "Stone Violin", "Reed Cartographer", "Marrow Clock", "Pale Harbor", "Iron Orchid", "Dust Archive", "Lantern Fox", "Kelp Bishop"];
		everySubjectHasPassingAsset(p, names);
		const board = s.boards[p.id];
		const placed = board ? board.assets.map((id) => s.assets[id]) : [];
		checks.boardOnePerSubject = !!board && placed.length === names.length && new Set(placed.map((a) => a?.subject)).size === names.length && placed.every((a) => a && a.quality >= PASS_AT);
		checks.approvedThenFinal = p.state === "final" && !!s.approvals[p.id];
		checks.withinBudget = spentOf(p) <= p.budget;
		checks.answerTotal = new RegExp(`\\b${spentOf(p)}\\b`).test(answer);
		report.spent = spentOf(p);
	}
} else { console.error(`unknown task ${task}`); process.exit(2); }

const pass = Object.values(checks).every(Boolean);
console.error(JSON.stringify({ task, checks, report }));
console.log(pass ? "pass" : "fail");
