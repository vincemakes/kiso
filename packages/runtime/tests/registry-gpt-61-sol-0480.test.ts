/**
 * 0.48.0 — `gpt-6.1-sol` has a row at the subscription (finding 0473-F2).
 *
 * The owner's `sol` profile moved to `gpt-6.1-sol` on 2026-10-08. Without a
 * row, the model had no effort ladder, so its requests carried no
 * `reasoning` field: the remembered `high` never reached the wire and no
 * reasoning summary came back. The row comes from the vendor CLI's
 * presets, pinned to a commit (low…ultra, default low, a 272,000 window),
 * at the subscription only (the first-party row followed on 2026-10-17).
 */

import { describe, expect, it } from "vitest";
import { lookupModelMetadata, resolveReasoning } from "../src/provider/metadata.js";

const FIRST = "https://api.openai.com/v1";
const SUB = "https://chatgpt.com/backend-api/codex/responses";

describe("0.48.0 — gpt-6.1-sol at the subscription", () => {
	it("the presets' six levels (ultra, default low), the subscription window, no price, the pinned source", () => {
		const sub = lookupModelMetadata("gpt-6.1-sol", SUB);
		expect(sub?.providerId).toBe("chatgpt");
		expect(sub?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "low", wire: "reasoning.effort" });
		expect(sub?.capabilities.contextWindow).toBe(272_000);
		expect(sub?.capabilities.promptCaching).toBe("unobservable");
		expect(sub?.pricing).toBeNull();
		expect(sub?.capabilitiesSource).toMatch(/\/blob\/d63a9b8344cfe58bc78bbe319b560378fc8756ef\//);
		expect(sub?.capabilitiesAsOf).toBe("2026-10-09");
	});

	it("the owner's remembered effort now reaches the wire: high resolves natively at the subscription", () => {
		expect(resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "high" }, SUB)).toEqual({ ok: true, wire: { effort: "high" } });
		expect(resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "ultra" }, SUB)).toEqual({ ok: true, wire: { effort: "ultra" } });
		const none = resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "none" }, SUB);
		expect(none.ok).toBe(false);
	});

	// 0.51.0 reverses the 0.48.0 pin "no first-party row is claimed": the model
	// page was read on 2026-10-17 and the row exists (five levels, no `none`,
	// default medium, 1,050,000 window, $2 / $10, cache read $0.10). The
	// subscription row above is untouched, and the two stay apart by endpoint.
	it("the first-party row (2026-10-17) is its own: five levels, default medium, and it never lends the subscription's `ultra`", () => {
		const first = lookupModelMetadata("gpt-6.1-sol", FIRST);
		expect(first?.providerId).toBe("openai");
		expect(first?.capabilities.reasoning?.effort).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], default: "medium", wire: "reasoning.effort" });
		expect(first?.capabilities.contextWindow).toBe(1_050_000);
		expect(first?.pricing).toMatchObject({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, asOf: "2026-10-17" });
		expect(resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "ultra" }, FIRST).ok).toBe(false);
		expect(resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "none" }, FIRST).ok).toBe(false);
		expect(resolveReasoning("gpt-6.1-sol", { thinking: "default", effort: "max" }, FIRST)).toEqual({ ok: true, wire: { effort: "max" } });
	});
});
