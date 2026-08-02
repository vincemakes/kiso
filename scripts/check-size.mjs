#!/usr/bin/env node
/**
 * The 2,000-line gate.
 *
 * This is not a lint rule. It is the project's central promise, enforced in CI
 * so that it survives contact with good ideas.
 *
 * WHAT COUNTS: source lines in `src/`, excluding blank lines and comment-only
 * lines. Comments are free ON PURPOSE — the whole point of kiso is that every
 * decision is explained, and a budget that taxes explanation would produce a
 * terse, unreadable kernel. Explain freely; implement tersely.
 *
 * The comment stripper is a heuristic (it does not parse TypeScript). It can
 * miscount a line whose string literal contains `//`. That is acceptable for a
 * budget with 2,000 lines of headroom, and cheaper than a real parser.
 *
 * Zero dependencies: this must run in CI before any install step.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LIMIT = 2000;
const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/** @param {string} source @returns {number} */
function countCode(source) {
	let count = 0;
	let inBlock = false;

	for (const raw of source.split("\n")) {
		const line = raw.trim();

		if (inBlock) {
			if (line.includes("*/")) inBlock = false;
			continue;
		}
		if (line === "") continue;
		if (line.startsWith("//")) continue;
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) inBlock = true;
			continue;
		}
		count++;
	}
	return count;
}

const files = walk(SRC).sort();
let total = 0;
const rows = [];

for (const file of files) {
	const lines = countCode(readFileSync(file, "utf8"));
	total += lines;
	rows.push([relative(ROOT, file), lines]);
}

const width = Math.max(...rows.map(([name]) => name.length), 5);
for (const [name, lines] of rows) {
	console.log(`  ${name.padEnd(width)}  ${String(lines).padStart(5)}`);
}
console.log(`  ${"".padEnd(width, "-")}  -----`);
console.log(`  ${"total".padEnd(width)}  ${String(total).padStart(5)}  / ${LIMIT}`);

if (total > LIMIT) {
	console.error(
		`\n✗ core is ${total - LIMIT} lines over budget.\n` +
			`  The limit is not negotiable — that is what makes it a limit.\n` +
			`  Remove something, or fork atto and grow your own.\n`,
	);
	process.exit(1);
}

console.log(`\n✓ ${LIMIT - total} lines of headroom remaining.\n`);
