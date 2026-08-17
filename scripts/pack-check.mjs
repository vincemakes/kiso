#!/usr/bin/env node
/**
 * Publish-artifact gate: every publishable package's tarball must contain
 * compiled JS + .d.ts and never raw TypeScript. Exports point at dist — a
 * tarball that ships src/*.ts would work only for consumers running tsx,
 * which is exactly the failure Reliable Session Alpha must not ship.
 *
 * R-D 0.1.45: the four official extensions joined the publish surface
 * (decision point A, route 1 — 9→13). Their tarballs are the same closed
 * loop: dist + README + LICENSE, and the "no raw TS" rule also covers
 * their src/*.mjs (ESM source that must never ship raw).
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
	"@vincemakes/kiso-code",
	"@vincemakes/kiso-mcp-ext",
	"@vincemakes/kiso-skills-ext",
	"@vincemakes/kiso-subagent-ext",
	"@vincemakes/kiso-task-ext",
	// KC3.5: the 14th package — the ask extension (built-in #4).
	"@vincemakes/kiso-ask-ext",
];

let failed = false;
for (const name of PACKAGES) {
	const out = execSync(`npm pack --dry-run --json -w ${name}`, { cwd: ROOT, encoding: "utf8" });
	const parsed = JSON.parse(out.slice(out.indexOf("[")));
	const files = parsed[0]?.files ?? [];
	const paths = files.map((f) => f.path);
	const bad = paths.filter((p) => p.endsWith(".tsx") || (p.endsWith(".ts") && !p.endsWith(".d.ts")));
	// R-D 0.1.45: a raw src/ leak ships unbuilt source (the extensions' src
	// is .mjs — the TS-only rule would miss it). No tarball ships src/.
	const rawSrc = paths.filter((p) => p.startsWith("src/"));
	const missingDist = !paths.some((p) => p.startsWith("dist/"));
	// F group: every tarball must actually contain README and LICENSE.
	const missingReadme = !paths.some((p) => p === "README.md" || p.endsWith("/README.md"));
	const missingLicense = !paths.some((p) => p === "LICENSE" || p.endsWith("/LICENSE"));
	if (bad.length > 0 || rawSrc.length > 0 || missingDist || missingReadme || missingLicense) {
		failed = true;
		console.error(
			`✗ ${name}: ${missingDist ? "has no dist/ output" : ""} ${missingReadme ? "missing README" : ""} ${missingLicense ? "missing LICENSE" : ""} ${bad.length ? "contains raw TS " + JSON.stringify(bad) : ""} ${rawSrc.length ? "ships raw src/ " + JSON.stringify(rawSrc) : ""}`,
		);
	} else {
		console.log(`✓ ${name}: ${files.length} files, dist + README + LICENSE, no raw TS`);
	}
}
if (failed) process.exit(1);
