#!/usr/bin/env node
/**
 * The line gates: 2,000 for core, 1,200 for the CLI.
 *
 * These are not lint rules. They are the project's central promise, enforced
 * in CI so that they survive contact with good ideas.
 *
 * WHAT COUNTS: source lines in `src/`, excluding blank lines and comment-only
 * lines. Comments are free ON PURPOSE — the whole point of kiso is that every
 * decision is explained, and a budget that taxes explanation would produce a
 * terse, unreadable kernel. Explain freely; implement tersely.
 *
 * The comment stripper is a heuristic (it does not parse TypeScript). It can
 * miscount a line whose string literal contains `//`. That is acceptable for
 * a budget with hundreds of lines of headroom, and cheaper than a real
 * parser.
 *
 * Zero dependencies: this must run in CI before any install step.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const GATES = [
	{ name: "core", limit: 2000, dir: join("packages", "core", "src") },
	// v2d: 1600 → 2100 — the user-authorized raise for the body renderer
	// (ADR-0040: the cell model + frozen/tail architecture).
	{ name: "cli", limit: 2100, dir: join("apps", "cli", "src") },
];
const ROOT = new URL("..", import.meta.url).pathname;

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

let failed = false;
for (const { name, limit, dir } of GATES) {
	const files = walk(join(ROOT, dir)).sort();
	let total = 0;
	const rows = [];

	for (const file of files) {
		const lines = countCode(readFileSync(file, "utf8"));
		total += lines;
		rows.push([relative(ROOT, file), lines]);
	}

	const width = Math.max(...rows.map(([n]) => n.length), 5);
	console.log(`${name}:`);
	for (const [n, lines] of rows) {
		console.log(`  ${n.padEnd(width)}  ${String(lines).padStart(5)}`);
	}
	console.log(`  ${"".padEnd(width, "-")}  -----`);
	console.log(`  ${"total".padEnd(width)}  ${String(total).padStart(5)}  / ${limit}`);

	if (total > limit) {
		failed = true;
		console.error(
			`\n✗ ${name} is ${total - limit} lines over budget.\n` +
				`  The limit is not negotiable — that is what makes it a limit.\n` +
				`  Remove something, or fork atto and grow your own.\n`,
		);
	} else {
		console.log(`  ✓ ${limit - total} lines of headroom remaining.\n`);
	}
}

if (failed) process.exit(1);
