#!/usr/bin/env node
/**
 * Publish-artifact gate: every publishable package's tarball must contain
 * compiled JS + .d.ts and never raw TypeScript. Exports point at dist — a
 * tarball that ships src/*.ts would work only for consumers running tsx,
 * which is exactly the failure Reliable Session Alpha must not ship.
 */

import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = [
	"@vincemakes/kiso-core",
	"@vincemakes/kiso-evals",
	"@vincemakes/kiso-runtime",
	"@vincemakes/kiso-tools-node",
	"@vincemakes/kiso-provider-anthropic",
	"@vincemakes/kiso-provider-openai",
	"@vincemakes/kiso-cli",
];

let failed = false;
for (const name of PACKAGES) {
	const out = execSync(`npm pack --dry-run --json -w ${name}`, { cwd: ROOT, encoding: "utf8" });
	const parsed = JSON.parse(out.slice(out.indexOf("[")));
	const files = parsed[0]?.files ?? [];
	const paths = files.map((f) => f.path);
	const bad = paths.filter((p) => p.endsWith(".tsx") || (p.endsWith(".ts") && !p.endsWith(".d.ts")));
	const missingDist = !paths.some((p) => p.startsWith("dist/"));
	// F 组: every tarball must actually contain README and LICENSE.
	const missingReadme = !paths.some((p) => p === "README.md" || p.endsWith("/README.md"));
	const missingLicense = !paths.some((p) => p === "LICENSE" || p.endsWith("/LICENSE"));
	if (bad.length > 0 || missingDist || missingReadme || missingLicense) {
		failed = true;
		console.error(
			`✗ ${name}: ${missingDist ? "has no dist/ output" : ""} ${missingReadme ? "missing README" : ""} ${missingLicense ? "missing LICENSE" : ""} ${bad.length ? "contains raw TS " + JSON.stringify(bad) : ""}`,
		);
	} else {
		console.log(`✓ ${name}: ${files.length} files, dist + README + LICENSE, no raw TS`);
	}
}
if (failed) process.exit(1);
