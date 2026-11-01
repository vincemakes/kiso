// Dependency gate: DEPS.md and package.json must list the same packages. A new dependency is a plan change.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
// the first cell of each table row names the package(s) in backticks
const listed = new Set();
for (const row of readFileSync("DEPS.md", "utf8").split("\n")) if (row.startsWith("| `")) for (const m of row.split("|")[1].matchAll(/`([^`]+)`/g)) listed.add(m[1]);
const problems = [
	...[...declared].filter((d) => !listed.has(d)).map((d) => `${d}: in package.json, not in DEPS.md (add a line saying why, after a plan change)`),
	...[...listed].filter((d) => !declared.has(d)).map((d) => `${d}: in DEPS.md, not in package.json`),
	...Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([d, v]) => !d.startsWith("@vincemakes/") && /^[\^~]/.test(v) && !["typescript", "@types/node"].includes(d)).map(([d, v]) => `${d}: "${v}" is a range; pin it exactly`),
];
if (problems.length > 0) {
	console.error(`[deps] ${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`[deps] OK: ${declared.size} dependencies, each listed in DEPS.md with its reason`);
