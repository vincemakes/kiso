#!/usr/bin/env node
/**
 * Publish-artifact gate: every publishable package's tarball must contain
 * compiled JS + .d.ts and never raw TypeScript. Exports point at dist — a
 * tarball that ships src/*.ts would work only for consumers running tsx,
 * which is exactly the failure Reliable Session Alpha must not ship.
 */

import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = ["@kiso/core", "@kiso/evals", "@kiso/provider-anthropic", "@kiso/provider-openai"];

let failed = false;
for (const name of PACKAGES) {
	const out = execSync(`npm pack --dry-run --json -w ${name}`, { cwd: ROOT, encoding: "utf8" });
	const parsed = JSON.parse(out.slice(out.indexOf("[")));
	const files = parsed[0]?.files ?? [];
	const bad = files.filter((f) => f.path.endsWith(".tsx") || (f.path.endsWith(".ts") && !f.path.endsWith(".d.ts")));
	const missingDist = !files.some((f) => f.path.startsWith("dist/"));
	if (bad.length > 0 || missingDist) {
		failed = true;
		console.error(`✗ ${name}: tarball ${missingDist ? "has no dist/ output" : "contains raw TS"}`, bad.map((f) => f.path));
	} else {
		console.log(`✓ ${name}: ${files.length} files, dist-only, no raw TS`);
	}
}
if (failed) process.exit(1);
