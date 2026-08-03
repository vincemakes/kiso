#!/usr/bin/env node
/**
 * One-time migration helper: rewrites relative imports to carry the `.js`
 * extension required by NodeNext emit (tsc does not add extensions).
 * Idempotent: paths already ending in an extension are left alone.
 * Run: node scripts/add-js-suffix.mjs <dir...>
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IMPORT_RE = /(from\s+|\bimport\()(["'])(\.[^"']+)(["'])/g;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

let changed = 0;
for (const dir of process.argv.slice(2)) {
	for (const file of walk(dir)) {
		const source = readFileSync(file, "utf8");
		const rewritten = source.replace(IMPORT_RE, (m, prefix, q1, path, q2) => {
			// Bare "." import, or last segment already has an extension.
			const last = path.split("/").pop();
			if (path === "." || (last !== undefined && last.includes("."))) return m;
			return `${prefix}${q1}${path}.js${q2}`;
		});
		if (rewritten !== source) {
			writeFileSync(file, rewritten);
			changed += 1;
			console.log(`suffixed ${file}`);
		}
	}
}
console.log(`${changed} files updated`);
