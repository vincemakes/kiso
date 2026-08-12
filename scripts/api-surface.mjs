#!/usr/bin/env node
/**
 * R-G 0.1.47 (diet B): the package request-surface enumerator.
 *
 * Prints every NAME the packages' public type surface exports — the
 * resolved dist .d.ts chain — per package, sorted, with a total. The
 * round report's delta line is a plain diff between two runs:
 *
 *   node scripts/request-surface.mjs > before.txt
 *   ... release work ...
 *   node scripts/request-surface.mjs > after.txt
 *   diff before.txt after.txt
 *
 * The surface is read from the BUILT dist (what consumers actually
 * import), never from src — the source may be TS while the published
 * artifact is the .d.ts chain, and the chain is the contract.
 *
 * Resolution rules (the forms esbuild emits here):
 *   export * from "./x.js"            → recurse, import the target's whole surface
 *   export { a, b as c, type d } from "./y.js"
 *                                     → recurse, expose ONLY the listed names
 *                                      (an alias exposes its alias)
 *   export declare class/const/enum/function/interface/type/var/namespace N
 *   export type N = ...               → N (direct declarations)
 *   export default                    → "default"
 *
 * A module is resolved once (memoized); star chains are acyclic in a
 * build DAG, so recursion terminates. Unresolvable specs warn on
 * stderr — stdout stays the diff-able surface.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let rootArg = null;
if (args[0] !== "--check" && args[0] !== "--update" && args[0] !== undefined) rootArg = args[0];
const root = resolve(rootArg ?? fileURLToPath(new URL("..", import.meta.url)));

const modules = new Map(); // resolved path -> Set of exported names
const warned = new Set();

function exportedName(spec) {
	let s = spec.trim();
	if (s.startsWith("type ")) s = s.slice(5).trim(); // type-only specifier
	const as = s.indexOf(" as ");
	if (as !== -1) s = s.slice(as + 4).trim(); // aliased: expose the alias
	return s;
}

function resolveSpec(fromPath, spec) {
	const base = join(dirname(fromPath), spec).replace(/\.(?:js|mjs|cjs|ts|d\.ts)$/, "");
	const cands = [base + ".d.ts", base + ".ts"];
	for (const cand of cands) {
		if (existsSync(cand)) return cand;
	}
	const key = `${fromPath} -> ${spec}`;
	if (!warned.has(key)) {
		warned.add(key);
		console.error(`request-surface: unresolvable export "${spec}" from ${fromPath}`);
	}
	return null;
}

function resolveModule(path) {
	const seen = modules.get(path);
	if (seen !== undefined) return seen;

	const names = new Set();
	modules.set(path, names); // mark in-progress (cycle guard — unused on a DAG)
	const text = readFileSync(path, "utf8");

	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("export")) continue;

		let m = t.match(/^export \* from "([^"]+)"/);
		if (m !== null) {
			const target = resolveSpec(path, m[1]);
			if (target !== null) for (const n of resolveModule(target)) names.add(n);
			continue;
		}

		m = t.match(/^export (?:type )?\{([^}]*)\}(?: from "([^"]+)")?/);
		if (m !== null) {
			const specifiers = m[1].split(",").map(exportedName).filter(Boolean);
			for (const n of specifiers) names.add(n);
			if (m[2] !== undefined) {
				const target = resolveSpec(path, m[2]);
				if (target !== null) resolveModule(target); // chain exists even when only listed names surface
			}
			continue;
		}

		m = t.match(/^export (?:declare )?(?:abstract )?(class|function|const|var|enum|interface|type|namespace) ([A-Za-z_$][A-Za-z0-9_$]*)/);
		if (m !== null) {
			names.add(m[2]);
			continue;
		}

		if (t === "export default") names.add("default");
	}
	return names;
}

/**
 * S1 (2026-08-12): the surface GATE — modes:
 *
 *   node scripts/api-surface.mjs                     — enumerate all packages (the report/delta tool)
 *   node scripts/api-surface.mjs --check <pkg> <snap>— gate: the package's root exports must EXACTLY
 *                                                      equal the snapshot (additions AND removals are
 *                                                      RED; only the review-approved ritual may change it)
 *   node scripts/api-surface.mjs --update <pkg> <snap>— the ritual: write the current enumeration
 *                                                      as the snapshot
 */
const mode = args[0];
if (mode === "--check" || mode === "--update") {
	const pkg = args[1];
	const snapFile = resolve(args[2] ?? "");
	if (pkg === undefined || snapFile === "") {
		console.error(`api-surface: ${mode} needs <pkg> <snapshot-file>`);
		process.exit(2);
	}
	const index = join(root, "packages", pkg, "dist", "index.d.ts");
	if (!existsSync(index)) {
		console.error(`api-surface: no dist for package ${pkg} (build first)`);
		process.exit(2);
	}
	const names = [...resolveModule(index)].sort();
	if (mode === "--update") {
		writeFileSync(snapFile, JSON.stringify(names, null, 2) + "\n");
		console.log(`api-surface: ${pkg} snapshot updated (${names.length} names) → ${snapFile}`);
		process.exit(0);
	}
	if (!existsSync(snapFile)) {
		console.error(`api-surface: snapshot missing: ${snapFile}`);
		process.exit(2);
	}
	let pinned;
	try {
		pinned = JSON.parse(readFileSync(snapFile, "utf8"));
	} catch {
		console.error(`api-surface: snapshot is not valid JSON: ${snapFile}`);
		process.exit(2);
	}
	if (!Array.isArray(pinned)) {
		console.error(`api-surface: snapshot must be a JSON array of names: ${snapFile}`);
		process.exit(2);
	}
	pinned = [...pinned].sort();
	const added = names.filter((n) => !pinned.includes(n));
	const removed = pinned.filter((n) => !names.includes(n));
	if (added.length > 0 || removed.length > 0) {
		console.error(`api-surface: SURFACE DRIFT — ${pkg} root does not match the pinned snapshot (${snapFile})`);
		for (const n of added) console.error(`  + ${n}   (in dist, NOT in the snapshot — unritualized addition)`);
		for (const n of removed) console.error(`  - ${n}   (in the snapshot, NOT in dist — unritualized removal)`);
		console.error(`snapshot ${pinned.length} names, dist ${names.length} names — mismatch, RED`);
		process.exit(1);
	}
	console.log(`api-surface: ${pkg} root surface matches the pinned snapshot (${names.length} names) — GREEN`);
	process.exit(0);
}

let total = 0;
for (const pkg of readdirSync(join(root, "packages")).sort()) {
	const index = join(root, "packages", pkg, "dist", "index.d.ts");
	if (!existsSync(index)) continue;
	const names = [...resolveModule(index)].sort();
	total += names.length;
	console.log(`== ${pkg} (${names.length})`);
	for (const n of names) console.log(`  ${n}`);
	console.log();
}
console.log(`TOTAL ${total}`);
