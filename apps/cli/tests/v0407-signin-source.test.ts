import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

/**
 * 0406-F1 — the typed `/model` list names what PAYS, not what could.
 *
 * The row's sign-in note named the profile's `apiKeyEnv` whenever it had
 * one, so a profile paid by the stored key read `DEEPSEEK_API_KEY
 * (available)` with that variable unset — seen in the 0.40.6 agent
 * dogfood. After `kiso login --endpoint` every gateway row would have named
 * a variable nobody exports any more. The note follows the resolver
 * (`authForProfile`): the store first, then the env var, then nothing.
 *
 * The built CLI on a pipe, one isolated home, every source side by side.
 */
describe("0406-F1: each /model row names the credential that pays", () => {
	it("stored (vendor or gateway) → `stored key`; env only → the var; neither → the var, unavailable; keyless → `no key`", () => {
		const { dirs, env } = isolatedEnv({ GW_B_KEY: "fake-b", DS_ALSO_ENV: "fake-env" });
		writeFileSync(
			join(dirs.home, "config.json"),
			JSON.stringify({
				model: "ds",
				models: {
					ds: { kind: "openai-compat", model: "deepseek-flash", apiKeyEnv: "DS_UNSET", baseUrl: "https://api.deepseek.com" },
					ds2: { kind: "openai-compat", model: "deepseek-flash", apiKeyEnv: "DS_ALSO_ENV", baseUrl: "https://api.deepseek.com" },
					gwa: { kind: "openai-compat", model: "m", apiKeyEnv: "GW_A_UNSET", baseUrl: "https://gateway-a.example/v1" },
					gwb: { kind: "openai-compat", model: "m", apiKeyEnv: "GW_B_KEY", baseUrl: "https://gateway-b.example/v1" },
					gwc: { kind: "openai-compat", model: "m", apiKeyEnv: "GW_C_UNSET", baseUrl: "https://gateway-c.example/v1" },
					local: { kind: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:11434/v1" },
				},
			}),
		);
		writeFileSync(
			join(dirs.home, "auth.json"),
			JSON.stringify({
				version: 1,
				credentials: {
					deepseek: { type: "api-key", key: "DUMMY_VENDOR", savedAt: 1 },
					"endpoint:https://gateway-a.example": { type: "api-key", key: "DUMMY_GW_A", savedAt: 1 },
				},
			}),
			{ mode: 0o600 },
		);
		const out = runCli(["chat", "f1-rows"], env, { input: "/model\nexit\n" }).stdout;
		const row = (name: string): string => {
			const r = out.split("\n").find((l) => l.startsWith(`  ${name} → `));
			expect(r, `no row for ${name}:\n${out}`).toBeDefined();
			return r!;
		};
		expect(row("ds"), "the vendor's stored key pays; its env var is unset").toContain("· stored key (available)");
		expect(row("ds2"), "stored beats a set env var — the store owns its provider").toContain("· stored key (available)");
		expect(row("gwa"), "the gateway's own stored key").toContain("· stored key (available)");
		expect(row("gwb"), "nothing stored: the env var pays, and is named").toContain("· GW_B_KEY (available)");
		expect(row("gwc"), "neither: the var that WOULD sign it in").toContain("· GW_C_UNSET (unavailable)");
		expect(row("local")).toContain("· no key (available)");
		expect(out, "no key value is ever printed").not.toMatch(/DUMMY_|fake-/);
	});
});
