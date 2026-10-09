import { describe, expect, it } from "vitest";
import { contextWindowTokens, microcompactThresholdFor } from "../src/chat.js";

/**
 * CTX-1 — THE COMPACTION THRESHOLD MUST FOLLOW THE LIVE MODEL.
 *
 * `contextWindowTokens()` said, in its own comment, that `/model` to a known
 * model "moves the window (AND THE MICROCOMPACT THRESHOLD DERIVED FROM IT)".
 * The window moved. The threshold did not: it was computed once at agent
 * creation and the `/model` path never touched it.
 *
 * Both directions are wrong, and the second is the dangerous one:
 *
 *   200k -> 1M   the status row says 1,000,000 while tool results are still
 *                cleared at 100,000 — ten times earlier than the model needs.
 *   1M -> 200k   the status row says 200,000 while clearing waits for
 *                500,000, which the window cannot hold.
 *
 * Found by Astra, 2026-09-13, while separating CAPACITY (what a model can
 * hold) from POLICY (when we choose to compact) — a distinction the single
 * `null -> 200k` fallback had been serving both sides of.
 *
 * These are value assertions against the real registry, not a scan for the
 * word "microcompact" in a source file: a gate that reads TEXT passes the
 * moment someone writes the right word in a comment.
 */
describe("CTX-1: the window is asked for a NAMED model, not for whatever is live", () => {
	it("a registry model carries its own window, and the threshold is half of it", () => {
		expect(contextWindowTokens({ model: "claude-sonnet-5" })).toBe(1_000_000);
		expect(microcompactThresholdFor({ model: "claude-sonnet-5" })).toBe(500_000);
	});

	it("a model the registry does not know keeps the fallback — the registry never guesses", () => {
		// declared re-pin (the owner, 2026-10-09): the fallback is 200K again, reversing CW-1 batch 2's 128K
		expect(contextWindowTokens({ model: "no-such-model-ever" })).toBe(200_000);
		expect(microcompactThresholdFor({ model: "no-such-model-ever" })).toBe(100_000); // half the 200K fallback (64,000 under CW-1 batch 2's 128K)
	});

	it("a row with a null window is UNKNOWN, not zero — deepseek falls back, it does not compact at 0", () => {
		// The row exists and declares contextWindow: null. That is the case
		// that produced the 100,000 threshold the diagnostic is about.
		expect(contextWindowTokens({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com" })).toBe(200_000); // declared re-pin (the owner, 2026-10-09): the fallback is 200K again, reversing CW-1 batch 2's 128K
		expect(microcompactThresholdFor({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com" })).toBe(100_000); // half the 200K fallback (64,000 under CW-1 batch 2's 128K)
	});

	it("the ENDPOINT narrows the row — the same id is two different windows", () => {
		expect(contextWindowTokens({ model: "gpt-5.5", baseUrl: "https://api.openai.com" })).toBe(1_050_000);
		expect(contextWindowTokens({ model: "gpt-5.5", baseUrl: "https://chatgpt.com" })).toBe(272_000);
		expect(microcompactThresholdFor({ model: "gpt-5.5", baseUrl: "https://api.openai.com" })).toBe(525_000);
		expect(microcompactThresholdFor({ model: "gpt-5.5", baseUrl: "https://chatgpt.com" })).toBe(136_000);
	});

	it("an endpoint-less pair is endpoint-less — it never inherits an endpoint from anywhere", () => {
		// The argument is a PAIR for this reason. If `baseUrl` were a second
		// optional parameter, a first-party profile switching away from a
		// subscription profile would silently keep the OLD endpoint and read
		// the wrong row — the same defect one field over.
		const endpointless = contextWindowTokens({ model: "gpt-5.5" });
		expect(endpointless).not.toBe(272_000);
	});
});
