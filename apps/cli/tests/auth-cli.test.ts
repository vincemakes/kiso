import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

/** `kiso login / logout / auth` end to end (the built CLI, an isolated home). */
describe("kiso login / logout / auth", () => {
	it("login reads the key from stdin when piped, stores it 0600, never echoes it; auth lists it masked; logout removes it", () => {
		const { env, dirs } = isolatedEnv();
		const login = runCli(["login", "deepseek"], env, { input: "sk-secret-value-9876\n" });
		expect(login.status).toBe(0);
		expect(login.stdout).toContain("signed in to deepseek with an API key (••••9876)");
		expect(login.stdout + login.stderr).not.toContain("sk-secret-value-9876");
		const file = join(dirs.home, "auth.json");
		expect(existsSync(file)).toBe(true);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).credentials.deepseek.key).toBe("sk-secret-value-9876");
		const auth = runCli(["auth"], env);
		expect(auth.status).toBe(0);
		expect(auth.stdout).toContain("deepseek");
		expect(auth.stdout).toContain("••••9876");
		expect(auth.stdout).not.toContain("sk-secret-value-9876");
		const logout = runCli(["logout", "deepseek"], env);
		expect(logout.status).toBe(0);
		expect(logout.stdout).toContain("signed out of deepseek");
		expect(JSON.parse(readFileSync(file, "utf8")).credentials).toEqual({});
		expect(runCli(["logout", "deepseek"], env).stdout).toContain("nothing stored for deepseek");
	});
	it("an unknown provider, a missing provider and an empty key are usage errors naming the choices", () => {
		const { env } = isolatedEnv();
		const bad = runCli(["login", "nope"], env, { input: "k\n" });
		expect(bad.status).not.toBe(0);
		expect(bad.stderr + bad.stdout).toContain("one of: anthropic, openai, deepseek, zai");
		const none = runCli(["login"], env, { input: "k\n" });
		expect(none.status).not.toBe(0);
		const empty = runCli(["login", "openai"], env, { input: "\n" });
		expect(empty.status).not.toBe(0);
		expect(empty.stderr + empty.stdout).toContain("no key given");
	});
	it("a stored key makes a config profile available without its env var; auth says the rule", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(join(dirs.home, "config.json"), JSON.stringify({ models: { ds: { kind: "openai-compat", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY_UNSET_IN_TEST" } } }), "utf8");
		runCli(["login", "deepseek"], env, { input: "sk-stored\n" });
		const auth = runCli(["auth"], env);
		expect(auth.stdout, auth.stderr).toContain("a stored credential owns its provider");
		const help = runCli(["help"], env);
		expect(help.stdout).toContain("kiso login <provider>");
	});
});
