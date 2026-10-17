/**
 * 0.51.0 — the rows added on 2026-10-17, read from the vendors' pages that
 * day: the Anthropic 5.5 line and the first-party GPT-6 sol / luna rows. A
 * row is a dated claim; every value below is one the page states.
 */

import { describe, expect, it } from "vitest";
import { lookupContextWindow, lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";

const ANTHROPIC = "https://api.anthropic.com";
const OPENAI = "https://api.openai.com";
const LEVELS5 = ["low", "medium", "high", "xhigh", "max"];

describe("Anthropic 5.5 line", () => {
	it("Opus 5.5: adaptive only (always on), default effort medium, $4 / $20, cache read $0.20", () => {
		const row = lookupModelMetadata("claude-opus-5-5", ANTHROPIC);
		expect(row?.capabilities.contextWindow).toBe(1_000_000);
		expect(row?.capabilities.maxOutputTokens).toBe(128_000);
		expect(row?.capabilities.reasoning?.thinking).toEqual({ modes: ["adaptive"], default: "adaptive" });
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: LEVELS5, default: "medium", wire: "output_config.effort" });
		expect(row?.pricing).toMatchObject({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, asOf: "2026-10-17" });
		expect(row?.capabilitiesAsOf).toBe("2026-10-17");
		// "disabled" is a 400 at every level on this model, so it is never offered
		expect(resolveReasoning("claude-opus-5-5", { thinking: "disabled", effort: "default" }, ANTHROPIC).ok).toBe(false);
		expect(resolveReasoning("claude-opus-5-5", { thinking: "adaptive", effort: "xhigh" }, ANTHROPIC)).toEqual({ ok: true, wire: { thinking: "adaptive", effort: "xhigh" } });
	});

	it("Sonnet 5.5: adaptive only in this vocabulary (`disabled` is a 400; `between_tools` has no place here), default high, $2 / $10, cache read $0.10", () => {
		const row = lookupModelMetadata("claude-sonnet-5-5", ANTHROPIC);
		expect(row?.capabilities.reasoning?.thinking).toEqual({ modes: ["adaptive"], default: "adaptive" });
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: LEVELS5, default: "high", wire: "output_config.effort" });
		expect(row?.pricing).toMatchObject({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 2.5 });
		expect(resolveReasoning("claude-sonnet-5-5", { thinking: "disabled", effort: "default" }, ANTHROPIC).ok).toBe(false);
	});

	it("Haiku 5.5: `disabled` only at effort high or below, default medium, the up-to-100K rates", () => {
		const row = lookupModelMetadata("claude-haiku-5-5", ANTHROPIC);
		expect(row?.capabilities.reasoning?.thinking).toEqual({ modes: ["adaptive", "disabled"], default: "adaptive" });
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: LEVELS5, default: "medium", wire: "output_config.effort" });
		expect(row?.pricing).toMatchObject({ inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 });
		expect(resolveReasoning("claude-haiku-5-5", { thinking: "disabled", effort: "high" }, ANTHROPIC)).toEqual({ ok: true, wire: { thinking: "disabled", effort: "high" } });
		for (const effort of ["xhigh", "max"] as const) {
			expect(resolveReasoning("claude-haiku-5-5", { thinking: "disabled", effort }, ANTHROPIC).ok).toBe(false);
		}
	});

	it("the older rows did not move", () => {
		expect(lookupModelMetadata("claude-opus-5", ANTHROPIC)?.capabilities.reasoning?.effort?.default).toBe("high");
		expect(lookupModelMetadata("claude-opus-5", ANTHROPIC)?.capabilitiesAsOf).toBe("2026-09-07");
		expect(lookupModelMetadata("claude-haiku-4-5", ANTHROPIC)?.capabilities.reasoning?.effort).toBeNull();
	});
});

