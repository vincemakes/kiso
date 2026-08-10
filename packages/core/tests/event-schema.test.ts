/**
 * A group — full per-variant runtime schema validation: valid JSON that is
 * not a well-formed kiso event of its declared variant is corruption.
 */

import { describe, expect, it } from "vitest";
import { isKisoEvent } from "../src/index.js";

describe("isKisoEvent per-variant schema (A group)", () => {
	it("accepts well-formed events of every persisted variant", () => {
		expect(isKisoEvent({ seq: 0, type: "stop", reason: "end_turn" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "text_delta", text: "hi" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: null })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: "hi" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "usage", known: false, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "completed" } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ eventSeq: 3, callId: "c1", content: "marker" }] })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "boom", safeToRetry: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "rerun" })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "x", input: {} })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "approved" })).toBe(true);
		// E1: decidedBy rides on policy decisions; absent = a human decision.
		expect(
			isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "denied", reason: "no", decidedBy: "safe-defaults" }),
		).toBe(true);
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
		// E1: decidedBy must be a string when present
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "approved", decidedBy: 42 })).toBe(false);
	});

	it("round 5: rejects illegal enum values and bad optional fields", () => {
		// stop reason outside the closed union
		expect(isKisoEvent({ seq: 0, type: "stop", reason: "keep_going" })).toBe(false);
		// tool errorKind outside the union
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "x", isError: true, errorKind: "nope" })).toBe(false);
		// structured error code outside the union
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "warp", retryable: false, message: "m" } } })).toBe(false);
		// bad optional source
		expect(isKisoEvent({ seq: 0, type: "user_input", content: "hi", source: "assistant" })).toBe(false);
		// bad optional tags
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "x", isError: false, tags: [1, 2] })).toBe(false);
		// bad optional executionId
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "x", isError: false, executionId: 7 })).toBe(false);
		// resolution outside the union
		expect(isKisoEvent({ seq: 0, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "later" })).toBe(false);
	});

	it("round 5: validates every Terminal union member by its own required fields", () => {
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "max_tokens" } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "max_turns", turns: 3 } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "max_turns" } })).toBe(false); // turns required
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "rate_limit", status: 429, retryable: true, message: "m" } } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "rate_limit", retryable: true } } })).toBe(false); // message required
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error" } })).toBe(false); // error object required
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "aborted", by: "user" } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "aborted" } })).toBe(false); // by required
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "hook_stopped", hook: "x" } })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "hook_stopped" } })).toBe(false); // hook required
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "halfway" } })).toBe(false); // unknown kind
	});

	it("round 5: enforces the Usage known/token invariant", () => {
		const base = { inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null };
		expect(isKisoEvent({ seq: 0, type: "usage", known: false, ...base })).toBe(true);
		// known:false with a NUMBER is a faked token — rejected
		expect(isKisoEvent({ seq: 0, type: "usage", known: false, ...base, inputTokens: 5 })).toBe(false);
		// known:true with reported numbers
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: 5, outputTokens: 3, cacheRead: 2, cacheWrite: 1 })).toBe(true);
		// known:true with a partial report (some nulls) is honest
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: 5, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(true);
		// negative tokens are nonsense
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: -1, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(false);
	});

	it("round 5: validates ContentBlock shapes (text/image) wherever content blocks appear", () => {
		const blockContent = [
			{ type: "text", text: "caption" },
			{ type: "image", sourceType: "base64", data: "cG5n", mediaType: "image/png" },
			{ type: "image", sourceType: "url", url: "https://x/y.png" },
		];
		expect(isKisoEvent({ seq: 0, type: "user_input", content: blockContent })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: blockContent, isError: false })).toBe(true);
		// a rewritten user input may carry blocks too (round 5)
		expect(isKisoEvent({ seq: 0, type: "user_input_replaced", replaces: 0, content: blockContent })).toBe(true);
		// bad shapes
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [{ type: "text" }] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [{ type: "image", sourceType: "base64", data: "x" }] })).toBe(false); // mediaType required
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [{ type: "image", sourceType: "ftp", url: "x" }] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: ["a plain string in the array"] })).toBe(false);
	});

	it("round 5: input must be a plain object — null and arrays are rejected", () => {
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: null })).toBe(true); // parse failure is a documented fact
		expect(isKisoEvent({ seq: 0, type: "tool_call_end", callId: "c1", name: "x", input: ["a", "b"] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: null })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: [1] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "x", input: null })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "x", input: { a: 1 } })).toBe(true);
	});

	it("round 5: validates compacted.cleared elements and the seq itself", () => {
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ eventSeq: 3, callId: "c1", content: "m" }] })).toBe(true);
		// round 4: a v1 entry WITHOUT eventSeq is legal (round-three sessions)
		// — but it must still be a string callId/content pair.
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ callId: "c1", content: "m" }] })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ eventSeq: "3", callId: "c1", content: "m" }] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "compacted", cleared: [{ eventSeq: 3, content: "m" }] })).toBe(false); // callId required
		expect(isKisoEvent({ seq: 0.5, type: "stop", reason: "end_turn" })).toBe(false); // seq must be an integer
		expect(isKisoEvent({ seq: -1, type: "stop", reason: "end_turn" })).toBe(false);
	});

	it("ADR-0044: validates the summarized event (coversToSeq, non-empty summary, covers only the past)", () => {
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: 8, summary: "the summary" })).toBe(true);
		// coversToSeq must be a non-negative safe integer...
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: "8", summary: "s" })).toBe(false);
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: -1, summary: "s" })).toBe(false);
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: 8.5, summary: "s" })).toBe(false);
		// ...the summary must be non-empty text...
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: 8, summary: "" })).toBe(false);
		expect(isKisoEvent({ seq: 10, type: "summarized", coversToSeq: 8 })).toBe(false);
		// ...and it covers only what PRECEDED it.
		expect(isKisoEvent({ seq: 8, type: "summarized", coversToSeq: 8, summary: "s" })).toBe(false);
		expect(isKisoEvent({ seq: 5, type: "summarized", coversToSeq: 8, summary: "s" })).toBe(false);
	});

	it("rejects unknown types and non-objects", () => {
		expect(isKisoEvent({ seq: 0, type: "nonsense" })).toBe(false);
		expect(isKisoEvent(null)).toBe(false);
		expect(isKisoEvent("stop")).toBe(false);
		expect(isKisoEvent({ type: "stop", reason: "end_turn" })).toBe(false); // no seq
	});
});

	it("round 9: counts are non-negative SAFE integers — no negatives, NaN, Infinity, or fractions", () => {
		expect(isKisoEvent({ seq: 0, type: "stop", reason: "end_turn" })).toBe(true);
		expect(isKisoEvent({ seq: 1.5, type: "stop", reason: "end_turn" })).toBe(false);
		expect(isKisoEvent({ seq: Number.NaN, type: "stop", reason: "end_turn" })).toBe(false);
		expect(isKisoEvent({ seq: Number.POSITIVE_INFINITY, type: "stop", reason: "end_turn" })).toBe(false);
		expect(isKisoEvent({ seq: -1, type: "stop", reason: "end_turn" })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "max_turns", turns: 2.5 } })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "max_turns", turns: -2 } })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "rate_limit", status: 429.5, retryable: true, message: "m" } } })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "rate_limit", status: -1, retryable: true, message: "m" } } })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "terminal", outcome: { kind: "error", error: { code: "rate_limit", status: 429, retryable: true, message: "m" } } })).toBe(true);
	});

	it("round 9: known:true usage must report at least one real token", () => {
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: 1, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "usage", known: true, inputTokens: 1.5, outputTokens: null, cacheRead: null, cacheWrite: null })).toBe(false);
	});

	it("round 9: image url/base64 payloads are strictly exclusive", () => {
		const url = { type: "image", sourceType: "url", url: "https://x/y.png" };
		const base64 = { type: "image", sourceType: "base64", data: "cG5n", mediaType: "image/png" };
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [url] })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [base64] })).toBe(true);
		// url block with data, or base64 block with url: rejected.
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [{ type: "image", sourceType: "url", url: "x", data: "y" }] })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "user_input", content: [{ type: "image", sourceType: "base64", data: "x", mediaType: "image/png", url: "y" }] })).toBe(false);
	});

	it("round 9: errorKind is forbidden on a non-error tool_result", () => {
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false, errorKind: "fatal" })).toBe(false);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "boom", isError: true, errorKind: "fatal" })).toBe(true);
	});

	it("R-E 0.1.43: invocationSeq is optional on the seven identity-bearing events; present = the framework invocation identity (a non-negative safe integer)", () => {
		// present and legal on every one of the seven
		expect(isKisoEvent({ seq: 0, type: "permission_requested", decisionId: "d-1", callId: "c1", name: "x", input: {}, invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "approved", callId: "c1", invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: {}, invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "ok", isError: false }, invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "boom", safeToRetry: false, invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "rerun", invocationSeq: 5 })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false, invocationSeq: 5 })).toBe(true);
		// absent = the old-log shape — always legal (the callId + seq-proximity fallback)
		expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false })).toBe(true);
		expect(isKisoEvent({ seq: 0, type: "permission_decided", decisionId: "d-1", decision: "approved" })).toBe(true);
		// present but illegal — negative, fractional, string, NaN, Infinity
		for (const bad of [-1, 1.5, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(isKisoEvent({ seq: 0, type: "tool_result", callId: "c1", content: "ok", isError: false, invocationSeq: bad })).toBe(false);
			expect(isKisoEvent({ seq: 0, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "x", input: {}, invocationSeq: bad })).toBe(false);
		}
		// an invocationSeq on a non-identity event is NOT the field — it must
		// still validate as an unknown property (never corruption) but the
		// identity events above are the only carriers the kernel writes.
		expect(isKisoEvent({ seq: 0, type: "stop", reason: "end_turn", invocationSeq: 5 })).toBe(true);
	});

	it("R-E 0.1.43: the model_output_abandoned marker — a void range over a committed boundary, kernel-owned", () => {
		// legal: voidFromSeq is the last committed boundary BEFORE the marker
		expect(isKisoEvent({ seq: 10, type: "model_output_abandoned", voidFromSeq: 8, reason: "the tail draft" })).toBe(true);
		// the void must cover something and never the marker itself
		expect(isKisoEvent({ seq: 10, type: "model_output_abandoned", voidFromSeq: 10, reason: "x" })).toBe(false);
		expect(isKisoEvent({ seq: 5, type: "model_output_abandoned", voidFromSeq: 8, reason: "x" })).toBe(false);
		// the boundary is a seq; the reason is text
		expect(isKisoEvent({ seq: 10, type: "model_output_abandoned", voidFromSeq: "8", reason: "x" })).toBe(false);
		expect(isKisoEvent({ seq: 10, type: "model_output_abandoned", voidFromSeq: -1, reason: "x" })).toBe(false);
		expect(isKisoEvent({ seq: 10, type: "model_output_abandoned", voidFromSeq: 8 })).toBe(false);
	});
