/**
 * R-H 0.1.49 — the adapter whitelist drift gate (ADR-0051 §4, ruling R5):
 * ADAPTER_EVENT_TYPES is the FROZEN 9-type contract table. Per the ruling,
 * every change to ADAPTER_EVENT_TYPES is ITSELF a contract amendment
 * (amendment-by-ritual) — this gate turns the ruling into a red: the
 * whitelist must stay equal to the frozen table, and the loop's trust
 * gate must keep rejecting anything outside it.
 */

import { describe, expect, it } from "vitest";
import { ADAPTER_EVENT_TYPES, isAdapterEvent } from "../src/protocol/adapter.js";

/** The frozen table (ADR-0051 §4) — changing this test is a contract
 *  amendment, not a code edit. */
const FROZEN_WHITELIST = [
	"text_start",
	"text_delta",
	"text_end",
	"tool_call_start",
	"tool_call_input_delta",
	"tool_call_end",
	"thinking",
	"usage",
	"stop",
] as const;

describe("R-H 0.1.49 — the adapter whitelist drift gate (R5)", () => {
	it("ADAPTER_EVENT_TYPES equals the frozen 9-type table, exactly", () => {
		expect(ADAPTER_EVENT_TYPES.size).toBe(9);
		expect([...ADAPTER_EVENT_TYPES].sort()).toEqual([...FROZEN_WHITELIST].sort());
	});

	it("an event outside the whitelist is rejected by the trust gate — never persisted", () => {
		// tool_result is a legal kiso event, but NOT an adapter event: the
		// loop's trust gate must refuse it (loop.ts, the invalid_request
		// path — ADR-0051 §4).
		const illegal = { type: "tool_result", callId: "c1", content: "x", isError: false, seq: 0 };
		expect(isAdapterEvent(illegal)).toBe(false);
	});
});
