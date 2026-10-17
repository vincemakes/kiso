import { describe, expect, it } from "vitest";
import { lookupContextWindow, lookupModelMetadata, modelAliases, modelIdentity } from "../src/provider/metadata.js";

/**
 * CW-1 (owner, 2026-09-23): "a user can reach the same few models through
 * any provider or baseUrl — changing the baseUrl must not turn ctx into ?".
 *
 * The live case: the owner's `op` profile, `deepseek-v4.1-flash` at a local
 * forwarder (127.0.0.1:47821) to a model gateway. No registry row is keyed by
 * that (model, endpoint), so the status row read `ctx ?` and the tiers
 * compacted a 1M model against the CLI's 200K fallback.
 */

const FORWARDER = "http://127.0.0.1:47821/v1";

describe("the route's own row still decides where one exists", () => {
	it("the bench's route — deepseek-flash at api.deepseek.com — resolves exactly as before", () => {
		const w = lookupContextWindow("deepseek-flash", "https://api.deepseek.com");
		expect(w).toEqual({ tokens: 1_000_000, source: "route", from: "deepseek-flash" });
		expect(w?.tokens).toBe(lookupModelMetadata("deepseek-flash", "https://api.deepseek.com")?.capabilities.contextWindow);
	});

	it("one id, two endpoints, two answers — the endpoint still narrows", () => {
		expect(lookupContextWindow("gpt-5.5", "https://api.openai.com/v1")).toEqual({ tokens: 1_050_000, source: "route", from: "gpt-5.5" });
		expect(lookupContextWindow("gpt-5.5", "https://chatgpt.com/backend-api/codex")).toEqual({ tokens: 272_000, source: "route", from: "gpt-5.5" });
	});
});

describe("a route the registry has no row for", () => {
	it("the owner's op profile: the model's own window, marked as the model's", () => {
		expect(lookupModelMetadata("deepseek-v4.1-flash", FORWARDER), "the route has no row — the 0.40.2 miss").toBeNull();
		expect(lookupContextWindow("deepseek-v4.1-flash", FORWARDER)).toEqual({ tokens: 1_000_000, source: "model", from: "deepseek-flash" });
	});

	it("a vendor prefix and the vendor's capitals name the same weights", () => {
		expect(modelIdentity("deepseek/DeepSeek-V4.1-Flash")).toBe("deepseek-flash");
		// the vendor-prefixed id on a gateway with no row of its own (since
		// 2026-10-17 OpenRouter HAS one: its route answers with its own 1,048,576)
		expect(lookupContextWindow("deepseek/deepseek-v4.1-flash", FORWARDER)?.tokens).toBe(1_000_000);
		expect(lookupContextWindow("deepseek/deepseek-v4.1-flash", "https://openrouter.ai/api/v1")).toMatchObject({ tokens: 1_048_576, source: "route" });
		expect(lookupContextWindow("deepseek-flash", FORWARDER)).toEqual({ tokens: 1_000_000, source: "model", from: "deepseek-flash" });
	});

	it("where the rows disagree, the smallest — the one figure no row contradicts", () => {
		expect(lookupContextWindow("gpt-5.5", FORWARDER)).toEqual({ tokens: 272_000, source: "model", from: "gpt-5.5" });
	});

	it("a forwarder that names its upstream gets the upstream's row, ahead of the model's", () => {
		expect(lookupContextWindow("gpt-5.5", FORWARDER, "https://api.openai.com/v1")).toEqual({ tokens: 1_050_000, source: "upstream", from: "gpt-5.5" });
		// an upstream with no row of its own falls through to the model
		expect(lookupContextWindow("deepseek-v4.1-flash", FORWARDER, "https://gateway.example/v1")?.source).toBe("model");
		// an upstream that is a name, not a URL, matches no row — never throws
		expect(lookupContextWindow("deepseek-v4.1-flash", FORWARDER, "my gateway")?.source).toBe("model");
	});
});

describe("unknown stays unknown", () => {
	it("a model no row names is null, at any endpoint", () => {
		expect(lookupContextWindow("unregistered-model-nobody-publishes-a-window-for", FORWARDER)).toBeNull();
		expect(lookupContextWindow("unregistered-model-nobody-publishes-a-window-for")).toBeNull();
	});

	it("rows that state no window lend none — deepseek-chat stays null", () => {
		expect(lookupContextWindow("deepseek-chat", FORWARDER)).toBeNull();
	});

	it("a variant suffix is not folded: `:free` may serve a smaller window", () => {
		expect(modelIdentity("deepseek-flash:free")).toBe("deepseek-flash:free");
		expect(lookupContextWindow("deepseek-flash:free", FORWARDER)).toBeNull();
	});

	it("only the WINDOW resolves by identity — price and reasoning stay the route's", () => {
		// what the model step lends is one number; the rows it read keep
		// their endpoint for everything else
		expect(lookupModelMetadata("deepseek-v4.1-flash", FORWARDER)?.pricing ?? null).toBeNull();
		expect(lookupModelMetadata("deepseek-flash", FORWARDER)).toBeNull();
	});
});

describe("every alias is a dated vendor statement about a registered model", () => {
	it("dated, sourced, and naming a row that states a window", () => {
		const aliases = Object.entries(modelAliases());
		expect(aliases.length).toBeGreaterThan(0);
		for (const [name, a] of aliases) {
			expect(a.asOf, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(a.source, name).toMatch(/^https:\/\//);
			expect(name, "keys are folded names").toBe(name.toLowerCase());
			expect(name, "keys carry no vendor prefix").not.toContain("/");
			expect(lookupContextWindow(a.is)?.tokens, `${name} → ${a.is}`).toBeGreaterThan(0);
		}
	});
});
