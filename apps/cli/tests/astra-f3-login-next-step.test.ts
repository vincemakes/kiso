import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

/**
 * Astra F3 — SIGN-IN DOES NOT TAKE A FRESH USER OUT OF THE DEMO.
 *
 * `kiso login` stored the key, said so, and stopped. The very next command
 * still announced the demo and ran the scripted listing, so a person who
 * had just signed in reasonably concluded that sign-in failed or was being
 * ignored. Nothing was broken: a credential is stored under a PROVIDER and
 * a PROFILE selects the model that uses it. The gap was that nobody said so
 * at the one moment it matters.
 *
 * These assert the SUBSTANCE a reader needs — that a profile is the missing
 * thing, where it goes, and a usable example — not an exact sentence.
 */
describe("F3: login says what to do next", () => {
	it("a fresh sign-in names the missing step, the file, and a profile that uses the credential just stored", () => {
		const { env, dirs } = isolatedEnv();
		const r = runCli(["login", "deepseek"], env, { input: "sk-secret-value-9876\n" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("signed in to deepseek");
		// the missing thing, named
		expect(r.stdout).toContain("PROFILE");
		// where it goes
		expect(r.stdout).toContain(join(dirs.home, "config.json"));
		// an example that uses THIS provider, not a generic one
		expect(r.stdout).toContain('"kind":"openai-compat"');
		expect(r.stdout).toContain("https://api.deepseek.com");
		// and how to move between profiles afterwards
		expect(r.stdout).toContain("/model");
		// the key itself is still never echoed
		expect(r.stdout + r.stderr).not.toContain("sk-secret-value-9876");
	});

	it("the example is the SIGNED-IN provider's — anthropic gets the anthropic shape, with no baseUrl to get wrong", () => {
		const { env } = isolatedEnv();
		const r = runCli(["login", "anthropic"], env, { input: "sk-ant-1234\n" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"kind":"anthropic"');
		expect(r.stdout).not.toContain("api.deepseek.com");
	});

	it("someone who ALREADY has a profile is not told to make one", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({ model: "d", models: { d: { kind: "openai-compat", model: "deepseek-flash", baseUrl: "https://api.deepseek.com" } } }),
		);
		const r = runCli(["login", "deepseek"], env, { input: "sk-secret-value-9876\n" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("signed in to deepseek");
		expect(r.stdout).not.toContain("PROFILE does that");
		// it still points at the switch, because that is the useful thing here
		expect(r.stdout).toContain("/model");
	});
});
