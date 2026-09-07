/**
 * PA-1a — the Anthropic first-party line is REGISTERED: dated, sourced,
 * and driven. Read from the live docs on 2026-09-07 (models overview,
 * the thinking table, the effort page, the pricing page). Red first: on
 * 0.27.0 the registry knew only claude-sonnet-5 (undated pricing null),
 * so `claude-opus-5` refused `effort: high`.
 */

import { describe, expect, it } from "vitest";
import { lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";

const LINE = ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5"] as const;

describe("PA-1a — the first-party line is registered, dated and sourced", () => {
	it("every id resolves, with dated capabilities and dated pricing", () => {
		for (const id of LINE) {
			const m = lookupModelMetadata(id);
			expect(m, id).not.toBeNull();
			expect(m!.providerId).toBe("anthropic");
			expect(m!.capabilitiesAsOf).toBe("2026-09-07");
			expect(m!.capabilitiesSource).toMatch(/^https:\/\/platform\.claude\.com\//);
			expect(m!.pricing?.asOf).toBe("2026-09-07");
			expect(m!.pricing?.source).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
			expect(m!.capabilities.promptCaching).toBe("explicit");
			expect(m!.capabilities.inputModalities).toEqual(["text", "image"]);
		}
	});

	it("context windows, max output and prices are the page's numbers", () => {
		const row = (id: string) => lookupModelMetadata(id)!;
		expect(row("claude-fable-5-1").capabilities.contextWindow).toBe(1_000_000);
		expect(row("claude-fable-5-1").capabilities.maxOutputTokens).toBe(128_000);
		expect(row("claude-opus-5").capabilities.contextWindow).toBe(1_000_000);
		expect(row("claude-sonnet-5").capabilities.contextWindow).toBe(1_000_000);
		expect(row("claude-haiku-4-5-20251001").capabilities.contextWindow).toBe(200_000);
		expect(row("claude-haiku-4-5-20251001").capabilities.maxOutputTokens).toBe(64_000);
		expect(row("claude-fable-5-1").pricing).toMatchObject({ inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWritePerM: 12.5 });
		expect(row("claude-opus-5").pricing).toMatchObject({ inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 });
		expect(row("claude-sonnet-5").pricing).toMatchObject({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 });
		expect(row("claude-haiku-4-5-20251001").pricing).toMatchObject({ inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 });
	});

	it("effort resolves per the effort page: five levels on the 5-line, none on Haiku 4.5", () => {
		for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
			for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
				const r = resolveReasoning(id, { thinking: "default", effort });
				expect(r.ok, `${id} ${effort}`).toBe(true);
				if (r.ok) expect(r.wire).toEqual({ effort });
			}
		}
		const h = resolveReasoning("claude-haiku-4-5-20251001", { thinking: "default", effort: "high" });
		expect(h.ok).toBe(false);
	});

	it("thinking resolves per the thinking table: Fable 5.1 is always on, Opus 5 / Sonnet 5 accept disabled, nobody accepts enabled", () => {
		expect(resolveReasoning("claude-fable-5-1", { thinking: "adaptive", effort: "default" })).toMatchObject({ ok: true, wire: { thinking: "adaptive" } });
		expect(resolveReasoning("claude-fable-5-1", { thinking: "disabled", effort: "default" }).ok).toBe(false);
		expect(resolveReasoning("claude-opus-5", { thinking: "disabled", effort: "high" })).toMatchObject({ ok: true, wire: { thinking: "disabled", effort: "high" } });
		expect(resolveReasoning("claude-sonnet-5", { thinking: "disabled", effort: "default" })).toMatchObject({ ok: true, wire: { thinking: "disabled" } });
		for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
			expect(resolveReasoning(id, { thinking: "enabled", effort: "default" }).ok, id).toBe(false);
		}
	});

	it("the documented forbidden pair on Opus 5: disabled at xhigh or max is refused before any request", () => {
		expect(resolveReasoning("claude-opus-5", { thinking: "disabled", effort: "xhigh" }).ok).toBe(false);
		expect(resolveReasoning("claude-opus-5", { thinking: "disabled", effort: "max" }).ok).toBe(false);
		expect(resolveReasoning("claude-opus-5", { thinking: "adaptive", effort: "max" }).ok).toBe(true);
	});

	it("default/default adds nothing on every id (the byte anchor)", () => {
		for (const id of LINE) expect(resolveReasoning(id, { thinking: "default", effort: "default" })).toEqual({ ok: true, wire: {} });
	});
});
