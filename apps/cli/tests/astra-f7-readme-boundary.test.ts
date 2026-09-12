import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

/**
 * Astra F7's README note — THE CLAIM'S BOUNDARY, WRITTEN DOWN.
 *
 * "stdio children get provider credentials stripped" is true and was not
 * the whole picture. The strip covers the two children a MODEL can cause
 * to run; a subagent's child is kiso itself and inherits on purpose, and
 * the programs a person starts by hand inherit their own environment.
 *
 * The F7 defect existed because one strip had a copy that could not learn
 * the declared names. The README sentence had the matching problem: it was
 * true about a set it never named. Naming the set is what makes it
 * checkable — and this is the gate that checks it stays named.
 *
 * Escapes, not Chinese literals: the tracked tree is English-only
 * (scripts/check-cjk.mjs), README.zh.md excepted. Written out, in order:
 * "subagent", "shell", "inherit".
 */
const ZH = {
	subagent: "subagent",
	shell: "shell",
	inherit: "\u7ee7\u627f",
} as const;

describe("F7: the README says WHICH children are stripped, and which are not", () => {
	it("the English note names both stripped children and the declared-name rule", () => {
		const en = read("README.md");
		expect(en).toContain("Which children are stripped");
		expect(en).toContain("apiKeyEnv");
		expect(en).toContain("_AUTH_TOKEN");
	});

	it("it says plainly what is NOT stripped, rather than letting the sentence imply otherwise", () => {
		const en = read("README.md");
		expect(en).toContain("NOT stripped");
		// the two exceptions, by their reason
		expect(en).toMatch(/subagent/i);
		expect(en).toContain("kiso itself");
		expect(en).toMatch(/EDITOR/);
	});

	it("the Chinese edition carries the same boundary", () => {
		const zh = read("README.zh.md");
		expect(zh).toContain("apiKeyEnv");
		expect(zh).toContain(ZH.subagent);
		expect(zh).toContain(ZH.shell);
		expect(zh).toContain(ZH.inherit);
	});
});
