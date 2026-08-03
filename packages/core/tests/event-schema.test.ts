/**
 * A 组 — full per-variant runtime schema validation: valid JSON that is
 * not a well-formed kiso event of its declared variant is corruption.
 */

import { describe, expect, it } from "vitest";
import { isKisoEvent } from "../src/index.js";

describe("isKisoEvent per-variant schema (A 组)", () => {
	it("accepts well-formed events of every persisted variant", () => {
		expect(isKisoEvent({ seq: 0, type: "stop", reason: "end_turn" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "text_delta", text: "hi" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: null })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: "hi" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "usage", known: false, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "completed" } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ callId: "c1", content: "marker" }] })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "boom", safeToRetry: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "rerun" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "approved" })).toBe(true);
	});

	it("rejects shape violations per variant — type/seq alone is not enough", () => {
		// stop without a reason
		expect(isKisoEvent({ seq: 0, type: "stop" })).toBe(false);
		// text_delta without text
		expect(isKisoEvent({ seq: 0, type: "text_delta" })).toBe(false);
		// tool_call_end without input
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x" })).toBe(false);
		// tool_result with a non-boolean isError
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "x", isError: "yes" })).toBe(false);
		// terminal without an outcome
		expect(isKisoEvent({ seq: 0, type: "terminal" })).toBe(false);
		// compacted without the persisted cleared array
		expect(isKisoEvent({ seq: 0, type: "compacted", clearedCallIds: ["c1"] })).toBe(false);
		// usage without known
		expect(isKisoEvent({ seq: 0, type: "usage", inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe(false);
		// execution started without an executionId
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", callId: "c1", name: "x", input: {} })).toBe(false);
		// failed without safeToRetry
		expect(isKisoEvent({ seq: 0, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "x" })).toBe(false);
		// resolution with a bogus resolution value
		expect(isKisoEvent({ seq: 0, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "maybe" })).toBe(false);
		// permission decided with a bogus decision
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "maybe" })).toBe(false);
	});

	it("rejects unknown types and non-objects", () => {
		expect(isKisoEvent({ seq: 0, type: "nonsense" })).toBe(false);
		expect(isKisoEvent(null)).toBe(false);
		expect(isKisoEvent("stop")).toBe(false);
		expect(isKisoEvent({ type: "stop", reason: "end_turn" })).toBe(false); // no seq
	});
});
