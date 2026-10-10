/**
 * Merge round B — the config surface, unit-tested: the five-layer precedence
 * chain (flags > env > project config > user config > default), loud
 * failure on broken JSON / invalid known values, the credential
 * discipline (configs only NAME an env var; an unset env marks a profile
 * unavailable, never a crash), and the provider/model direct write.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let home: string;

beforeEach(() => {
	saveEnv("OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "KISO_MODE", "KISO_CONTEXT_WINDOW", "KISO_AUTO_COMPACT", "DEEPSEEK_API_KEY", "KISO_HOME");
	// Hermetic: the HOST shell may legitimately export model vars (e.g.
	// ANTHROPIC_MODEL) — the precedence tests must never see them.
	delete process.env.OPENAI_MODEL;
	delete process.env.ANTHROPIC_MODEL;
	delete process.env.OPENAI_BASE_URL;
	// Hermetic: the user config read must never touch the developer's real
	// home — the first-run scaffold writes ~/.kiso/config.json the first
	// time the CLI runs there, so the loadUserConfig null contract needs a
	// truly empty home, not "the real home happens to have no file yet".
	home = mkdtempSync(join(tmpdir(), "kiso-config-test-"));
	process.env.KISO_HOME = home;
});
afterEach(() => {
	restoreEnv();
	if (home) rmSync(home, { recursive: true, force: true });
});

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

	it("maxWakes (finding 0480-F9): a whole number, 0 or more — 0 is legal (never wake); anything else is loud", () => {
		for (const n of [0, 1, 20, 100]) expect(parseConfig(JSON.stringify({ maxWakes: n }), "test").maxWakes, String(n)).toBe(n);
		for (const bad of [-1, 1.5, "3", null]) expect(() => parseConfig(JSON.stringify({ maxWakes: bad }), "test"), JSON.stringify(bad)).toThrow(/maxWakes — expected a whole number, 0 or more/);
	});

	it("the modes round: full-access and every old name parse as written; dontAsk is a boolean switch; the rest is loud", () => {
		for (const mode of ["full-access", "accept-edits", "bypass", "dontAsk", "manual", "full access"]) expect(parseConfig(JSON.stringify({ mode }), "test").mode, mode).toBe(mode);
		expect(parseConfig(JSON.stringify({ dontAsk: true }), "test").dontAsk).toBe(true);
		expect(parseConfig(JSON.stringify({ dontAsk: false }), "test").dontAsk).toBe(false);
		expect(() => parseConfig(JSON.stringify({ dontAsk: "yes" }), "test")).toThrow(/dontAsk — expected true or false/);
		expect(() => parseConfig(JSON.stringify({ mode: "yolo" }), "test")).toThrow(/mode — expected one of .*full-access.*bypass, dontAsk/);
		// 0.46.2 supersedes "either layer may set the switch": a project may
		// turn it on, never off (project-config-tighten-only.test.ts)
		expect(() => mergeConfigs({ dontAsk: true }, { dontAsk: false })).toThrow(/don't-ask on, never off/);
		expect(mergeConfigs({ dontAsk: true }, {}).dontAsk).toBe(true);
		expect(mergeConfigs({}, { dontAsk: true }).dontAsk).toBe(true);
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
		// PH-1c (finding PH-F19, a DECLARED SUPERSESSION of the old
		// apiKeyEnv-required rule): an ABSENT apiKeyEnv is a valid keyless
		// profile (an unauthenticated local endpoint — Ollama needs no
		// dummy env var); an EMPTY one is still a loud typo.
		expect(() => parseConfig('{"models": {"a": {"kind": "openai-compat", "model": "x"}}}', "t")).not.toThrow();
		expect(() => parseConfig('{"models": {"a": {"kind": "openai-compat", "model": "x", "apiKeyEnv": ""}}}', "t")).toThrow(ConfigError);
	});
});

describe("the five-layer precedence chain (flags > env > project > user > default)", () => {
	const profiles = {
		deepseek: { kind: "openai-compat" as const, model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
		local: { kind: "anthropic" as const, model: "claude-sonnet-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
	};
	const user = { models: profiles, model: "deepseek" };
	// 0.46.2: a project picks one of the user's profiles, never defines one
	const project = { model: "local" };

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
		const u = { models: { ...profiles, local: { kind: "openai-compat" as const, model: "local-model", apiKeyEnv: "DEEPSEEK_API_KEY" } }, model: "deepseek" };
		process.env.DEEPSEEK_API_KEY = "sk-y";
		const r = resolveModel(undefined, mergeConfigs(u, project));
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

	// 0.46.2 supersedes "models merge by name" and a project mode looser
	// than the user's: a project picks a profile and may only tighten
	it("mergeConfigs: project wins per key; the profiles are the user's", () => {
		const m = mergeConfigs(
			{ models: { a: { kind: "openai-compat" as const, model: "a1", apiKeyEnv: "K_A" } }, model: "a", mode: "accept-edits" },
			{ model: "a", mode: "plan" },
		);
		expect(m.mode).toBe("plan");
		expect(m.model).toBe("a");
		expect(Object.keys(m.models ?? {})).toEqual(["a"]);
	});
});

describe("protectedPaths: user config only, loud everywhere else", () => {
	// `~/` is read against HOME: the temp home, never the real one
	beforeEach(() => {
		saveEnv("HOME");
		process.env.HOME = home;
	});

	it("the user config names files kiso guards — absolute or ~/", () => {
		// an absolute path for the platform (a drive path on Windows)
		const KEYS = process.platform === "win32" ? "C:\\srv\\keys.env" : "/srv/keys.env";
		expect(parseConfig(JSON.stringify({ protectedPaths: [KEYS, "~/notes/secret.md"] }), "~/.kiso/config.json").protectedPaths).toEqual([KEYS, "~/notes/secret.md"]);
	});

	it("a project config naming it fails loudly, whatever it holds — a project must never change what kiso guards", () => {
		expect(() => parseConfig(JSON.stringify({ protectedPaths: [] }), "<cwd>/.kiso/config.json")).toThrow(/protectedPaths — belongs in the USER config/);
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["/x"] }), "<cwd>/.kiso/config.json")).toThrow(ConfigError);
	});

	it("a DIRECTORY fails loudly — it would protect nothing under it, and silently", () => {
		// the temp home this file's beforeEach made: an existing directory
		expect(() => parseConfig(JSON.stringify({ protectedPaths: [home] }), "~/.kiso/config.json")).toThrow(/protectedPaths\[0\] — .* is a directory — kiso protects files/);
		// spelled as one, whether or not it exists
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["~/.aws/"] }), "~/.kiso/config.json")).toThrow(/is a directory/);
		// a file that does not exist yet is accepted: it is protected from the moment it appears
		expect(parseConfig(JSON.stringify({ protectedPaths: [join(home, "later.txt")] }), "~/.kiso/config.json").protectedPaths).toEqual([join(home, "later.txt")]);
	});

	it("a relative path, or not a list, fails loudly", () => {
		expect(() => parseConfig(JSON.stringify({ protectedPaths: ["secret.md"] }), "~/.kiso/config.json")).toThrow(/protectedPaths\[0\]/);
		expect(() => parseConfig(JSON.stringify({ protectedPaths: "~/x" }), "~/.kiso/config.json")).toThrow(/expected an array/);
	});
});
