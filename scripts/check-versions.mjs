#!/usr/bin/env node
/**
 * TUI2-R2pre ⑤ (audit #1): the tree states ONE version.
 *
 * The release discipline is a lockstep — every published package moves
 * together — but nothing enforced it, and the tree had drifted into
 * FIVE mutually inconsistent claims at once: fourteen workspace
 * manifests at 0.9.0, the root manifest at 0.1.0, the root's own
 * @vincemakes/* devDependencies pinned at 0.1.0 (unsatisfiable from the
 * workspace, so npm resolved them from the registry — the lockfile still
 * shows a kiso-core-0.1.34.tgz), and both README banners at v0.2.0.
 *
 * Three rules, and the version is whatever the workspace packages agree
 * on (they are the published artifacts — the root and the READMEs are
 * downstream of them, so a disagreement there is theirs to fix):
 *   1. all 15 manifests carry the same "version";
 *   2. every @vincemakes/* dependency, devDependency and peerDependency
 *      pin equals it EXACTLY — no range, no caret;
 *   3. README.md and README.zh.md name it on the banner line.
 *
 * The manifest set comes from the root "workspaces" globs plus the root
 * itself, which is what makes it exact: the bench fixtures carry their
 * own package.json (one of them a deliberate "0.3.1" as test data) and
 * are not workspaces, so a directory walk would have to special-case
 * them and this does not.
 *
 * Zero dependencies: this must run in CI before any install step.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PIN_KINDS = ["dependencies", "devDependencies", "peerDependencies"];
const README_LINE = 6; // 1-based — the banner row of the ASCII logo block

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The workspace manifests, from the root's own globs (`dir/*` only —
 *  the shape this repo uses). */
function manifestPaths() {
	const rootPkg = read(join(ROOT, "package.json"));
	const out = [{ rel: "package.json", pkg: rootPkg }];
	for (const glob of rootPkg.workspaces ?? []) {
		const dir = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
		const base = join(ROOT, dir);
		if (!existsSync(base)) continue;
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const rel = `${dir}/${entry.name}/package.json`;
			if (!existsSync(join(ROOT, rel))) continue;
			out.push({ rel, pkg: read(join(ROOT, rel)) });
		}
	}
	return out;
}

const manifests = manifestPaths();
const problems = [];

// the version the WORKSPACE packages agree on — the published artifacts
// are the source of truth; the root manifest and the READMEs follow.
const tally = new Map();
for (const { rel, pkg } of manifests) {
	if (rel === "package.json") continue;
	tally.set(pkg.version, (tally.get(pkg.version) ?? 0) + 1);
}
const expected = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (expected === undefined) {
	console.error("[check-versions] FAIL: no workspace manifests found");
	process.exit(1);
}

// 1. one version across all manifests
for (const { rel, pkg } of manifests) {
	if (pkg.version !== expected) {
		problems.push(`${rel}: version "${pkg.version}" — the lockstep is "${expected}"`);
	}
}

// 2. every in-tree pin is that version, exactly
for (const { rel, pkg } of manifests) {
	for (const kind of PIN_KINDS) {
		for (const [dep, range] of Object.entries(pkg[kind] ?? {})) {
			if (!dep.startsWith("@vincemakes/")) continue;
			if (range !== expected) {
				problems.push(`${rel}: ${kind}["${dep}"] pinned "${range}" — the lockstep is "${expected}" (exact, no range)`);
			}
		}
	}
}

// 3. both README banners name it
for (const file of ["README.md", "README.zh.md"]) {
	const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
	const line = lines[README_LINE - 1] ?? "";
	const m = /v(\d+\.\d+\.\d+)/.exec(line);
	if (m === null) {
		problems.push(`${file}:${README_LINE}: no version banner found on the banner line`);
	} else if (m[1] !== expected) {
		problems.push(`${file}:${README_LINE}: banner says "v${m[1]}" — the lockstep is "${expected}"`);
	}
}

if (problems.length > 0) {
	console.error("[check-versions] FAIL:");
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(`[check-versions] OK — ${manifests.length} manifests, every @vincemakes/* pin, and both README banners at ${expected}`);
