/**
 * PH-1c — the CLI face of the metadata round (findings PH-F15/PH-F19).
 *
 * (1) The context window follows the LIVE model: /model to a
 *     registry-known model moves the window without an env var; an
 *     unknown model keeps the 200k default (the registry never
 *     guesses); env and config still beat everything.
 * (2) Endpoint freedom: a KEYLESS profile (no apiKeyEnv) is a valid,
 *     always-available profile for unauthenticated local endpoints —
 *     no more dummy env vars for Ollama; ANTHROPIC_BASE_URL retargets
 *     the anthropic dialect the way OPENAI_BASE_URL always could.
 */

import { afterEach, describe, expect, it } from "vitest";
import { contextWindowTokens } from "../src/chat.js";
import { agentModel, setAgentModel, setConfiguredWindow } from "../src/state.js";
import { parseConfig, profileAvailable, resolveModel } from "../src/config.js";

const ORIG_MODEL = agentModel;

afterEach(() => {
	setAgentModel(ORIG_MODEL);
	setConfiguredWindow(undefined);
	delete process.env.KISO_CONTEXT_WINDOW;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_BASE_URL;
	delete process.env.OPENAI_API_KEY;
});

describe("PH-F15 — the window follows the live model", () => {
	it("a registry-known model moves the window; an unknown model keeps the default", () => {
		setAgentModel("claude-sonnet-5");
		expect(contextWindowTokens()).toBe(200_000);
		setAgentModel("gpt-4o");
		expect(contextWindowTokens()).toBe(128_000);
		setAgentModel("some-unregistered-model");
		expect(contextWindowTokens()).toBe(200_000); // the default, not a guess
	});

	it("env and config still beat the registry", () => {
		setAgentModel("gpt-4o");
		process.env.KISO_CONTEXT_WINDOW = "42000";
		expect(contextWindowTokens()).toBe(42_000);
		delete process.env.KISO_CONTEXT_WINDOW;
		setConfiguredWindow(64_000);
		expect(contextWindowTokens()).toBe(64_000);
	});
});

describe("PH-F19 — endpoint freedom", () => {
	it("a KEYLESS profile validates, is always available, and resolves with a placeholder key", () => {
		const cfg = parseConfig(
			JSON.stringify({ model: "local", models: { local: { kind: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3" } } }),
			"~/.kiso/config.json",
		);
		const profile = cfg.models!.local!;
		expect(profile.apiKeyEnv).toBeUndefined();
		expect(profileAvailable(profile)).toBe(true);
		const resolved = resolveModel(undefined, cfg);
		expect(resolved).not.toBeNull();
		expect(resolved!.apiKey).toBe("none");
		expect(resolved!.profile.baseUrl).toBe("http://localhost:11434/v1");
	});

	it("an EMPTY apiKeyEnv is still refused loudly — absent means keyless, empty means a typo", () => {
		expect(() =>
			parseConfig(JSON.stringify({ models: { bad: { kind: "openai-compat", model: "m", apiKeyEnv: "" } } }), "x"),
		).toThrow(/apiKeyEnv/);
	});

	it("PH-1c.1 — promptCaching is a validated profile field, carried on the resolved profile", () => {
		const cfg = parseConfig(
			JSON.stringify({ models: { c: { kind: "anthropic", model: "claude-sonnet-5", apiKeyEnv: "K", promptCaching: true } } }),
			"x",
		);
		expect(cfg.models!.c!.promptCaching).toBe(true);
		expect(() => parseConfig(JSON.stringify({ models: { c: { kind: "anthropic", model: "m", apiKeyEnv: "K", promptCaching: "yes" } } }), "x")).toThrow(
			/promptCaching/,
		);
	});

	it("ANTHROPIC_BASE_URL retargets the anthropic env path, symmetric with OPENAI_BASE_URL", () => {
		process.env.ANTHROPIC_API_KEY = "sk-fake";
		process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
		const resolved = resolveModel(undefined, {});
		expect(resolved).not.toBeNull();
		expect(resolved!.profile.kind).toBe("anthropic");
		expect(resolved!.profile.baseUrl).toBe("https://gateway.example.com");
	});
});
