/**
 * 合并轮 B — the config surface, unit-tested: the five-layer precedence
 * chain (flags > env > project config > user config > default), loud
 * failure on broken JSON / invalid known values, the credential
 * discipline (configs only NAME an env var; an unset env marks a profile
 * unavailable, never a crash), and the provider/model direct write.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
	ConfigError,
	directWriteProfile,
	loadProjectConfig,
	loadUserConfig,
	mergeConfigs,
	parseConfig,
	profileAvailable,
	resolveAutoCompact,
	resolveContextWindow,
	resolveModel,
} from "../src/config.js";

const SAVED_ENV = new Map<string, string | undefined>();

function saveEnv(...names: string[]): void {
	for (const n of names) SAVED_ENV.set(n, process.env[n]);
}
function restoreEnv(): void {
	for (const [n, v] of SAVED_ENV) {
		if (v === undefined) delete process.env[n];
		else process.env[n] = v;
	}
	SAVED_ENV.clear();
}

beforeEach(() => {
	saveEnv("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "KISO_MODE", "KISO_CONTEXT_WINDOW", "KISO_AUTO_COMPACT", "DEEPSEEK_API_KEY");
	// Hermetic: the HOST shell may legitimately export model vars (e.g.
	// ANTHROPIC_MODEL) — the precedence tests must never see them.
	delete process.env.OPENAI_MODEL;
	delete process.env.ANTHROPIC_MODEL;
	delete process.env.OPENAI_BASE_URL;
});
afterEach(() => restoreEnv());

describe("schema v1: parse + loud failure", () => {
	it("parses every known key; unknown keys pass (forward compat)", () => {
		const c = parseConfig(
			JSON.stringify({
				model: "deepseek",
				models: { deepseek: { kind: "openai-compat", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" } },
				mode: "bypass",
				contextWindow: 160000,
				autoCompact: { thresholdRatio: 0.8 },
				projectTrust: "never",
				futureKey: { anything: 1 },
			}),
			"test",
		);
		expect(c.model).toBe("deepseek");
		expect(c.models?.deepseek?.kind).toBe("openai-compat");
		expect(c.mode).toBe("bypass");
		expect(c.contextWindow).toBe(160000);
		expect(c.autoCompact).toEqual({ thresholdRatio: 0.8 });
		expect(c.projectTrust).toBe("never");
	});

	it("broken JSON fails LOUDLY with the source", () => {
		expect(() => parseConfig("{not json", "~/.kiso/config.json")).toThrow(ConfigError);
		expect(() => parseConfig("{not json", "~/.kiso/config.json")).toThrow(/~\/\.kiso\/config\.json/);
	});

	it("invalid known values fail loudly (a typo must not be silently ignored)", () => {
		expect(() => parseConfig('{"mode": "bypaass"}', "t")).toThrow(ConfigError);
		expect(() => parseConfig('{"contextWindow": -5}', "t")).toThrow(ConfigError);
		expect(() => parseConfig('{"projectTrust": "always"}', "t")).toThrow(ConfigError); // no "always" — the ruling
		expect(() => parseConfig('{"models": {"a": {"kind": "openai", "model": "x", "apiKeyEnv": "K"}}}', "t")).toThrow(ConfigError);
		expect(() => parseConfig('{"models": {"a": {"kind": "openai-compat", "model": "x"}}}', "t")).toThrow(ConfigError); // apiKeyEnv required
	});
});

describe("the five-layer precedence chain (flags > env > project > user > default)", () => {
	const profiles = { deepseek: { kind: "openai-compat" as const, model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" } };
	const user = { models: profiles, model: "deepseek" };
	const project = { models: { ...profiles, local: { kind: "anthropic" as const, model: "claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" } }, model: "local" };

	it("default: no flag, no env, no config → faux (null)", () => {
		expect(resolveModel(undefined, {})).toBeNull();
	});

	it("user config resolves when nothing higher speaks", () => {
		process.env.DEEPSEEK_API_KEY = "sk-x";
		const r = resolveModel(undefined, mergeConfigs(user, null));
		expect(r?.name).toBe("deepseek");
		expect(r?.profile.model).toBe("deepseek-v4-flash");
	});

	it("project config beats user config", () => {
		// The profiles key off a NON-top-level env var (DEEPSEEK_API_KEY —
		// the env layer only speaks for OPENAI_*/ANTHROPIC_*), so this test
		// isolates the config-vs-config layer.
		const proj = { models: { ...profiles, local: { kind: "openai-compat" as const, model: "local-model", apiKeyEnv: "DEEPSEEK_API_KEY" } }, model: "local" };
		process.env.DEEPSEEK_API_KEY = "sk-y";
		const r = resolveModel(undefined, mergeConfigs(user, proj));
		expect(r?.name).toBe("local");
		expect(r?.profile.model).toBe("local-model");
	});

	it("env beats BOTH config layers (a key in the environment names the provider)", () => {
		process.env.DEEPSEEK_API_KEY = "sk-x";
		process.env.OPENAI_API_KEY = "sk-env";
		process.env.OPENAI_MODEL = "env-model";
		const r = resolveModel(undefined, mergeConfigs(user, project));
		expect(r?.profile.model).toBe("env-model");
		expect(r?.apiKey).toBe("sk-env");
	});

	it("the --model flag beats EVERYTHING (profile name)", () => {
		process.env.DEEPSEEK_API_KEY = "sk-x";
		process.env.OPENAI_API_KEY = "sk-env";
		const r = resolveModel("deepseek", mergeConfigs(user, project));
		expect(r?.profile.model).toBe("deepseek-v4-flash");
	});

	it("the --model flag beats EVERYTHING (provider/model direct write)", () => {
		process.env.DEEPSEEK_API_KEY = "sk-x";
		process.env.OPENAI_API_KEY = "sk-env";
		const r = resolveModel("openai-compat/from-flag", mergeConfigs(user, project));
		expect(r?.profile.model).toBe("from-flag");
		expect(r?.profile.apiKeyEnv).toBe("OPENAI_API_KEY");
		expect(r?.apiKey).toBe("sk-env");
	});
});

