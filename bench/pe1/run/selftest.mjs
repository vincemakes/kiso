#!/usr/bin/env node
/** The evaluators' own red/green proof: each must FAIL on a pristine
 *  workspace and PASS once the reference solution is applied. An
 *  evaluator that cannot tell those apart measures nothing. */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(here, "..", "tasks");
const tasks = readdirSync(tasksDir).sort();
let bad = 0;

for (const task of tasks) {
  const taskDir = join(tasksDir, task);
  const tmp = mkdtempSync(join(tmpdir(), `pe1-${task}-`));
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
  // apply the reference: copy files over, honor the _DELETE list
  const ref = join(taskDir, "reference");
  const del = join(ref, "_DELETE");
  if (existsSync(del)) {
    for (const rel of readFileSync(del, "utf8").split("\n").filter(Boolean)) {
      rmSync(join(ws, rel));
    }
  }
  for (const entry of readdirSync(ref)) {
    if (entry === "_DELETE") continue;
    cpSync(join(ref, entry), join(ws, entry), { recursive: true });
  }
  const solved = evaluate();

  const redOk = pristine !== 0;
  const greenOk = solved === 0;
  if (!redOk || !greenOk) bad += 1;
  console.log(`[pe1:selftest] ${task}: pristine ${redOk ? "RED (correct)" : "GREEN (BROKEN EVALUATOR)"} / reference ${greenOk ? "GREEN (correct)" : "RED (BROKEN EVALUATOR or reference)"}`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[pe1:selftest] ${bad === 0 ? "PASS" : "FAIL"} — ${tasks.length} tasks, ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
