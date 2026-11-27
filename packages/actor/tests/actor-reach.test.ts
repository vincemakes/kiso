/**
 * ADR-0064 § 7 — the gates.
 *
 * 1. Reach: no shipped source outside kiso-actor imports it, so no run, no
 *    request and no tool table can reach the work log. A2 is the stage that
 *    first lets a run path reach it.
 * 2. The evidence subpath: only kiso-actor imports `kiso-runtime/evidence`.
 * 3. Public index only, even while private: nothing outside the package,
 *    tests included, imports a deep path of it or reaches into its files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const repoPath = (f: string) => relative(ROOT, f).split(sep).join("/");

function walk(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((d) => {
		const p = join(dir, d.name);
		if (d.isDirectory()) return d.name === "node_modules" || d.name === "dist" ? [] : walk(p);
		return /\.(ts|tsx|mts|js|mjs)$/.test(d.name) ? [p] : [];
	});
}

const tiers = ["packages", "apps", "extensions"].flatMap((tier) =>
	readdirSync(join(ROOT, tier), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => join(ROOT, tier, d.name)),
);
const shipped = () => tiers.flatMap((pkg) => walk(join(pkg, "src")));
const everything = () => [...tiers.flatMap((pkg) => [...walk(join(pkg, "src")), ...walk(join(pkg, "tests"))]), ...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "tests"))];

export const IMPORTS_ACTOR = /["']@vincemakes\/kiso-actor(\/[^"']*)?["']/;
export const DEEP_ACTOR = /["'](@vincemakes\/kiso-actor\/[^"']*|[^"']*packages\/actor\/(src|dist)\/[^"']*|(\.\.\/)+actor\/(src|dist)\/[^"']*)["']/;
export const IMPORTS_EVIDENCE = /["']@vincemakes\/kiso-runtime\/evidence["']/;

const inActor = (f: string) => f.startsWith("packages/actor/");
const matching = (files: string[], re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map(repoPath);

describe("ADR-0064 gates", () => {
	it("reach: no shipped source outside kiso-actor imports it", () => {
		expect(matching(shipped(), IMPORTS_ACTOR).filter((f) => !inActor(f))).toEqual([]);
	});

	it("the evidence subpath has one importer: kiso-actor", () => {
		expect(matching(shipped(), IMPORTS_EVIDENCE).filter((f) => !inActor(f))).toEqual([]);
		expect(matching(shipped(), IMPORTS_EVIDENCE).length).toBeGreaterThan(0);
	});

	it("public index only: nothing outside the package imports a deep path of it", () => {
		expect(matching(everything(), DEEP_ACTOR).filter((f) => !inActor(f))).toEqual([]);
	});

	it("the package exports its index and nothing else", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "packages/actor/package.json"), "utf8")) as { exports: Record<string, unknown>; private?: boolean };
		expect(Object.keys(manifest.exports)).toEqual(["."]);
		expect(manifest.private).toBe(true);
	});

	it("the gates see an import when there is one", () => {
		expect(IMPORTS_ACTOR.test('import { WorkLedger } from "@vincemakes/kiso-actor";')).toBe(true);
		expect(DEEP_ACTOR.test('import { reduceWork } from "@vincemakes/kiso-actor/src/reducer";')).toBe(true);
		expect(DEEP_ACTOR.test('import { reduceWork } from "../../actor/src/reducer.js";')).toBe(true);
		expect(DEEP_ACTOR.test('import { WorkLedger } from "@vincemakes/kiso-actor";')).toBe(false);
		expect(IMPORTS_EVIDENCE.test('import { locateQuote } from "@vincemakes/kiso-runtime/evidence";')).toBe(true);
	});
});
