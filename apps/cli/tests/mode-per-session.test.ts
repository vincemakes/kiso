/**
 * The tier in force is a parameter with the process's own tier as its default: a host that holds several sessions (the desktop app)
 * gives each one its own, the terminal passes nothing and is unchanged.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getMode, modeExtensions, modeSystemPrompt, setMode } from "../src/mode.js";
import type { Mode } from "../src/mode.js";

const write = { name: "write_file", input: { path: "a.txt", content: "x" } };

/** What the chain decides: the verdicts of every tier's extension, the abstentions dropped. */
async function decide(extensions: ReturnType<typeof modeExtensions>): Promise<string[]> {
	const out: string[] = [];
	for (const ext of extensions) for (const rule of ext.approvals ?? []) {
		const verdict = await rule.decide(write as never, {} as never);
		if (verdict.action !== "abstain") out.push(verdict.action);
	}
	return out;
}

describe("a tier per session", () => {
	afterEach(() => setMode("default"));

	it("two sessions in one process get opposite verdicts for the same call", async () => {
		const plan = modeExtensions(() => "/work", () => "plan");
		const full = modeExtensions(() => "/work", () => "full-access");
		expect(await decide(plan)).toEqual(["deny"]);
		expect(await decide(full)).toEqual(["allow"]);
	});

	it("the tier is read on every decision: a switch takes effect at the next one", async () => {
		let tier: Mode = "plan";
		const ext = modeExtensions(() => "/work", () => tier);
		expect(await decide(ext)).toEqual(["deny"]);
		tier = "full-access";
		expect(await decide(ext)).toEqual(["allow"]);
	});

	it("with no getter the process's own tier decides, as before", async () => {
		setMode("accept-edits");
		expect(await decide(modeExtensions(() => "/work"))).toEqual(["allow"]);
		setMode("plan");
		expect(await decide(modeExtensions(() => "/work"))).toEqual(["deny"]);
		expect(getMode()).toBe("plan");
	});

	it("the plan note follows the tier given, else the process's", () => {
		expect(modeSystemPrompt("plan")).toContain("plan mode: read-only");
		expect(modeSystemPrompt("full-access")).toBeUndefined();
		setMode("plan");
		expect(modeSystemPrompt()).toContain("plan mode: read-only");
		setMode("default");
		expect(modeSystemPrompt()).toBeUndefined();
	});

	it("an unknown tier from a getter abstains everywhere, so the chain falls to asking, never to allowing", async () => {
		expect(await decide(modeExtensions(() => "/work", () => "no-such-tier" as Mode))).toEqual([]);
	});
});
