/**
 * ADR-0063 M0.5 — the reachability gate (M0.5 spec § 5). Historical
 * retrieval must not move a request byte. The wire fixture and the rent
 * ratchet sample requests; this gate proves the stronger statement: no
 * shipped source imports effective history or retrieval, so no run, no
 * request and no tool table can reach them. The only importer allowed is
 * retrieval itself (of effective history). M1 (the recall tool) is the
 * round that changes this list, with its own BM-1 § 3 tool-schema gates.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const INTERNAL = /["'][^"']*\/(effective-history|history-search)(\.js)?["']/;
const ALLOWED = new Set(["packages/runtime/src/history-search.ts"]);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const p = join(dir, d.name);
		if (d.isDirectory()) return d.name === "node_modules" || d.name === "dist" ? [] : sources(p);
		return /\.(ts|tsx|mts|js|mjs)$/.test(d.name) ? [p] : [];
	});
}

describe("M0.5 reachability", () => {
	it("no shipped source imports effective history or retrieval", () => {
		const srcDirs = ["packages", "apps", "extensions"].flatMap((tier) =>
			readdirSync(join(ROOT, tier), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ROOT, tier, d.name, "src")),
		);
		const importers = srcDirs
			.flatMap((d) => {
				try {
					return sources(d);
				} catch {
					return [];
				}
			})
			.filter((f) => INTERNAL.test(readFileSync(f, "utf8")))
			.map((f) => relative(ROOT, f))
			.filter((f) => !ALLOWED.has(f));
		expect(importers).toEqual([]);
	});

	it("the gate sees an import when there is one", () => {
		expect(INTERNAL.test('import { searchHistory } from "./history-search.js";')).toBe(true);
		expect(INTERNAL.test('export * from "./effective-history.js";')).toBe(true);
		expect(INTERNAL.test('import { x } from "./history.js";')).toBe(false);
	});
});
