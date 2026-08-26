/**
 * XP-1 — the reasoning capability matrix (the ratified spec §4.2/§4.3).
 *
 * The registry's `reasoning: boolean | null` is superseded IN PLACE by a
 * structured block (zero consumers existed — verified); the matrix names
 * the ACTUAL native modes, effort levels, defaults and wire format per
 * model, every value dated and sourced (a provider's toggle semantics are
 * a dated claim about someone else's API, the same class as a price).
 * Resolution is native-only: an unsupported value is REFUSED, never
 * silently downgraded; unknown models resolve nothing but defaults.
 *
 * The DeepSeek identity fix lands HERE with the matrix (v4-flash and
 * v4-pro; the legacy IDs carry their deprecation, sourced to the actual
 * changelog entry — 2026-04-24: discontinued 2026-07-24).
 *
 * RED on the pre-XP-1 tree: no block, no entries, no resolver.
 */

import { describe, expect, it } from "vitest";
import { lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";

describe("XP-1 — the DeepSeek V4 identity fix, dated and sourced", () => {
	it("deepseek-v4-flash: request-time toggle default-enabled, native effort low/high/max", () => {
		const e = lookupModelMetadata("deepseek-v4-flash", "https://api.deepseek.com");
		expect(e).toBeDefined();
		expect(e!.providerId).toBe("deepseek");
		const r = e!.capabilities.reasoning;
		expect(r?.emitsThinkingStream).toBe(true);
		expect(r?.thinking).toEqual({ modes: ["enabled", "disabled"], default: "enabled" });
		expect(r?.effort?.levels).toEqual(["low", "high", "max"]);
		expect(r?.effort?.default).toBe("high");
		expect(r?.effort?.wire).toBe("reasoning_effort");
		expect(r?.asOf).toBe("2026-08-26");
		expect(r?.source).toContain("thinking_mode");
	});

	it("deepseek-v4-pro exists with the identical matrix", () => {
		const e = lookupModelMetadata("deepseek-v4-pro", "https://api.deepseek.com");
		expect(e?.capabilities.reasoning?.effort?.levels).toEqual(["low", "high", "max"]);
	});

	it("the legacy IDs carry their deprecation, sourced to the changelog", () => {
		for (const m of ["deepseek-chat", "deepseek-reasoner"]) {
			const e = lookupModelMetadata(m, "https://api.deepseek.com");
			expect(e?.deprecated?.asOf, m).toBe("2026-07-24");
			expect(e?.deprecated?.source, m).toContain("api-docs.deepseek.com");
		}
	});

	it("claude-sonnet-5: five effort levels through output_config, dated", () => {
		const r = lookupModelMetadata("claude-sonnet-5")?.capabilities.reasoning;
		expect(r?.effort?.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(r?.effort?.default).toBe("high");
		expect(r?.effort?.wire).toBe("output_config.effort");
		expect(r?.asOf).toBe("2026-08-26");
	});
});

describe("XP-1 — native-only resolution, no silent downgrade", () => {
	it("a native selection resolves to its wire value", () => {
		expect(resolveReasoning("deepseek-v4-flash", { thinking: "default", effort: "max" })).toEqual({
			ok: true,
			wire: { effort: "max" },
		});
		expect(resolveReasoning("deepseek-v4-flash", { thinking: "disabled", effort: "default" })).toEqual({
			ok: true,
			wire: { thinking: "disabled" },
		});
	});

	it("default/default resolves to NO wire fields — the byte-identity anchor", () => {
		expect(resolveReasoning("deepseek-v4-flash", { thinking: "default", effort: "default" })).toEqual({ ok: true, wire: {} });
		expect(resolveReasoning("totally-unknown-model", { thinking: "default", effort: "default" })).toEqual({ ok: true, wire: {} });
	});

	it("an unsupported effort is REFUSED with the native levels named — never downgraded", () => {
		const r = resolveReasoning("deepseek-v4-flash", { thinking: "default", effort: "xhigh" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("low");
	});

	it("a mode the matrix does not list is refused (adaptive on a toggle-only model)", () => {
		expect(resolveReasoning("deepseek-v4-flash", { thinking: "adaptive", effort: "default" }).ok).toBe(false);
	});

	it("an unknown model refuses any non-default selection — unknown stays unknown", () => {
		expect(resolveReasoning("totally-unknown-model", { thinking: "default", effort: "high" }).ok).toBe(false);
		expect(resolveReasoning("totally-unknown-model", { thinking: "enabled", effort: "default" }).ok).toBe(false);
	});

	it("claude-sonnet-5 resolves xhigh natively", () => {
		expect(resolveReasoning("claude-sonnet-5", { thinking: "default", effort: "xhigh" })).toEqual({
			ok: true,
			wire: { effort: "xhigh" },
		});
	});
});
