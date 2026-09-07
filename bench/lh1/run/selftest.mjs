#!/usr/bin/env node
/** The evaluators' own red/green proof, plus the reference's discipline:
 *  pristine must FAIL, the reference must PASS, and the reference must
 *  touch only the task's allowed paths (a reference that cheats on the
 *  invariants would teach the evaluator nothing). */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { outsideAllowed } from "../lib/eval-kit.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, "..", "tasks");
const only = process.argv[2];
const tasks = readdirSync(tasksDir).filter((t) => !t.startsWith(".") && (only === undefined || t === only)).sort();
let bad = 0;
export function applyReference(taskDir, ws) {
	const ref = join(taskDir, "reference");
	const del = join(ref, "_DELETE");
	if (existsSync(del)) {
		for (const rel of readFileSync(del, "utf8").split("\n").filter(Boolean)) rmSync(join(ws, rel), { recursive: true, force: true });
	}
	for (const entry of readdirSync(ref)) {
		if (entry === "_DELETE") continue;
		cpSync(join(ref, entry), join(ws, entry), { recursive: true });
	}
}
for (const task of tasks) {
	const taskDir = join(tasksDir, task);
	const tmp = mkdtempSync(join(tmpdir(), `lh1-${task}-`));
	const ws = join(tmp, "ws");
	execFileSync(process.execPath, [join(here, "make-workspace.mjs"), task, ws], { stdio: "ignore" });
	const evaluate = () => {
		try {
			execFileSync(process.execPath, [join(taskDir, "evaluator.mjs"), ws], { stdio: "pipe", encoding: "utf8" });
			return 0;
		} catch (err) {
			return err.status ?? 1;
		}
	};
	const pristine = evaluate();
	applyReference(taskDir, ws);
	const allowed = JSON.parse(readFileSync(join(taskDir, "expected.json"), "utf8")).allowed;
	const offenders = outsideAllowed(ws, allowed);
	const solved = evaluate();
	const redOk = pristine !== 0;
	const greenOk = solved === 0;
	const disciplineOk = offenders.length === 0;
	if (!redOk || !greenOk || !disciplineOk) bad += 1;
	console.log(`[lh1:selftest] ${task}: pristine ${redOk ? "RED (correct)" : "GREEN (BROKEN EVALUATOR)"} / reference ${greenOk ? "GREEN (correct)" : "RED (BROKEN EVALUATOR or reference)"} / reference inside allowed paths ${disciplineOk ? "yes" : `NO: ${offenders.join(",")}`}`);
	rmSync(tmp, { recursive: true, force: true });
}
console.log(`[lh1:selftest] ${bad === 0 ? "PASS" : "FAIL"} — ${tasks.length} tasks, ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