describe("OpenAI first-party GPT-6 rows", () => {
	it("gpt-6-sol: none through max, default medium, 1,050,000 window, $2 / $10, cache read $0.20", () => {
		const row = lookupModelMetadata("gpt-6-sol", OPENAI);
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium", wire: "reasoning.effort" });
		expect(row?.capabilities.contextWindow).toBe(1_050_000);
		expect(row?.capabilities.maxOutputTokens).toBe(128_000);
		expect(row?.pricing).toMatchObject({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, asOf: "2026-10-17" });
	});

	it("gpt-6-luna: none through max, default medium, $0.10 / $0.50, cache read $0.01", () => {
		const row = lookupModelMetadata("gpt-6-luna", OPENAI);
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium", wire: "reasoning.effort" });
		expect(row?.pricing).toMatchObject({ inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 });
	});

	it("a gateway still gets the window by model identity, and no effort by guess", () => {
		expect(lookupContextWindow("gpt-6-luna", "https://some-gateway.example/v1")).toMatchObject({ tokens: 1_050_000, source: "model" });
		expect(resolveReasoning("gpt-6-luna", { thinking: "default", effort: "high" }, "https://some-gateway.example/v1").ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Command Code (a probed route), the OpenRouter rows, the dotted aliases, and
// the whole table's shape.
// ---------------------------------------------------------------------------

import { modelAliases, modelIdentity, modelMetadataRows } from "../src/provider/metadata.js";

const CC = "https://api.commandcode.ai/provider/v1";
const OR = "https://openrouter.ai/api/v1";

describe("Command Code route rows (probe 2026-10-17)", () => {
	it("deepseek: the gateway's enum intersected with the model's native levels; `none` goes on the wire as `off`", () => {
		const row = lookupModelMetadata("deepseek/deepseek-v4.1-flash", CC);
		expect(row?.capabilities.reasoning?.effort).toEqual({ levels: ["none", "low", "high", "max"], default: "high", wire: "reasoning_effort", values: { none: "off" } });
		expect(resolveReasoning("deepseek/deepseek-v4.1-flash", { thinking: "default", effort: "none" }, CC)).toEqual({ ok: true, wire: { effort: "off" } });
		expect(resolveReasoning("deepseek/deepseek-v4.1-flash", { thinking: "default", effort: "max" }, CC)).toEqual({ ok: true, wire: { effort: "max" } });
		// the gateway accepts `medium`, but at DeepSeek it is the vendor's alias, not a native level
		expect(resolveReasoning("deepseek/deepseek-v4.1-flash", { thinking: "default", effort: "medium" }, CC).ok).toBe(false);
	});

	it("glm and grok: only their own levels, no default claimed", () => {
		expect(lookupModelMetadata("z-ai/glm-5.3-flash", CC)?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "high", "max"], default: null, wire: "reasoning_effort" });
		expect(lookupModelMetadata("xai/grok-4.7", CC)?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh"], default: null, wire: "reasoning_effort" });
		expect(resolveReasoning("xai/grok-4.7", { thinking: "default", effort: "none" }, CC).ok).toBe(false);
	});

	it("mimo has no row (no stated efforts anywhere): unknown stays unknown, and the default resolves to nothing on the wire", () => {
		expect(lookupModelMetadata("xiaomi/mimo-v2.6-flash", CC)).toBeNull();
		expect(resolveReasoning("xiaomi/mimo-v2.6-flash", { thinking: "default", effort: "default" }, CC)).toEqual({ ok: true, wire: {} });
	});

	it("the rows claim no window, output cap or price (the window falls to the model's identity)", () => {
		const row = lookupModelMetadata("deepseek/deepseek-v4.1-flash", CC);
		expect(row?.capabilities.contextWindow).toBeNull();
		expect(row?.pricing).toBeNull();
		expect(lookupContextWindow("deepseek/deepseek-v4.1-flash", CC)).toMatchObject({ tokens: 1_000_000, source: "model" });
		expect(lookupContextWindow("xai/grok-4.7", CC)).toMatchObject({ tokens: 500_000, source: "model" });
	});

	it("an origin that is not the gateway's answers nothing", () => {
		expect(lookupModelMetadata("deepseek/deepseek-v4.1-flash", "https://api.example.com/v1")).toBeNull();
	});
});

describe("OpenRouter rows (generated 2026-10-17)", () => {
	it("the router's own levels, never a default, dated", () => {
		const opus = lookupModelMetadata("anthropic/claude-opus-5.5", OR);
		expect(opus?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], default: null, wire: "reasoning_effort" });
		expect(opus?.capabilities.contextWindow).toBe(1_000_000);
		expect(opus?.pricing).toMatchObject({ inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, asOf: "2026-10-17" });
		expect(lookupModelMetadata("xiaomi/mimo-v2.6-flash", OR)?.capabilities.reasoning).toBeNull();
	});

	it("a router-derived 0.9 x window output cap is not copied (Kimi K3, Grok 4.7)", () => {
		expect(lookupModelMetadata("moonshotai/kimi-k3", OR)?.capabilities.maxOutputTokens).toBeNull();
		expect(lookupModelMetadata("x-ai/grok-4.7", OR)?.capabilities.maxOutputTokens).toBeNull();
		expect(lookupModelMetadata("openai/gpt-6.1-sol", OR)?.capabilities.maxOutputTokens).toBe(128_000);
	});

	it("the dotted Claude ids OpenRouter uses fold onto the vendor's dashed ids (the window by identity)", () => {
		expect(modelIdentity("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
		expect(lookupContextWindow("claude-haiku-5.5", "https://gateway.example/v1")).toMatchObject({ tokens: 1_000_000, source: "model" });
		for (const a of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"]) {
			expect(modelAliases()[a]?.asOf, a).toBe("2026-10-17");
			expect(lookupModelMetadata(modelAliases()[a]!.is, ANTHROPIC), a).not.toBeNull();
		}
	});
});

describe("the whole table keeps its contract", () => {
	const rows = modelMetadataRows();

	it("(model, endpoint) is unique", () => {
		const keys = rows.map((r) => `${r.model}@${r.endpoint ?? ""}`);
		expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
	});

	// The pre-MG-1 table's undated rows. The list never grows: a new row is dated.
	const UNDATED_LEGACY = ["gpt-4o"];

	it("every claim carries its date and source: capabilities, reasoning and price", () => {
		for (const r of rows) {
			if (UNDATED_LEGACY.includes(r.model)) continue;
			const c = r.capabilities;
			const claims = c.contextWindow !== null || c.maxOutputTokens !== null || c.promptCaching !== null || c.inputModalities !== null;
			if (claims && r.deprecated === undefined && c.reasoning !== null) expect(r.capabilitiesAsOf, `${r.model} capabilitiesAsOf`).toBeTruthy();
			if (c.reasoning !== null && (c.reasoning.effort !== null || c.reasoning.thinking !== null)) {
				expect(c.reasoning.asOf, `${r.model} reasoning.asOf`).toBeTruthy();
				expect(c.reasoning.source, `${r.model} reasoning.source`).toBeTruthy();
			}
			if (r.pricing !== null) {
				expect(r.pricing.asOf, `${r.model} price asOf`).toBeTruthy();
				expect(r.pricing.source, `${r.model} price source`).toBeTruthy();
				for (const v of [r.pricing.inputPerM, r.pricing.outputPerM]) expect(v, `${r.model} price`).toBeGreaterThan(0);
			}
		}
	});

	it("every effort control is coherent: levels unique, the default among them, `values` and `forbidden` inside the levels", () => {
		for (const r of rows) {
			const e = r.capabilities.reasoning?.effort;
			if (e === null || e === undefined) continue;
			expect(e.levels.length, r.model).toBeGreaterThan(0);
			expect(new Set(e.levels).size, `${r.model} duplicate levels`).toBe(e.levels.length);
			if (e.default !== null) expect(e.levels, `${r.model} default`).toContain(e.default);
			for (const k of Object.keys(e.values ?? {})) expect(e.levels, `${r.model} values.${k}`).toContain(k);
			for (const f of r.capabilities.reasoning?.forbidden ?? []) if (f.effort !== "default") expect(e.levels, `${r.model} forbidden`).toContain(f.effort);
		}
	});
});
