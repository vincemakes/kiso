/**
 * PH-1c — the model metadata registry and the model-keyed cost path
 * (findings PH-F14/PH-F15/PH-F16).
 *
 * The one discipline under test everywhere: UNKNOWN IS NULL. A model
 * the table cannot name gets no window, no rate, no guess; a priced
 * entry carries its provenance (asOf + source) or it does not exist.
 */

import { describe, expect, it } from "vitest";
import { lookupModelMetadata } from "../src/provider/metadata.js";
import { canonicalizeUsageForModel } from "../src/usage/canonical.js";

describe("PH-1c — lookupModelMetadata", () => {
	it("a known model resolves; every priced entry carries asOf + source", () => {
		const ds = lookupModelMetadata("deepseek-chat", "https://api.deepseek.com");
		expect(ds).not.toBeNull();
		expect(ds!.capabilities.promptCaching).toBe("automatic");
		expect(ds!.pricing).not.toBeNull();
		expect(ds!.pricing!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(ds!.pricing!.source).toMatch(/^https:\/\//);
	});

	it("the endpoint qualifier narrows: a deepseek id aimed at a DIFFERENT endpoint does not match", () => {
		expect(lookupModelMetadata("deepseek-chat", "https://other.example.com")).toBeNull();
		// no endpoint given → the entry still matches (the caller may not
		// know its endpoint; the model id alone is evidence enough for v1)
		expect(lookupModelMetadata("deepseek-chat")).not.toBeNull();
	});

	it("an unknown model is null — never a default entry", () => {
		expect(lookupModelMetadata("some-model-nobody-registered")).toBeNull();
	});

	it("capability honesty: a model we can name but not price is pricing: null", () => {
		// PA-1a (2026-09-07) priced the Anthropic line from the live page, so
		// the example moved to a row that is still unpriced on purpose.
		const gpt = lookupModelMetadata("gpt-4o");
		expect(gpt).not.toBeNull();
		expect(gpt!.pricing).toBeNull(); // no live-sourced rate — no number
		const sonnet = lookupModelMetadata("claude-sonnet-5");
		expect(sonnet!.pricing?.asOf).toBe("2026-09-07"); // and a priced row says WHEN
	});
});

describe("PH-1c — canonicalizeUsageForModel (the model-keyed cost path)", () => {
	const RAW = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };

	it("a metadata-priced model costs at ITS rates, stamped with the metadata table id", () => {
		const c = canonicalizeUsageForModel("deepseek-chat", "https://api.deepseek.com", "openai-compat", RAW);
		expect(c.costUsd).toBeCloseTo(0.27 + 1.1, 9);
		expect(c.pricingTableId).toBe("metadata");
		// the convention still keys on the ROUTE (protocol property):
		// openai-compat input is total, so fresh = input − cacheRead
		expect(c.input).toBe(1_000_000);
	});

	it("an anthropic run is priced at ITS OWN dated rates (PA-1a) — never at DeepSeek's; an unregistered anthropic id costs null", () => {
		const c = canonicalizeUsageForModel("claude-sonnet-5", undefined, "anthropic", RAW);
		expect(c.costUsd).toBeCloseTo(2 + 10, 9); // the pricing page, read 2026-09-07
		expect(c.costUsd).not.toBeCloseTo(0.27 + 1.1, 9);
		expect(c.pricingTableId).toBe("metadata");
		expect(c.input).toBe(1_000_000); // anthropic convention: fresh as-is
		const u = canonicalizeUsageForModel("claude-unregistered", undefined, "anthropic", RAW);
		expect(u.costUsd).toBeNull();
	});

	it("an unknown model on an unknown route: null cost, total convention — honest on both axes", () => {
		const c = canonicalizeUsageForModel("mystery-model", undefined, "adapter", RAW);
		expect(c.costUsd).toBeNull();
	});
});
