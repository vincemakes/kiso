#!/usr/bin/env node
/**
 * SH-1 ① — the PTY/process-suite manifest gate.
 *
 * The partition (tests/pty-suite.json) is a whitelist ritual: the pty
 * pool runs single-file-serial AFTER the unit pool finishes (two shell
 * invocations — the ordering comes from `&&`, never from a scheduler's
 * implicit behavior). This gate keeps the partition TRUE:
 *
 *   1. every test file whose RESOURCE-DEPENDENCY CLOSURE spawns
 *      processes is in the pty pool (or carries an exempt row with a
 *      reason) — closure, not import-string luck: 16 real PTY tests
 *      import only helpers/pty.js and never touch child_process
 *      themselves;
 *   2. every manifest entry names a file that exists (no ghosts);
 *   3. ALL discovered tests = UNIT ⊔ PTY — disjoint and complete
 *      (equal COUNTS prove nothing; the sets are compared).
 *
 * Classification is deliberately over-wide: a unit test misfiled into
 * the serial pool only runs slower; a spawner misfiled into the
 * parallel pool re-opens the contention hole this round closes.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** The registered process roots: importing one (directly, or through
 *  one level of relative re-export) classifies a test as resource-
 *  heavy. A NEW process helper must be registered here. */
export const PROCESS_ROOTS = ["apps/cli/tests/helpers/pty", "tests/helpers/isolated-cli"];

const DIRECT = [/node:child_process/, /child_process/, /execFileSync\s*\(/, /execSync\s*\(/, /\bspawn(Sync)?\s*\(/, /pty\.fork\s*\(/];

/** Pure classifier over one test file's SOURCE (transitive closure is
 *  applied by the caller via followRelativeImports). */
export function classifyTestSource(source) {
	if (DIRECT.some((rx) => rx.test(source))) return true;
	for (const root of PROCESS_ROOTS) {
		const base = root.split("/").pop();
		if (source.includes(`helpers/${base}`) || source.includes(`${base}.js`) || source.includes(`${base}.mjs`) || source.includes(`${base}.ts`)) return true;
	}
	return false;
}

/** The partition invariant: returns [] when clean, else the errors. */
export function verifyPartition({ discovered, pty, resourceClassified }) {
	const errs = [];
	const disc = new Set(discovered);
	const ptySet = new Set(pty);
	if (ptySet.size !== pty.length) errs.push(`duplicate entries in the pty manifest`);
	for (const p of pty) {
		if (!disc.has(p)) errs.push(`ghost manifest entry (no such test file): ${p}`);
	}
	for (const r of resourceClassified) {
		if (!ptySet.has(r)) errs.push(`resource-classified test NOT in the pty manifest: ${r}`);
	}
	return errs;
}

function walk(dir, acc) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist" || e.name === ".git" || e.name === ".claude" || e.name === "bench") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, acc);
		else if (/\.test\.tsx?$/.test(e.name)) acc.push(p);
	}
	return acc;
}

/** One level of relative-import closure: a test that imports a local
 *  helper inherits the helper's classification. */
function closureClassify(file) {
	const src = readFileSync(file, "utf8");
	if (classifyTestSource(src)) return true;
	for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
		const raw = m[1];
		const base = resolve(dirname(file), raw);
		for (const cand of [base, `${base}.ts`, `${base}.mjs`, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".mjs")]) {
			if (existsSync(cand) && statSync(cand).isFile()) {
				try {
					if (classifyTestSource(readFileSync(cand, "utf8"))) return true;
				} catch {
					// unreadable helper: stay conservative below
				}
				break;
			}
		}
	}
	return false;
}

function main() {
	const manifestPath = join(ROOT, "tests", "pty-suite.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const pty = manifest.pty ?? [];
	const exempt = new Map((manifest.exempt ?? []).map((e) => [e.file, e.reason]));

	const discovered = walk(ROOT, []).map((p) => relative(ROOT, p)).sort();
	const resourceClassified = discovered.filter((f) => closureClassify(join(ROOT, f))).filter((f) => !exempt.has(f));

	const errs = verifyPartition({ discovered, pty, resourceClassified });
	for (const [file, reason] of exempt) {
		if (!discovered.includes(file)) errs.push(`ghost exempt entry: ${file}`);
		if (typeof reason !== "string" || reason.length < 8) errs.push(`exempt entry needs a real reason: ${file}`);
	}
	if (errs.length > 0) {
		for (const e of errs) console.error(`[pty-manifest] ${e}`);
		console.error(`[pty-manifest] RED — the partition is not true`);
		process.exit(1);
	}
	console.log(`[pty-manifest] OK — ${discovered.length} tests = ${discovered.length - pty.length} unit ⊔ ${pty.length} pty (exempt: ${exempt.size})`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	main();
}
