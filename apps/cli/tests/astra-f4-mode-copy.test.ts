import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MODES, MODE_NOTE, modeExtensions, setMode } from "../src/mode.js";

/**
 * Astra F4 — "manual — every tool asks" WAS STRONGER THAN THE POLICY.
 *
 * A tier is one voice in a chain that composes `deny > allow > ask`. A tier
 * that ASKS abstains in favour of anything that ALLOWS, so a saved
 * don't-ask-again rule still allows and the side effect runs with no new
 * question. Someone reaching for `manual` as a temporary "ask me about
 * everything" switch was reading it as a REVOCATION, which it is not.
 *
 * The composition ruling is unchanged and is not what this tests. What is
 * tested is that the copy a human reads before handing over the approval
 * gate no longer promises more than the chain delivers — and, so the copy
 * is anchored to behaviour rather than to itself, that `manual` really does
 * ASK rather than DENY, which is precisely why an allow can outrank it.
 */
describe("F4: the mode copy describes the tier's contribution, not the verdict", () => {
	it("every tier that ASKS says a saved allow still allows", () => {
		for (const tier of ["manual", "default", "accept-edits"] as const) {
			expect(MODE_NOTE[tier], tier).toContain("a saved allow still allows");
		}
	});

	it("manual no longer promises that EVERY tool asks, full stop", () => {
		// The exact old string. Its return would be the regression.
		expect(MODE_NOTE.manual).not.toBe("every tool asks");
		expect(MODE_NOTE.manual).toContain("every tool");
	});

	it("the two tiers whose verdict nothing overrides say so, and neither borrows the allow caveat", () => {
		expect(MODE_NOTE.plan).toContain("deny wins");
		expect(MODE_NOTE.bypass).toContain("deny still wins");
		expect(MODE_NOTE.plan).not.toContain("saved allow");
	});

	it("every tier has a note, and none is empty", () => {
		for (const m of MODES) expect(MODE_NOTE[m].length, m).toBeGreaterThan(10);
	});

	it("manual's own verdict is ASK, not DENY — which is WHY a saved allow outranks it", async () => {
		setMode("manual");
		try {
			// The tier's OWN voice, not the chain's: modeExtensions() returns all
			// five (current first), and `plan` legitimately denies.
			const manual = modeExtensions().find((e) => e.name === "mode:manual");
			expect(manual, "mode:manual is not in the chain").toBeDefined();
			const decide = manual?.approvals?.[0]?.decide;
			expect(typeof decide).toBe("function");
			// decide is ASYNC — reading .action off the promise is how this test
			// first failed, which would have been a red for the wrong reason.
			const v = await decide?.({ name: "shell", input: { command: "true" } } as never, undefined as never);
			expect(v?.action).toBe("ask");
			expect(v?.action).not.toBe("deny");
		} finally {
			setMode("default");
		}
	});

	it("the README states the composition and the removal path, in both editions", () => {
		const en = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
		const zh = readFileSync(fileURLToPath(new URL("../../../README.zh.md", import.meta.url)), "utf8");
		for (const [name, text] of [["README.md", en], ["README.zh.md", zh]] as const) {
			expect(text, name).toContain("deny > allow > ask");
			expect(text, name).toContain("dont-ask-again.mjs");
		}
		expect(en).toContain("not a revocation");
	});
});
