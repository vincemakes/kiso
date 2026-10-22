/**
 * The ./policy door: the coding product's prompt, tool rules and policy
 * extensions as a library, for a host that is not the terminal.
 *
 * SAFETY: nothing here runs a shell. The floor's decision is a pure parse of
 * the command line, and the catastrophic target is this test's own fresh
 * temporary directory by its absolute path, never the home directory.
 */

import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODING_TOOL_RULES, SYSTEM_PROMPT, composeSystemPrompt, floorExtension, modeExtensions, OFFERED_MODES } from "../src/policy.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("the policy door", () => {
	it("hands out the prompt, the tool rules and the extensions", () => {
		const ws = realpathSync(mkdtempSync(join(tmpdir(), "kiso-policy-door-")));
		expect(composeSystemPrompt(ws)).toBe(SYSTEM_PROMPT);
		expect(CODING_TOOL_RULES.map((r) => r.tool)).toEqual(["read_file", "search_text", "list_dir", "shell"]);
		expect(OFFERED_MODES.length).toBeGreaterThan(0);
		expect(modeExtensions(() => ws).length).toBeGreaterThan(0);
	});

	it("the floor, taken from the door alone, refuses a catastrophe and abstains on an ordinary command", () => {
		const ws = realpathSync(mkdtempSync(join(tmpdir(), "kiso-policy-door-")));
		const floor = floorExtension(() => true, () => ws);
		const decide = floor.approvals![0]!.decide;
		const refused = decide({ name: "shell", input: { command: `rm -rf ${ws}` } }, {} as never);
		expect(refused).toMatchObject({ action: "deny" });
		expect(decide({ name: "shell", input: { command: "ls" } }, {} as never)).toEqual({ action: "abstain" });
	});

	it("the door's import closure never reaches the terminal's state (and so never the TUI)", () => {
		const seen = new Set<string>();
		const packages = new Set<string>();
		const walk = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			// type-only imports are erased from the build; only value imports load code
			const text = readFileSync(file, "utf8").replace(/(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["'];?/gs, "");
			for (const m of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
				const spec = m[1]!;
				if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
				else packages.add(spec);
			}
		};
		walk(join(src, "policy.ts"));
		const names = [...seen].map((f) => f.slice(src.length + 1));
		expect(names).not.toContain("state.ts");
		expect([...packages].filter((p) => p.startsWith("@vincemakes/")).sort()).toEqual(["@vincemakes/kiso-tools-node"]);
	});
});
