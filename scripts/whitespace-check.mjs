#!/usr/bin/env node
/**
 * Release truth (round 9): the tree must be whitespace-clean.
 *
 * - no trailing whitespace on any tracked file;
 * - every tracked file ends with a newline (an EOF without one is a
 *   torn-tail waiting to happen in JSONL land).
 *
 * Runs as part of `npm run check`; `git diff --check` covers the working
 * tree vs HEAD in the same gate (root package.json).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execSync("git ls-files", { encoding: "utf8" })
	.split("\n")
	.filter((f) => f !== "" && !f.includes("node_modules") && !f.endsWith(".d.ts"));

const problems = [];
for (const file of tracked) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue; // a gitlink or unreadable entry
	}
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/[ \t]+$/.test(lines[i])) {
			problems.push(`${file}:${i + 1}: trailing whitespace`);
		}
	}
	if (text.length > 0 && !text.endsWith("\n")) {
		problems.push(`${file}: file does not end with a newline`);
	}
}

if (problems.length > 0) {
	console.error("[whitespace-check] FAIL:");
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(`[whitespace-check] OK — ${tracked.length} tracked files, no trailing whitespace, every file ends with a newline`);