describe("credential discipline: keys never in configs, unset env = unavailable", () => {
	it("a profile whose apiKeyEnv is unset is marked unavailable — and switching to it is refused loudly, never a crash", () => {
		delete process.env.DEEPSEEK_API_KEY;
		const p = { kind: "openai-compat" as const, model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" };
		expect(profileAvailable(p)).toBe(false);
		expect(() => resolveModel("deepseek", { models: { deepseek: p } })).toThrow(ConfigError);
		expect(() => resolveModel("deepseek", { models: { deepseek: p } })).toThrow(/DEEPSEEK_API_KEY/);
		// available with the env set
		process.env.DEEPSEEK_API_KEY = "sk-x";
		expect(profileAvailable(p)).toBe(true);
		expect(resolveModel("deepseek", { models: { deepseek: p } })?.apiKey).toBe("sk-x");
	});

	it("an unknown profile name is a loud error, not a silent fallback", () => {
		expect(() => resolveModel("nope", { models: {} })).toThrow(ConfigError);
		expect(() => resolveModel(undefined, { model: "nope", models: {} })).toThrow(ConfigError);
	});

	it("directWriteProfile accepts only the two providers and a model after the slash", () => {
		expect(directWriteProfile("openai-compat/gpt-4o")?.kind).toBe("openai-compat");
		expect(directWriteProfile("anthropic/claude-sonnet-5")?.kind).toBe("anthropic");
		expect(directWriteProfile("openai/gpt-4o")).toBeNull();
		expect(directWriteProfile("justaname")).toBeNull();
		expect(directWriteProfile("openai-compat/")).toBeNull();
	});
});

describe("the other config keys ride the same precedence", () => {
	it("contextWindow: env > config > default", () => {
		expect(resolveContextWindow({})).toBeUndefined(); // the caller's 200k default applies
		expect(resolveContextWindow({ contextWindow: 64000 })).toBe(64000);
		process.env.KISO_CONTEXT_WINDOW = "32000";
		expect(resolveContextWindow({ contextWindow: 64000 })).toBe(32000);
	});

	it("autoCompact: env > config > off; an invalid env value is OFF (the env layer wins with a no-op)", () => {
		expect(resolveAutoCompact({})).toBeUndefined();
		expect(resolveAutoCompact({ autoCompact: { thresholdRatio: 0.7 } })).toEqual({ thresholdRatio: 0.7 });
		process.env.KISO_AUTO_COMPACT = "0.9";
		expect(resolveAutoCompact({ autoCompact: { thresholdRatio: 0.7 } })).toEqual({ thresholdRatio: 0.9 });
		process.env.KISO_AUTO_COMPACT = "garbage";
		expect(resolveAutoCompact({ autoCompact: { thresholdRatio: 0.7 } })).toBeUndefined();
	});

	it("project config only loads when the trust gate granted (untrusted → never even read)", () => {
		// loadProjectConfig takes the trust verdict; loadUserConfig reads the
		// home file (missing → null, no throw).
		expect(loadProjectConfig("/nonexistent-cwd-xyz", false)).toBeNull();
		expect(loadProjectConfig("/nonexistent-cwd-xyz", true)).toBeNull(); // no file → null
		expect(loadUserConfig()).toBeNull(); // isolated test home has no config
	});

	it("mergeConfigs: project wins per key, models merge by name", () => {
		const m = mergeConfigs(
			{ models: { a: { kind: "openai-compat" as const, model: "a1", apiKeyEnv: "K_A" } }, mode: "manual" },
			{ models: { b: { kind: "anthropic" as const, model: "b1", apiKeyEnv: "K_B" } }, mode: "bypass" },
		);
		expect(m.mode).toBe("bypass");
		expect(Object.keys(m.models ?? {}).sort()).toEqual(["a", "b"]);
	});
});
