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
		// endpoint-less (a caller with no baseUrl): the first-party row, listed first — the superset
		// fallback; the run-side resolver itself passes the binding's endpoint (or1-binding-snapshot)
		expect(resolveReasoning("gpt-5.5", none)).toEqual({ ok: true, wire: { effort: "none" } });
		expect(resolveReasoning("gpt-5.5", { thinking: "default", effort: "xhigh" }, SUB)).toEqual({ ok: true, wire: { effort: "xhigh" } });
	});

	// OR-6 (2026-09-09): the owner asked why the picker had no newer GPT — the
	// model page lists gpt-6-astra and the gpt-5.6 line above gpt-5.5, and
	// both gpt-6-astra and gpt-5.6-sol answered on the subscription backend
	// (probed the same day). Rows from the pages and the presets pinned to a
	// commit; `ultra` is the presets' top rung and exists ONLY at the
	// subscription — the first-party pages stop at `max`.
	it("OR-6: gpt-6-astra — the page's five levels (default not stated → null) and price at the first-party API; the presets' six (ultra, default low) at the subscription", () => {
		const first = lookupModelMetadata("gpt-6-astra", FIRST);
		expect(first?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], default: null, wire: "reasoning.effort" });
		expect(first?.capabilities.contextWindow).toBe(1_050_000);
		expect(first?.pricing).toEqual({ inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 0, asOf: "2026-09-09", source: "https://developers.openai.com/api/docs/models/gpt-6-astra" });
		const sub = lookupModelMetadata("gpt-6-astra", SUB);
		expect(sub?.providerId).toBe("chatgpt");
		expect(sub?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "low", wire: "reasoning.effort" });
		expect(sub?.capabilities.contextWindow).toBe(272_000);
		expect(sub?.pricing).toBeNull();
		expect(sub?.capabilitiesSource).toMatch(/\/blob\/634ebc1865c6ac840ed3ba118f040d527bf4b55d\//);
	});

	it("OR-6: gpt-5.6-sol — none…max (default medium) and $4/$0.4/$20 at the first-party API; low…ultra (default low) at the subscription", () => {
		const first = lookupModelMetadata("gpt-5.6-sol", FIRST);
		expect(first?.capabilities.reasoning?.effort).toEqual({ levels: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium", wire: "reasoning.effort" });
		expect(first?.pricing).toEqual({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWritePerM: 0, asOf: "2026-09-09", source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol" });
		expect(lookupModelMetadata("gpt-5.6-sol", SUB)?.capabilities.reasoning?.effort?.levels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
	});

	it("OR-6: ultra is native at the subscription and refused, by name, at the first-party API; none is refused for gpt-6-astra everywhere", () => {
		const ultra = { thinking: "default", effort: "ultra" } as const;
		expect(resolveReasoning("gpt-6-astra", ultra, SUB)).toEqual({ ok: true, wire: { effort: "ultra" } });
		const refused = resolveReasoning("gpt-6-astra", ultra, FIRST);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("native: low/medium/high/xhigh/max");
		expect(resolveReasoning("gpt-6-astra", { thinking: "default", effort: "none" }, FIRST).ok).toBe(false);
		expect(resolveReasoning("gpt-6-astra", { thinking: "default", effort: "none" }, SUB).ok).toBe(false);
	});

	it("cost: the first-party row prices a run; the subscription row prices nothing", () => {
		const RAW = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: null };
		expect(canonicalizeUsageForModel("gpt-5.5", FIRST, "openai-compat", RAW).costUsd).toBeCloseTo(35, 9);
		expect(canonicalizeUsageForModel("gpt-5.5", SUB, "openai-compat", RAW).costUsd).toBeNull();
	});
});

describe("OR-10 (owner, 2026-09-09) — a cache figure that cannot be observed is declared, never zeroed", () => {
	it("every ChatGPT-backend row says unobservable; the first-party rows keep automatic", () => {
		for (const m of ["gpt-5.5", "gpt-5.4", "gpt-6-astra", "gpt-5.6-sol"]) {
			expect(lookupModelMetadata(m, "https://chatgpt.com/backend-api")?.capabilities.promptCaching, m).toBe("unobservable");
			expect(lookupModelMetadata(m, "https://api.openai.com/v1")?.capabilities.promptCaching, m).toBe("automatic");
		}
	});
});

describe("GLM 5.3 Flash through OpenRouter — the compat table's second row (2026-09-09)", () => {
	it("resolves at the OpenRouter origin with its levels, its window and its dated price; nowhere else", () => {
		const row = lookupModelMetadata("z-ai/glm-5.3-flash", "https://openrouter.ai/api/v1");
		expect(row).not.toBeNull();
		expect(row!.capabilities.reasoning?.effort?.levels).toEqual(["low", "medium", "high"]);
		expect(row!.capabilities.reasoning?.effort?.wire).toBe("reasoning_effort");
		expect(row!.capabilities.reasoning?.emitsThinkingStream).toBe(true);
		expect(row!.capabilities.contextWindow).toBe(1_048_576);
		expect(row!.pricing?.inputPerM).toBe(0.075);
		expect(row!.pricing?.asOf).toBe("2026-09-09");
		// the id is OpenRouter's; at another origin it is nobody's row
		expect(lookupModelMetadata("z-ai/glm-5.3-flash", "https://api.z.ai")).toBeNull();
	});
});
