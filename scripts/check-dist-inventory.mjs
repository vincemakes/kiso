#!/usr/bin/env node
/**
 * Every published .js must have a source.
 *
 * `packages/tui/dist/{body,dock}.js` were build output from 2026-08-07
 * whose TypeScript sources had since been deleted. Nothing imported them,
 * so nothing failed — but `npm pack` does not ask what is live, and both
 * files shipped inside every release from then on, carrying an
 * UNCONDITIONAL `\x1b[?2026h` in a product that had just spent a round
 * making that sequence conditional. Dead code that ships is still a
 * claim about what the package contains.
 *
 * Found while diagnosing REL-0152-D1. The gate is the cheap half of the
 * lesson; the expensive half was that a stale artifact looked exactly
 * like a live one during the investigation and cost a wrong diagnosis.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const orphans = [];

for (const pkg of readdirSync(join(ROOT, "packages"))) {
	const dist = join(ROOT, "packages", pkg, "dist");
	const src = join(ROOT, "packages", pkg, "src");
	if (!existsSync(dist) || !existsSync(src)) continue;
	const walk = (dir, rel = "") => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const next = join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(next, relPath);
				continue;
			}
			if (!entry.name.endsWith(".js")) continue;
			const stem = relPath.replace(/\.js$/, "");
			if (existsSync(join(src, `${stem}.ts`)) || existsSync(join(src, `${stem}.tsx`))) continue;
			orphans.push(`packages/${pkg}/dist/${relPath}`);
		}
	};
	walk(dist);
}

if (orphans.length > 0) {
	console.error("[dist-inventory] RED — published .js with no source (stale build output):");
	for (const o of orphans) console.error(`  ${o}`);
	console.error("[dist-inventory] delete them, or restore the source they came from.");
	process.exit(1);
}

// And the packed tarball must not carry them either — the gate above
// reads the working tree, `npm pack` reads whatever is on disk.
const packed = execFileSync("npm", ["pack", "--dry-run", "--json", "-w", "@vincemakes/kiso-tui"], {
	cwd: ROOT,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "ignore"],
});
const files = (JSON.parse(packed)[0]?.files ?? []).map((f) => f.path);
const shipped = files.filter((f) => /^dist\/(body|dock)\.js$/.test(f));
if (shipped.length > 0) {
	console.error(`[dist-inventory] RED — the tarball still carries ${shipped.join(", ")}`);
	process.exit(1);
}
console.log(`[dist-inventory] OK — every published .js has a source (${files.length} files in the tui tarball)`);
