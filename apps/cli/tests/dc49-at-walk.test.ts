/**
 * DC-49 — the `@` picker and the home workspace.
 *
 * The two walkers do NOT agree, and the difference is why this case
 * exists. `tools-node`'s walk skips every `.`-name, which is how
 * `~/.kiso` escapes it — by accident. `atWalk` skips by NAME only:
 *
 *   AT_SKIP = { ".git", "node_modules", "dist", "build", "coverage" }
 *
 * No dot rule at all. So with the workspace at `~` and no git repo
 * there — which is the ordinary case for a home directory — `@` lists
 * the user's own session logs among their files. That is CURRENT
 * behaviour, not a future risk, and it is what this gate closes.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atWalkFor } from "../src/state.js";

function tree(): { root: string; excluded: string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-dc49-at-"));
	// NOT a dot-directory: `atWalk` has no dot rule, but tools-node does,
	// and a fixture that relies on the dot would hide which walker is
	// under test.
	const excluded = join(root, "kisostate");
	mkdirSync(join(excluded, "sessions"), { recursive: true });
	writeFileSync(join(excluded, "sessions", "s1.jsonl"), "a session\n");
	mkdirSync(join(root, "project"), { recursive: true });
	writeFileSync(join(root, "project", "main.ts"), "const x = 1;\n");
	return { root, excluded };
}

describe("DC-49 — the @ picker does not list kiso's own state", () => {
	it("NON-VACUITY: without the exclusion it DOES list the session log", () => {
		const { root } = tree();
		expect(atWalkFor(root, []).some((p) => p.endsWith("s1.jsonl"))).toBe(true);
	});

	it("with the exclusion the session log is gone, and the work remains", () => {
		const { root, excluded } = tree();
		const out = atWalkFor(root, [excluded]);
		expect(out.some((p) => p.endsWith("s1.jsonl")), "the excluded root was walked").toBe(false);
		expect(out.some((p) => p.endsWith("main.ts")), "the exclusion took the real work too").toBe(true);
	});

	it("a symlinked root still matches — realpath on both sides", () => {
		// darwin's /tmp is a symlink to /private/tmp, so a raw string
		// compare is a gate that passes on one machine and not another.
		const { root, excluded } = tree();
		const out = atWalkFor(root, [excluded.replace("/private/", "/")]);
		expect(out.some((p) => p.endsWith("s1.jsonl"))).toBe(false);
	});
});
