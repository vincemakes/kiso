import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBaseUrl, providerIdOf } from "../src/auth/credentials.js";
import { authForProfile } from "../src/config.js";

/**
 * Astra F1 (P0) — A STORED VENDOR KEY MUST NEVER LEAVE THE VENDOR'S ORIGIN,
 * and "the vendor's origin" must mean the same thing to the credential
 * resolver and to the adapter.
 *
 * The defect: `providerIdOf` read an ABSENT `baseUrl` as the vendor's own
 * endpoint and handed back the STORED vendor key — correct on its own — while
 * the adapter factories passed `baseURL` to the SDK only when the profile
 * NAMED one. With no `baseUrl` the SDK read `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` from the environment itself, so the saved official key went
 * to whatever the environment named.
 *
 * The 0.32.2 R1 fix bound the EXPLICIT-URL path only; this is the absent-URL
 * path, which is the common configuration.
 *
 * The rule these tests pin: ONE resolved effective endpoint per profile,
 * `profile.baseUrl ?? VENDOR_DEFAULT[kind]`, consumed by BOTH sides — so the
 * adapter always receives an explicit URL and the SDK never consults its
 * environment.
 */

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "KISO_HOME", "REVIEW_PROVIDER_TOKEN", "PROXY_KEY"];

beforeEach(() => {
	for (const k of ENV) saved[k] = process.env[k];
	home = mkdtempSync(join(tmpdir(), "f1-"));
	process.env.KISO_HOME = home;
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "auth.json"), JSON.stringify({
		version: 1,
		credentials: {
			anthropic: { type: "api-key", key: "sk-ant-STORED-VENDOR", savedAt: 1 },
			openai: { type: "api-key", key: "sk-oai-STORED-VENDOR", savedAt: 1 },
		},
	}));
});
afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("F1: the effective endpoint is resolved ONCE, for both sides", () => {
	it("an absent baseUrl resolves to the vendor default, per kind", () => {
		expect(effectiveBaseUrl("anthropic", undefined)).toBe("https://api.anthropic.com");
		expect(effectiveBaseUrl("openai-compat", undefined)).toBe("https://api.openai.com/v1");
		expect(effectiveBaseUrl("openai-responses", undefined)).toBe("https://api.openai.com/v1");
	});

	it("an explicit baseUrl wins and is returned unchanged", () => {
		expect(effectiveBaseUrl("anthropic", "http://127.0.0.1:9/x")).toBe("http://127.0.0.1:9/x");
		expect(effectiveBaseUrl("openai-compat", "https://proxy.example/v1")).toBe("https://proxy.example/v1");
	});

	it("THE ENVIRONMENT NEVER DECIDES IT — the SDK's own env var is ignored here", () => {
		process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
		process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999";
		expect(effectiveBaseUrl("anthropic", undefined)).toBe("https://api.anthropic.com");
		expect(effectiveBaseUrl("openai-compat", undefined)).toBe("https://api.openai.com/v1");
	});
});

describe("F1: providerIdOf consumes the SAME resolver, so an absent url is not a special case", () => {
	it("an absent baseUrl gives the vendor's identity, per kind — the pre-fix behaviour, now derived", () => {
		expect(providerIdOf("anthropic", undefined)).toBe("anthropic");
		expect(providerIdOf("openai-responses", undefined)).toBe("openai");
		expect(providerIdOf("openai-compat", undefined)).toBe("openai");
	});

	it("an explicit foreign origin still resolves to null, so the env var pays (R1)", () => {
		expect(providerIdOf("anthropic", "https://proxy.example")).toBeNull();
		expect(providerIdOf("openai-responses", "https://proxy.example/v1")).toBeNull();
		expect(providerIdOf("openai-compat", "https://proxy.example/v1")).toBeNull();
	});

	it("the vendor's own origin, named explicitly, is the same answer as naming nothing", () => {
		expect(providerIdOf("anthropic", "https://api.anthropic.com")).toBe(providerIdOf("anthropic", undefined));
		expect(providerIdOf("openai-compat", "https://api.openai.com/v1")).toBe(providerIdOf("openai-compat", undefined));
		expect(providerIdOf("openai-responses", "https://chatgpt.com/backend-api/codex")).toBe("chatgpt");
	});

	it("a kind with no vendor default resolves to nothing — no key is implied for an unknown vendor", () => {
		expect(effectiveBaseUrl("faux", undefined)).toBeUndefined();
		expect(providerIdOf("faux", undefined)).toBeNull();
	});
});

describe("F1: the stored key follows the RESOLVED origin", () => {
	for (const [kind, storedKey] of [["anthropic", "sk-ant-STORED-VENDOR"], ["openai-compat", "sk-oai-STORED-VENDOR"]] as const) {
		it(`${kind}: absent baseUrl + a hostile SDK env var still resolves to the vendor, so the stored key is safe`, () => {
			process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
			process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999";
			const url = effectiveBaseUrl(kind, undefined);
			expect(providerIdOf(kind, url)).toBe(kind === "anthropic" ? "anthropic" : "openai");
			const auth = authForProfile("p", { kind, model: "m", apiKeyEnv: "PROXY_KEY" } as never);
			expect(auth).toMatchObject({ apiKey: storedKey, source: "store" });
		});

		it(`${kind}: an explicit custom baseUrl resolves to NO provider, so the profile's env key pays`, () => {
			process.env.PROXY_KEY = "sk-proxy-ENVKEY";
			const url = effectiveBaseUrl(kind, "https://proxy.example/v1");
			expect(providerIdOf(kind, url)).toBeNull();
			const auth = authForProfile("p", { kind, model: "m", baseUrl: "https://proxy.example/v1", apiKeyEnv: "PROXY_KEY" } as never);
			expect(auth.type).toBe("api-key");
			const key = (auth as { readonly apiKey: string }).apiKey;
			expect(key).toBe("sk-proxy-ENVKEY");
			expect(key).not.toBe(storedKey);
		});
	}
});

/**
 * Astra F2 (P1, the same family) — THE ENV-SELECTED PROFILE MUST OBEY THE SAME
 * ORIGIN RULE.
 *
 * `resolveModel`'s env route returned `process.env.OPENAI_API_KEY` directly and
 * never consulted `authForProfile`, so the two routes into the same adapter
 * disagreed about which credential a profile uses. The safety property held by
 * accident — the env key is not the stored one — and an accident is not a rule.
 *
 * The rule: stored key at the vendor origin, the env key at a custom origin,
 * and a stored vendor key is NEVER forwarded to a custom environment URL.
 */
describe("F2: the env-selected route resolves through the origin rule", () => {
	it("stored + env key, no base URL -> the STORED key, because the origin is the vendor's", async () => {
		process.env.OPENAI_API_KEY = "sk-oai-ENV";
		delete process.env.OPENAI_BASE_URL;
		const { resolveModel } = await import("../src/config.js");
		const r = resolveModel(undefined, {} as never);
		expect(r?.apiKey).toBe("sk-oai-STORED-VENDOR");
		delete process.env.OPENAI_API_KEY;
	});

	it("stored + env key + a CUSTOM base URL -> the ENV key, and never the stored one", async () => {
		process.env.OPENAI_API_KEY = "sk-oai-ENV";
		process.env.OPENAI_BASE_URL = "https://proxy.example/v1";
		const { resolveModel } = await import("../src/config.js");
		const r = resolveModel(undefined, {} as never);
		expect(r?.apiKey).toBe("sk-oai-ENV");
		expect(r?.apiKey).not.toBe("sk-oai-STORED-VENDOR");
		delete process.env.OPENAI_API_KEY;
	});
});
