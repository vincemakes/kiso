import { describe, expect, it } from "vitest";
import { lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";

const DS = "https://api.deepseek.com";

/**
 * Astra F5 — THE VENDOR'S CURRENT RECOMMENDED ID HAD NO ROW.
 *
 * Copying `deepseek-flash` out of the vendor's own documentation silently
 * cost the effort controls: an unregistered model resolves default/default
 * to an empty wire setting but REFUSES an explicit level by name. That
 * refusal is correct — unknown stays unknown — but it was being reached for
 * the wrong reason. The model is known; the registry had not been told its
 * current name.
 *
 * The legacy alias is retained, not replaced: the vendor still accepts it.
 */
describe("F5: deepseek-flash is registered, dated and sourced", () => {
	it("the canonical id resolves at the vendor's endpoint", () => {
		const row = lookupModelMetadata("deepseek-flash", DS);
		expect(row).not.toBeNull();
		expect(row?.providerId).toBe("deepseek");
		expect(row?.endpoint).toBe(DS);
	});

	it("an explicit native level is ACCEPTED, which is the whole point", () => {
		for (const effort of ["low", "high", "max"] as const) {
			const r = resolveReasoning("deepseek-flash", { thinking: "default", effort }, DS);
			expect(r.ok, `${effort}: ${r.ok ? "" : r.reason}`).toBe(true);
		}
	});

	it("a level OUTSIDE the native list is still refused by name — the row does not widen what is legal", () => {
		const r = resolveReasoning("deepseek-flash", { thinking: "default", effort: "xhigh" }, DS);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("low");
	});

	it("the legacy id still resolves — an alias the vendor accepts is not removed", () => {
		expect(lookupModelMetadata("deepseek-v4-flash", DS)).not.toBeNull();
		expect(resolveReasoning("deepseek-v4-flash", { thinking: "default", effort: "high" }, DS).ok).toBe(true);
	});

	it("the two rows agree on capabilities — the canonical name is not a different model", () => {
		const a = lookupModelMetadata("deepseek-flash", DS)?.capabilities;
		const b = lookupModelMetadata("deepseek-v4-flash", DS)?.capabilities;
		expect(a?.reasoning?.effort).toEqual(b?.reasoning?.effort);
		expect(a?.reasoning?.thinking).toEqual(b?.reasoning?.thinking);
		expect(a?.promptCaching).toBe(b?.promptCaching);
	});

	it("NO number is invented: the window and the price stay null, and the row carries its date and source", () => {
		const row = lookupModelMetadata("deepseek-flash", DS);
		// The vendor's page states a window. A figure read off a page is not a
		// measurement, and this row decides when context relief fires.
		expect(row?.capabilities.contextWindow).toBeNull();
		expect(row?.pricing).toBeNull();
		expect(row?.capabilitiesAsOf).toBe("2026-09-12");
		expect(row?.capabilitiesSource).toContain("api-docs.deepseek.com");
	});

	it("an id nobody registered still behaves as before — default/default passes, a named level refuses", () => {
		expect(lookupModelMetadata("deepseek-not-a-real-name", DS)).toBeNull();
		expect(resolveReasoning("deepseek-not-a-real-name", { thinking: "default", effort: "default" }, DS).ok).toBe(true);
		expect(resolveReasoning("deepseek-not-a-real-name", { thinking: "default", effort: "high" }, DS).ok).toBe(false);
	});
});
