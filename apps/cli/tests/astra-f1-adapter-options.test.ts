import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapterOptionsFor } from "../src/auth/adapter-options.js";
import type { ModelProfile } from "../src/config.js";

/**
 * Astra F1 (P0) — THE GUARD ON THE MECHANISM ITSELF.
 *
 * `effectiveBaseUrl` resolving correctly is necessary and not sufficient:
 * the P0 is only fixed if the value the CLI hands the adapter is ALWAYS an
 * explicit URL. That step had no test, and the spread that performed it
 * existed twice. Both call sites now build their options here, so this is
 * the one place to assert it.
 *
 * The hostile environment is set on every case on purpose: if any of these
 * ever returns no `baseUrl`, the SDK reads the variable below and the
 * stored vendor key leaves the vendor.
 */
const ENV = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV) saved[k] = process.env[k];
	process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
	process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999";
});
afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const profile = (kind: string, baseUrl?: string): ModelProfile =>
	({ kind, model: "m", ...(baseUrl !== undefined ? { baseUrl } : {}) }) as ModelProfile;
const KEY = { type: "api-key", apiKey: "sk-STORED" } as const;

describe("F1: the adapter is ALWAYS handed an explicit endpoint", () => {
	for (const [kind, expected] of [
		["anthropic", "https://api.anthropic.com"],
		["openai-compat", "https://api.openai.com/v1"],
		["openai-responses", "https://api.openai.com/v1"],
	] as const) {
		it(`${kind}: an absent baseUrl becomes the vendor default, never the environment's`, () => {
			const opts = adapterOptionsFor(profile(kind), KEY);
			expect(opts.baseUrl).toBe(expected);
			expect(opts.baseUrl).not.toContain("127.0.0.1");
		});
	}

	it("an explicit baseUrl passes through unchanged — a proxy profile still reaches its proxy", () => {
		expect(adapterOptionsFor(profile("openai-compat", "https://proxy.example/v1"), KEY).baseUrl).toBe("https://proxy.example/v1");
		expect(adapterOptionsFor(profile("anthropic", "http://127.0.0.1:1234"), KEY).baseUrl).toBe("http://127.0.0.1:1234");
	});

	it("the ChatGPT subscription profile names its own backend and keeps it", () => {
		const opts = adapterOptionsFor(profile("openai-responses", "https://chatgpt.com/backend-api/codex"), { type: "oauth", providerId: "chatgpt" }, "sess-1");
		expect(opts.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
		expect(opts.apiKey).toBeUndefined();
		expect(typeof opts.oauth).toBe("function");
	});

	it("a kind with no vendor default gets NO baseUrl — nothing is invented for an unknown vendor", () => {
		expect(adapterOptionsFor(profile("faux"), KEY).baseUrl).toBeUndefined();
	});
});

describe("F1: the credential shape, and the fields that used to differ between the two sites", () => {
	it("an API key goes as a key and no thunk; OAuth goes as a thunk and no key", () => {
		const k = adapterOptionsFor(profile("anthropic"), KEY);
		expect(k.apiKey).toBe("sk-STORED");
		expect(k.oauth).toBeUndefined();
		const o = adapterOptionsFor(profile("openai-responses"), { type: "oauth", providerId: "chatgpt" });
		expect(o.oauth).toBeDefined();
		expect(o.apiKey).toBeUndefined();
	});

	it("the session is the cache lane for EVERY profile, not only an OAuth one", () => {
		// The drift the extraction found: startup passed this whenever the
		// session had an id; `/model` passed it only for OAuth. Same session,
		// two cache lanes, decided by how you arrived.
		expect(adapterOptionsFor(profile("openai-responses"), KEY, "sess-1").promptCacheKey).toBe("sess-1");
		expect(adapterOptionsFor(profile("openai-responses"), { type: "oauth", providerId: "chatgpt" }, "sess-1").promptCacheKey).toBe("sess-1");
	});

	it("no session id, no cache key — `kiso sessions` streams nothing and costs no cache", () => {
		expect(adapterOptionsFor(profile("openai-responses"), KEY).promptCacheKey).toBeUndefined();
	});

	it("promptCaching rides only when the profile states it (a cost behaviour never flips silently)", () => {
		expect(adapterOptionsFor(profile("anthropic"), KEY).promptCaching).toBeUndefined();
		expect(adapterOptionsFor({ ...profile("anthropic"), promptCaching: true } as ModelProfile, KEY).promptCaching).toBe(true);
	});
});
