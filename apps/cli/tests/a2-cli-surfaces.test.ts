import { afterEach, describe, expect, it } from "vitest";
import { compactionDiscardedNotice, statusModelLabel, unknownWindowNotice } from "../src/chat.js";
import { setAgentModel } from "../src/state.js";

/**
 * ADR-0055 Amendment 2 — the CLI's three surfaces for the 0.40.2 round:
 * the discarded-checkpoint notice (sizes only), the unknown-window notice
 * (the fallback assumption said out loud), and the status row naming the
 * model without its vendor prefix.
 */
afterEach(() => setAgentModel("faux"));

describe("the discarded-checkpoint notice", () => {
	it("says what happened in sizes only — it has no parameter that could carry the checkpoint's text", () => {
		const line = compactionDiscardedNotice({ pre: 180_400, post: 196_000, summary: 60_000 });
		expect(line).toBe("✦ compaction discarded — the checkpoint did not shrink the context (~180.4k → ~196k; it wrote ~60k)");
		expect(compactionDiscardedNotice.length).toBe(1);
	});
});

describe("the unknown-window notice", () => {
	it("names the model and the assumed window, and how to state the real one", () => {
		expect(unknownWindowNotice("deepseek-v4.1-flash")).toBe(
			// declared re-pin (the owner, 2026-10-09): the fallback is 200K again, reversing CW-1 batch 2's 128K
			"[kiso] context window unknown for deepseek-v4.1-flash at this endpoint — compaction assumes 200K; set contextWindow on the profile to state it",
		);
	});
});

describe("the status row names the model, not its vendor", () => {
	it("drops everything up to the last slash", () => {
		setAgentModel("deepseek/deepseek-v4.1-flash");
		expect(statusModelLabel({})).toBe("deepseek-v4.1-flash");
		setAgentModel("z-ai/glm-5.3-flash");
		expect(statusModelLabel({ reasoning: { effort: "high" } })).toBe("glm-5.3-flash · high");
	});

	it("a bare id is shown as it is, and a trailing slash never empties the row", () => {
		setAgentModel("deepseek-flash");
		expect(statusModelLabel({ reasoning: { effort: "default" } })).toBe("deepseek-flash");
		setAgentModel("odd/");
		expect(statusModelLabel({})).toBe("odd/");
	});
});
