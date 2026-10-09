import { describe, expect, it } from "vitest";
import { lookupModelMetadata } from "@vincemakes/kiso-runtime/internal";
import { contextWindowTokens, microcompactThresholdFor } from "../src/chat.js";

/**
 * REG-1 — the DeepSeek rows carry the window, and the window reaches the
 * two places that spend it.
 *
 * The defect this closes was not a blank status line. `contextWindow: null`
 * sends `contextWindowTokens` to its 200,000 fallback, and the compaction
 * threshold is half of whatever that returns — so the product cleared a
 * 1M-context model's history at 100,000 tokens, a TENTH of its capacity,
 * and the only visible symptom was `ctx ?`.
 *
 * The numbers are the vendor's, read from the pricing table on 2026-09-17:
 * CONTEXT LENGTH 1M, MAX OUTPUT MAXIMUM 384K. A dated vendor statement is
 * this registry's contract — the Anthropic and OpenAI rows stand on the
 * same footing, and holding this one to a stricter standard is what left
 * it null.
 */
describe("REG-1 — the DeepSeek window reaches the threshold", () => {
	const DS = "https://api.deepseek.com";

	it("the registry knows the window and the max output for the current name", () => {
		const row = lookupModelMetadata("deepseek-flash", DS);
		expect(row?.capabilities.contextWindow).toBe(1_000_000);
		expect(row?.capabilities.maxOutputTokens).toBe(384_000);
	});

	it("the retired alias carries the SAME window — a config naming it is not punished", () => {
		// The vendor still routes it to V4.1 Flash, so the capacity is the
		// capacity. The row is marked retired; it is not made to lie.
		const row = lookupModelMetadata("deepseek-v4-flash", DS);
		expect(row?.capabilities.contextWindow).toBe(1_000_000);
		expect(row?.deprecated).not.toBeNull();
	});

	it("the window reaches contextWindowTokens instead of the 200k fallback", () => {
		expect(contextWindowTokens({ model: "deepseek-flash", baseUrl: DS })).toBe(1_000_000);
	});

	it("the compaction threshold moves from 100k to 500k", () => {
		// The whole point: capacity feeds policy. The 2:1 ratio is NOT
		// touched here — only the capacity it is taken from.
		expect(microcompactThresholdFor({ model: "deepseek-flash", baseUrl: DS })).toBe(500_000);
	});

	it("an unknown model still takes the fallback — the registry never guesses", () => {
		expect(contextWindowTokens({ model: "no-such-model-xyz", baseUrl: DS })).toBe(200_000); // declared re-pin (the owner, 2026-10-09): the fallback is 200K again, reversing CW-1 batch 2's 128K
		expect(microcompactThresholdFor({ model: "no-such-model-xyz", baseUrl: DS })).toBe(100_000); // half the 200K fallback (64,000 under CW-1 batch 2's 128K)
	});
});
