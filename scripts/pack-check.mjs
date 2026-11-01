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
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = [
	"@vincemakes/kiso-core",
	"@vincemakes/kiso-evals",
	"@vincemakes/kiso-runtime",
	// R3 (2026-09-23): the hosted-session service.
	// R4 (2026-09-23): the wire contract, zero dependencies.
	"@vincemakes/kiso-protocol",
	"@vincemakes/kiso-server",
	// R5 (2026-09-24): the typed client over the wire contract.
	"@vincemakes/kiso-client",
	"@vincemakes/kiso-tools-node",
	"@vincemakes/kiso-provider-anthropic",
	"@vincemakes/kiso-provider-openai",
	// OR-1: the 15th package — the Responses adapter (the ChatGPT target's
	// only usable half; the manifest advertised its apiId since 0.15).
	"@vincemakes/kiso-provider-openai-responses",
	"@vincemakes/kiso-code",
	"@vincemakes/kiso-mcp-ext",
	"@vincemakes/kiso-skills-ext",
	"@vincemakes/kiso-subagent-ext",
	// KC3.5: the 14th package — the ask extension (built-in #4).
	"@vincemakes/kiso-ask-ext",
	// rel-031: the two TUI packages were published by every release ritual
	// but never listed here (carried from the Responses adapter review).
	"@vincemakes/kiso-tui-cells",
	"@vincemakes/kiso-tui",
	// W2 (2026-11-01): the 18th package, the local web app. Its page is a static bundle built by
	// vite into out/renderer; React and vite are build tools and must never reach the installed closure.
	"@vincemakes/kiso-web",
];
const WEB = "@vincemakes/kiso-web";
const WEB_PAGE = ["out/renderer/index.html", "out/renderer/manifest.webmanifest", "out/renderer/icon.png"];
const BUILD_ONLY = /^(react|react-dom|vite|@vitejs\/.*|@types\/.*|typescript)$/;

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
	// kiso-web: the page itself ships (a tarball without it serves a 404), no source maps, and no build tool
	// among the runtime dependencies.
	const webProblems = [];
	if (name === WEB) {
		const manifest = JSON.parse(readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"));
		for (const p of WEB_PAGE) if (!paths.includes(p)) webProblems.push(`missing ${p}`);
		if (!paths.some((p) => /^out\/renderer\/assets\/.+\.js$/.test(p))) webProblems.push("missing the page bundle");
		const maps = paths.filter((p) => p.endsWith(".map"));
		if (maps.length > 0) webProblems.push(`ships source maps ${JSON.stringify(maps)}`);
		const tools = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((d) => BUILD_ONLY.test(d));
		if (tools.length > 0) webProblems.push(`build tools in dependencies ${JSON.stringify(tools)}`);
	}
	if (bad.length > 0 || rawSrc.length > 0 || missingDist || missingReadme || missingLicense || webProblems.length > 0) {
		failed = true;
		console.error(
			`✗ ${name}: ${missingDist ? "has no dist/ output" : ""} ${missingReadme ? "missing README" : ""} ${missingLicense ? "missing LICENSE" : ""} ${bad.length ? "contains raw TS " + JSON.stringify(bad) : ""} ${rawSrc.length ? "ships raw src/ " + JSON.stringify(rawSrc) : ""} ${webProblems.join(", ")}`,
		);
	} else {
		console.log(`✓ ${name}: ${files.length} files, dist + README + LICENSE, no raw TS`);
	}
}
if (failed) process.exit(1);
