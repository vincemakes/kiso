/**
 * 0.51.0 — the coding agent never sets `contextPolicy.checkpointSections`.
 * The field is the SDK host's; with it absent the runtime takes the 0.50.0
 * constants, so the kiso CLI's checkpoint requests stay byte-identical
 * (plan-checkpoint-sections rev 2.1 §6). A pin on the source: an edit that
 * wires the field into the coding agent must be a decision, not an accident.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the coding agent leaves checkpointSections alone", () => {
	it("no source file of the CLI mentions it", () => {
		for (const f of ["create-coding-agent.ts", "index.ts", "state.ts", "chat.ts"]) {
			const text = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
			expect(text.includes("checkpointSections"), f).toBe(false);
		}
	});
});
