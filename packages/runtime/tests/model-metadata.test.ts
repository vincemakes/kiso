/**
 * PH-1c — the model metadata registry and the model-keyed cost path
 * (findings PH-F14/PH-F15/PH-F16).
 *
 * The one discipline under test everywhere: UNKNOWN IS NULL. A model
 * the table cannot name gets no window, no rate, no guess; a priced
 * entry carries its provenance (asOf + source) or it does not exist.
 */

import { describe, expect, it } from "vitest";
import { lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";
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

describe("OR-1 — the Responses rows: one model id, two endpoints, two answers", () => {
	const FIRST = "https://api.openai.com/v1";
	const SUB = "https://chatgpt.com/backend-api/codex/responses";

	it("at the first-party API the row is the model page: five levels including none, a dated price, a 1,050,000 window", () => {
		const m = lookupModelMetadata("gpt-5.5", FIRST);
		expect(m?.providerId).toBe("openai");
		expect(m?.capabilities.reasoning?.effort).toEqual({ levels: ["none", "low", "medium", "high", "xhigh"], default: "medium", wire: "reasoning.effort" });
		expect(m?.capabilities.contextWindow).toBe(1_050_000);
		expect(m?.capabilities.maxOutputTokens).toBe(128_000);
		expect(m?.capabilitiesSource).toBe("https://developers.openai.com/api/docs/models/gpt-5.5");
		expect(m?.pricing).toEqual({ inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5, cacheWritePerM: 0, asOf: "2026-09-08", source: "https://developers.openai.com/api/docs/models/gpt-5.5" });
		// gpt-5.4's page says "none (default)" — the default is the page's, not a house preference
		expect(lookupModelMetadata("gpt-5.4", FIRST)?.capabilities.reasoning?.effort?.default).toBe("none");
	});

	it("at the subscription backend the row is the vendor CLI's pinned presets: four levels, no none, NO price", () => {
		for (const id of ["gpt-5.5", "gpt-5.4"]) {
			const m = lookupModelMetadata(id, SUB);
			expect(m?.providerId, id).toBe("chatgpt");
			expect(m?.capabilities.reasoning?.effort, id).toEqual({ levels: ["low", "medium", "high", "xhigh"], default: "medium", wire: "reasoning.effort" });
			expect(m?.capabilities.contextWindow, id).toBe(272_000);
			expect(m?.pricing, id).toBeNull(); // paid by the subscription — a first-party rate is not this bill
			expect(m?.capabilitiesSource, id).toMatch(/\/blob\/[0-9a-f]{40}\//); // pinned to a commit, not a branch
		}
		expect(lookupModelMetadata("gpt-5.5", "https://other.example.com")).toBeNull();
	});

	it("the endpoint decides the verdict: none is native at the first-party API and refused, by name, at the subscription", () => {
		const none = { thinking: "default", effort: "none" } as const;
		expect(resolveReasoning("gpt-5.5", none, FIRST)).toEqual({ ok: true, wire: { effort: "none" } });
		const refused = resolveReasoning("gpt-5.5", none, SUB);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("native: low/medium/high/xhigh");
		// endpoint-less (the run-side resolver): the first-party row, listed first — a superset,
		// so nothing the CLI accepted for either profile is refused at run time
		expect(resolveReasoning("gpt-5.5", none)).toEqual({ ok: true, wire: { effort: "none" } });
		expect(resolveReasoning("gpt-5.5", { thinking: "default", effort: "xhigh" }, SUB)).toEqual({ ok: true, wire: { effort: "xhigh" } });
	});

	it("cost: the first-party row prices a run; the subscription row prices nothing", () => {
		const RAW = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };
		expect(canonicalizeUsageForModel("gpt-5.5", FIRST, "openai-compat", RAW).costUsd).toBeCloseTo(35, 9);
		expect(canonicalizeUsageForModel("gpt-5.5", SUB, "openai-compat", RAW).costUsd).toBeNull();
	});
});
