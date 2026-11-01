#!/usr/bin/env node
/**
 * REL-0340-F1 — THE PACKED SMOKE MUST NEST THE WHOLE PUBLISHED CLOSURE.
 *
 * `bench/packed-pty-smoke.sh` carried a hand-written list of 14 names beside
 * a workspace of 15 publishable packages, omitting the Responses provider
 * for four releases — including the one that changed it.
 *
 * THE FIRST VERSION OF THIS GATE WAS ITSELF FOOLABLE, and in exactly the way
 * it exists to catch. It scanned the script's TEXT for package names and
 * compared those; once the script derived its closure instead of naming it,
 * the script named nothing, the comparison was skipped, and the gate passed
 * unconditionally. A derivation that returned 14 — or zero — sailed through.
 * Reviewed and reproduced by Astra (PR #32).
 *
 * So this runs the DERIVATION THE SCRIPT ACTUALLY USES and compares its
 * output against an INDEPENDENT enumeration built a different way: the root
 * manifest's own `workspaces` globs. Two readers that share no code. If they
 * disagree, one of them is wrong and the gate says so instead of guessing
 * which.
 *
 * Zero dependencies: this runs in CI before any install step.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { inDependencyOrder, publishablePackages } from "./publishable-packages.mjs";
import { isMain } from "./is-main.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** The SECOND reader: expand the root manifest's `workspaces` globs by hand
 *  and read each manifest. Shares no code with the git-based derivation. */
export function fromWorkspaceGlobs(root = ROOT) {
	const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const globs = rootManifest.workspaces ?? [];
	const names = [];
	for (const g of globs) {
		// only the one shape this repo uses: "<dir>/*" or a literal directory
		const [dir, star] = g.split("/");
		const bases = star === "*" ? readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : [g];
		for (const b of bases) {
			const m = join(root, b, "package.json");
			if (!existsSync(m)) continue;
			const d = JSON.parse(readFileSync(m, "utf8"));
			if (!d.private) names.push(d.name);
		}
	}
	return names.sort();
}

if (isMain(import.meta.url)) {
	const errs = [];
	const derived = publishablePackages();
	const independent = fromWorkspaceGlobs();

	// A closure that finds nothing is a FAILED READ, never an empty workspace.
	if (derived.length === 0) errs.push("the shared derivation returned ZERO packages — a failed read");
	if (independent.length === 0) errs.push("the workspace-glob enumeration returned ZERO packages — a failed read");

	const missing = independent.filter((p) => !derived.includes(p));
	const extra = derived.filter((p) => !independent.includes(p));
	if (missing.length) errs.push(`the derivation MISSES ${missing.length}: ${missing.join(", ")}`);
	if (extra.length) errs.push(`the derivation invents ${extra.length}: ${extra.join(", ")}`);

	// W2 (2026-11-01): kiso-web depends on kiso-code and must stay a leaf, so a terminal install never
	// carries the web app. The dependency ordering throws on a cycle; the walk below proves the CLI's
	// runtime closure does not reach the web package.
	try {
		inDependencyOrder();
	} catch (e) {
		errs.push(`the published closure has a ${e instanceof Error ? e.message : e}`);
	}
	const deps = new Map();
	for (const g of JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces ?? []) {
		const dir = g.split("/")[0];
		for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
			const m = join(ROOT, dir, e.name, "package.json");
			if (!e.isDirectory() || !existsSync(m)) continue;
			const d = JSON.parse(readFileSync(m, "utf8"));
			deps.set(d.name, Object.keys({ ...d.dependencies, ...d.peerDependencies }));
		}
	}
	const closure = new Set();
	const walk = (n) => {
		if (closure.has(n)) return;
		closure.add(n);
		for (const d of deps.get(n) ?? []) walk(d);
	};
	walk("@vincemakes/kiso-code");
	if (closure.size < 2) errs.push("the kiso-code closure read back empty — a failed read");
	if (closure.has("@vincemakes/kiso-web")) errs.push("kiso-code's runtime closure reaches @vincemakes/kiso-web — the terminal install must not carry the web app");

	// And the script must not have gone back to naming them.
	const script = readFileSync(resolve(ROOT, "bench/packed-pty-smoke.sh"), "utf8");
	// Comments are stripped: this gate scans text, and text includes the prose
	// about the gate — its first version failed on its own comment.
	const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
	const named = [...new Set(code.match(/@vincemakes\/[a-z0-9-]+/g) ?? [])];
	if (named.length > 0) errs.push(`packed-pty-smoke.sh NAMES ${named.length} packages again (${named.join(", ")}) — it must derive the closure`);
	// It must install them together: one at a time asks the registry for pins
	// that are not published yet, which fails at exactly the release ceremony
	// this script exists for.
	if (/for tgz in \$PACKED/.test(code)) errs.push("packed-pty-smoke.sh installs the closure ONE AT A TIME — a lockstep release's pins are not on the registry yet; install the set together");

	if (errs.length) {
		console.error("[packed-closure] FAIL:");
		for (const e of errs) console.error(`  ${e}`);
		process.exit(1);
	}
	console.log(`[packed-closure] OK — ${derived.length} publishable packages, agreed by two independent enumerations; the packed smoke derives them and installs them together`);
}
