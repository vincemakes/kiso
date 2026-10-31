// The public-surface import gate: the web app may import the kiso packages
// only through their `exports` — never a deep path, never a relative path
// into another workspace, and `/internal` doors only where listed below.
// Run by `npm run check`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const repo = resolve(root, "../..");
const WEB = /(\bapps\/web\b|@vincemakes\/kiso-web)/;

/** file (relative to apps/web) → the internal specifiers it may import. */
const INTERNAL_ALLOWED = {
	"src/main/tasks.ts": ["@vincemakes/kiso-runtime/internal"],
};

/** workspace package name → its `exports` keys (null: no exports map). */
const packages = new Map();
for (const base of ["packages", "apps"]) {
	for (const dir of readdirSync(join(repo, base))) {
		try {
			const json = JSON.parse(readFileSync(join(repo, base, dir, "package.json"), "utf8"));
			packages.set(json.name, json.exports === undefined ? null : Object.keys(json.exports));
		} catch {
			// not a package
		}
	}
}
const exportsOf = (pkg) => packages.get(pkg);

const files = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		if (name === "dist" || name === "node_modules") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(ts|mjs|js)$/.test(name)) files.push(p);
	}
};
for (const d of ["src", "scripts"]) walk(join(root, d));
const gates = "scripts/gates/imports.mjs";

const problems = [];
const used = new Map();
for (const file of files) {
	const rel = relative(root, file);
	const text = readFileSync(file, "utf8");
	for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
		const spec = m[1];
		if (spec.startsWith(".")) {
			const target = resolve(dirname(file), spec);
			if (!target.startsWith(root)) problems.push(`${rel}: relative import leaves apps/web: ${spec}`);
			continue;
		}
		const k = /^(@vincemakes\/[a-z-]+)(\/.*)?$/.exec(spec);
		if (k === null) continue;
		const [, pkg, sub] = k;
		const subpath = sub === undefined ? "." : `.${sub}`;
		const exported = exportsOf(pkg);
		if (exported === undefined) problems.push(`${rel}: unknown workspace package ${pkg}`);
		else if (exported === null || !exported.includes(subpath)) problems.push(`${rel}: ${spec} is not in ${pkg}'s exports`);
		else if (subpath === "./internal" && !(INTERNAL_ALLOWED[rel] ?? []).includes(spec)) problems.push(`${rel}: ${spec} is an internal door and this file is not allowed to use it`);
		used.set(spec, (used.get(spec) ?? 0) + 1);
	}
}
// the other half: nothing outside apps/web imports from it
import { execFileSync } from "node:child_process";
for (const f of execFileSync("git", ["ls-files", "--", "packages", "apps/cli", "extensions"], { cwd: repo, encoding: "utf8" }).split("\n")) {
	if (!/\.(ts|tsx|js|mjs)$/.test(f) || f.includes("/dist/")) continue;
	for (const m of readFileSync(join(repo, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) if (WEB.test(m[1])) problems.push(`${f}: imports from the web app (${m[1]}); the dependency runs one way`);
}
for (const [spec, n] of [...used].sort()) console.log(`${String(n).padStart(3)}  ${spec}`);
if (problems.length > 0) {
	console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`\nimport gate: ${files.length} files, ${used.size} distinct kiso specifiers, 0 problems`);
