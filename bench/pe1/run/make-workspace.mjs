#!/usr/bin/env node
/** Seed a fresh PE-1 workspace: copy the fixture, git init, tag `seed`.
 *  usage: make-workspace.mjs <taskName> <destDir> */
import { cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [task, dest] = process.argv.slice(2);
if (!task || !dest) {
  console.error("usage: make-workspace.mjs <taskName> <destDir>");
  process.exit(2);
}
const src = join(here, "..", "tasks", task, "workspace");
if (!existsSync(src)) {
  console.error(`no such task fixture: ${src}`);
  process.exit(2);
}
if (existsSync(dest)) {
  console.error(`refusing: ${dest} already exists`);
  process.exit(2);
}
cpSync(src, dest, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: dest, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("-c", "user.email=pe1@bench", "-c", "user.name=pe1", "commit", "-q", "-m", "seed");
git("tag", "seed");
console.log(`[pe1] seeded ${task} at ${dest}`);
