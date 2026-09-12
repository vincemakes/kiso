import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string): string => readFileSync(root(p), "utf8");

/**
 * Astra F10 — THE README'S OWN FACTS HAD DRIFTED.
 *
 * The counts were a release and a half out of date, and the kernel-rule
 * paragraph claimed CI enforces the size limit "before it installs a single
 * dependency". It does not: the workflow installs from the lockfile and
 * THEN runs the check chain, with the size gate inside it after build,
 * typecheck and the tests. The rule is real; the mechanism described was
 * not.
 *
 * These check the facts that can be checked MECHANICALLY — the ADR count
 * and the workflow's order — rather than re-stating the numbers, which is
 * how a count drifts in the first place. The test counts themselves are
 * measured by hand at release and stated in the report.
 */
describe("F10: the README's checkable facts are true", () => {
	it("the ADR count matches the directory", () => {
		const adrs = readdirSync(root("docs/adrs")).filter((f) => f.endsWith(".md") && f !== "README.md");
		for (const [name, text] of [["README.md", read("README.md")], ["README.zh.md", read("README.zh.md")]] as const) {
			// "39 ADRs" in one edition, "39 <counter> ADR" in the other.
			expect(text, `${name}: ADR count is not ${adrs.length}`).toMatch(new RegExp(`${adrs.length}[^\\n]{0,4}ADR`));
		}
	});

	it("CI really does install BEFORE the check chain — the order the README now states", () => {
		const ci = read(".github/workflows/ci.yml");
		const install = ci.indexOf("npm ci");
		const check = ci.indexOf("npm run check");
		expect(install).toBeGreaterThanOrEqual(0);
		expect(check).toBeGreaterThan(install);
	});

	it("the size gate is INSIDE the chain, after build, typecheck and the tests", () => {
		const chain = JSON.parse(read("package.json")).scripts.check as string;
		const at = (s: string): number => chain.indexOf(s);
		expect(at("npm run size")).toBeGreaterThan(at("npm run build"));
		expect(at("npm run size")).toBeGreaterThan(at("npm run typecheck"));
		expect(at("npm run size")).toBeGreaterThan(at("npm run test"));
	});

	it("the old claim — enforced before a single dependency is installed — is gone from both editions", () => {
		expect(read("README.md")).not.toContain("before it installs a");
		// "before installing any dependency", as an escape: the tree is English-only.
		expect(read("README.zh.md")).not.toContain("\u5b89\u88c5\u4efb\u4f55\u4f9d\u8d56\u4e4b\u524d");
	});

	it("the core figure the README prints is the one the gate measures", () => {
		const out = execFileSync(process.execPath, [root("scripts/check-size.mjs")], { encoding: "utf8" });
		const m = /total\s+(\d+)\s+\/\s+(\d+)/.exec(out);
		expect(m, "check-size printed no core total").not.toBeNull();
		const [, total, cap] = m as RegExpExecArray;
		const en = read("README.md");
		expect(en, `core total ${total} is not in the README`).toContain(`${Number(total).toLocaleString("en-US")} of ${Number(cap).toLocaleString("en-US")}`);
		// and the opening says CAPPED, not that the kernel IS the cap
		expect(en).toContain(`capped at ${Number(cap).toLocaleString("en-US")}`);
	});
});
