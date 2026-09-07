#!/usr/bin/env node
/** The free closed loop on one task — the dry run's exit criterion for a
 *  fixture (protocol §10): seed → a scripted SURROGATE applies the
 *  reference step by step (every step recorded) → evaluate (BENCH TRUTH)
 *  → archive the whole leg (the immutable pair) → RESCORE from the
 *  archive alone (the verdict is a pure function of the artifact) →
 *  REPLAY the recorded steps onto a fresh seed and reach the same tree.
 *  No model is called; no paid leg exists here.
 *  usage: closed-loop.mjs <taskName> [--keep] */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { treeHash } from "../lib/eval-kit.mjs";
import { archive, extract, verify } from "./archive.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lh1 = join(here, "..");
const task = process.argv[2];
const keep = process.argv.includes("--keep");
if (!task) {
	console.error("usage: closed-loop.mjs <taskName> [--keep]");
	process.exit(2);
}
const taskDir = join(lh1, "tasks", task);
const runsDir = join(lh1, "runs");
mkdirSync(runsDir, { recursive: true });
const legId = `${task}-faux-${Date.now().toString(36)}`;
const leg = join(runsDir, legId);
mkdirSync(leg);
const ws = join(leg, "workspace");
const say = (m) => console.log(`[lh1:closed-loop] ${m}`);

// 1. seed
execFileSync(process.execPath, [join(here, "make-workspace.mjs"), task, ws], { stdio: "ignore" });
say(`seeded ${task} → ${relative(lh1, ws)}`);

// 2. the surrogate: one recorded step per reference file (a real agent's
//    trajectory would be recorded the same way — steps.jsonl is the leg's own record)
const steps = [];
const ref = join(taskDir, "reference");
const del = join(ref, "_DELETE");
if (existsSync(del)) {
	for (const rel of readFileSync(del, "utf8").split("\n").filter(Boolean)) {
		rmSync(join(ws, rel), { recursive: true, force: true });
		steps.push({ op: "delete", path: rel });
	}
}
const walk = (dir, base) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "_DELETE") continue;
		const p = join(dir, e.name);
		const rel = relative(base, p);
		if (e.isDirectory()) walk(p, base);
		else {
			mkdirSync(dirname(join(ws, rel)), { recursive: true });
			cpSync(p, join(ws, rel));
			steps.push({ op: "write", path: rel, bytes: readFileSync(p).length });
		}
	}
};
walk(ref, ref);
writeFileSync(join(leg, "steps.jsonl"), `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
const hash = treeHash(ws);
say(`surrogate applied ${steps.length} steps; tree ${hash.slice(0, 12)}`);

// 3. evaluate — BENCH TRUTH; the verdict JSON is the leg's record
const evaluate = (dir) => {
	let out;
	let status = 0;
	try {
		out = execFileSync(process.execPath, [join(taskDir, "evaluator.mjs"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		status = err.status ?? 1;
		out = `${err.stdout ?? ""}`;
	}
	const line = out.split("\n").find((l) => l.startsWith("[lh1:verdict-json] "));
	return { status, verdict: line ? JSON.parse(line.slice("[lh1:verdict-json] ".length)) : null };
};
const first = evaluate(ws);
writeFileSync(join(leg, "verdict.json"), `${JSON.stringify(first.verdict, null, 1)}\n`);
writeFileSync(join(leg, "meta.json"), `${JSON.stringify({ leg: legId, task, arm: "surrogate", model: null, treeHash: hash, steps: steps.length, createdAt: Date.now() }, null, 1)}\n`);
say(`evaluated: ${first.status === 0 ? "PASS" : "FAIL"} (${first.verdict?.checks.filter((c) => c.ok).length}/${first.verdict?.checks.length} checks)`);

// 4. archive — the immutable pair
const artifacts = join(lh1, "artifacts");
const ar = archive(leg, artifacts, legId);
const ver = verify(artifacts, legId);
say(`archived ${ar.entries} entries, ${ar.bytes} bytes; verify ${ver.ok ? "INTACT" : "DRIFTED"}`);

// 5. rescore from the archive ALONE
const tmp = mkdtempSync(join(tmpdir(), "lh1-rescore-"));
extract(artifacts, legId, tmp);
const again = evaluate(join(tmp, "workspace"));
const sameVerdict = JSON.stringify(again.verdict) === JSON.stringify(first.verdict);
say(`rescored from the archive: ${again.status === 0 ? "PASS" : "FAIL"}; verdict ${sameVerdict ? "IDENTICAL" : "DIFFERENT"}`);

// 6. replay the recorded steps onto a fresh seed — the same tree
const replayDir = mkdtempSync(join(tmpdir(), "lh1-replay-"));
const ws2 = join(replayDir, "workspace");
execFileSync(process.execPath, [join(here, "make-workspace.mjs"), task, ws2], { stdio: "ignore" });
for (const s of readFileSync(join(leg, "steps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))) {
	if (s.op === "delete") rmSync(join(ws2, s.path), { recursive: true, force: true });
	else {
		mkdirSync(dirname(join(ws2, s.path)), { recursive: true });
		cpSync(join(ws, s.path), join(ws2, s.path));
	}
}
const hash2 = treeHash(ws2);
say(`replayed ${steps.length} steps: tree ${hash2.slice(0, 12)} ${hash2 === hash ? "IDENTICAL" : "DIFFERENT"}`);

const ok = first.status === 0 && ver.ok && again.status === 0 && sameVerdict && hash2 === hash;
say(`${ok ? "CLOSED LOOP OK" : "CLOSED LOOP BROKEN"} — seed → surrogate → evaluate → archive → rescore → replay`);
rmSync(tmp, { recursive: true, force: true });
rmSync(replayDir, { recursive: true, force: true });
if (!keep) {
	rmSync(leg, { recursive: true, force: true });
	rmSync(join(artifacts, `${legId}.tar.gz`), { force: true });
	rmSync(join(artifacts, `${legId}.sha256`), { force: true });
}
process.exit(ok ? 0 : 1);
