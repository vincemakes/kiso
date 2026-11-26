/**
 * The effective-history fixture logs, shared by M0 (effective history) and
 * M0.5 (historical retrieval): one shape per structural semantic the
 * projection resolves (spec rev 2.2 § 4; M0.5 spec § 4).
 */
import type { Event } from "@vincemakes/kiso-core";

export const log = (events: unknown[]): Event[] => events as Event[];

export const plain = log([
	{ seq: 0, type: "user_input", content: "hello" },
	{ seq: 1, type: "text_delta", text: "hi " },
	{ seq: 2, type: "text_delta", text: "there" },
	{ seq: 3, type: "stop", reason: "end_turn" },
	{ seq: 4, type: "user_input", content: "bye" },
]);

export const replaced = log([
	{ seq: 0, type: "user_input", content: "typed by the person" },
	{ seq: 1, type: "user_input_replaced", replaces: 0, content: "rewritten by the hook" },
	{ seq: 2, type: "text_delta", text: "ok" },
	{ seq: 3, type: "stop", reason: "end_turn" },
]);

export const vetoed = log([
	{ seq: 0, type: "user_input", content: "never sent" },
	{ seq: 1, type: "user_input_replaced", replaces: 0, content: null },
	{ seq: 2, type: "user_input", content: "next" },
]);

export const abandoned = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "text_delta", text: "draft" },
	{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "resume" },
	{ seq: 3, type: "text_delta", text: "retry" },
	{ seq: 4, type: "stop", reason: "end_turn" },
]);

// The P0 fixture: c1 reused; the second c1 is voided; its receipt names it.
export const duplicateCallId = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "tool_result", callId: "c1", invocationSeq: 2, content: "A", isError: false },
	{ seq: 5, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 6, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "b" } },
	{ seq: 7, type: "model_output_abandoned", voidFromSeq: 4, reason: "resume" },
	{ seq: 8, type: "tool_result", callId: "c1", invocationSeq: 6, content: "B", isError: false },
]);

// Its legacy twin (fixture 4a): neither result carries invocationSeq.
export const legacyTwin = duplicateCallId.map((e) => {
	if (e.type !== "tool_result") return e;
	const { invocationSeq: _drop, ...rest } = e as { invocationSeq?: number };
	return rest as unknown as Event;
});

// Fixture 4b: a call and its result both inside the live checkpoint, a
// superseded checkpoint before it.
export const coveredPair = log([
	{ seq: 0, type: "user_input", content: "run the tests" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "shell" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "shell", input: { command: "npm test" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "tool_result", callId: "c1", invocationSeq: 2, content: "tests passed", isError: false },
	{ seq: 5, type: "text_delta", text: "green" },
	{ seq: 6, type: "stop", reason: "end_turn" },
	{ seq: 7, type: "user_input", content: "now ship it" },
	{ seq: 8, type: "text_delta", text: "shipping" },
	{ seq: 9, type: "stop", reason: "end_turn" },
	{ seq: 10, type: "summarized", coversToSeq: 3, summary: "older" },
	{ seq: 11, type: "summarized", coversToSeq: 6, summary: "live" },
]);
export const coveredPairLegacy = coveredPair.map((e) => {
	if (e.type !== "tool_result") return e;
	const { invocationSeq: _drop, ...rest } = e as { invocationSeq?: number };
	return rest as unknown as Event;
});

// Voided wins over covered: a draft that a later checkpoint also covers.
export const voidedCovered = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "text_delta", text: "draft" },
	{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "resume" },
	{ seq: 3, type: "text_delta", text: "retry" },
	{ seq: 4, type: "stop", reason: "end_turn" },
	{ seq: 5, type: "user_input", content: "next" },
	{ seq: 6, type: "summarized", coversToSeq: 4, summary: "s" },
]);

// A mid-execution input the projection holds past the turn's results.
export const held = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "user_input", content: "interjection" },
	{ seq: 5, type: "tool_result", callId: "c1", invocationSeq: 2, content: "A", isError: false },
]);

// One assistant message with several text blocks: an explicit boundary,
// then a tool call between two texts.
export const blocks = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "text_start" },
	{ seq: 2, type: "text_delta", text: "first" },
	{ seq: 3, type: "text_end" },
	{ seq: 4, type: "text_start" },
	{ seq: 5, type: "text_delta", text: "second" },
	{ seq: 6, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 7, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
	{ seq: 8, type: "text_delta", text: "third" },
	{ seq: 9, type: "stop", reason: "tool_use" },
	{ seq: 10, type: "tool_result", callId: "c1", invocationSeq: 7, content: "A", isError: false },
]);

// The authority table, one event per row.
export const authority = log([
	{ seq: 0, type: "user_input", content: "plain" },
	{ seq: 1, type: "user_input", content: "the expanded body says something the line does not", via: { kind: "skill", name: "deploy", line: "/deploy staging" } },
	{ seq: 2, type: "user_input", content: "task t1 exited", via: { kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] } },
	{ seq: 3, type: "user_input", content: "hi from a peer", via: { kind: "peer", event: "message", from: "w2", messageId: "m1", rootId: "r1" } },
	{ seq: 4, type: "user_input", content: "a recycled chip", source: "suggestion" },
	{ seq: 5, type: "permission_decided", decisionId: "d1", decision: "denied", reason: "not on main" },
	{ seq: 6, type: "permission_decided", decisionId: "d2", decision: "approved", reason: "policy", decidedBy: "ext" },
]);

// M0.5: a coding turn — a path, a symbol, a tool's name — inside the live
// checkpoint, then a later turn that is not.
export const coding = log([
	{ seq: 0, type: "user_input", content: "Fix the tie rule in packages/core/src/kernel/project.ts" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "packages/core/src/kernel/project.ts" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "tool_result", callId: "c1", invocationSeq: 2, content: "export function resolveHistory(events) {", isError: false },
	{ seq: 5, type: "text_delta", text: "The tie is in " },
	{ seq: 6, type: "text_delta", text: "resolveHistory: the later summary wins." },
	{ seq: 7, type: "stop", reason: "end_turn" },
	{ seq: 8, type: "user_input", content: "Now run the TESTS" },
	{ seq: 9, type: "text_delta", text: "tests are green (no .* in any name)" },
	{ seq: 10, type: "stop", reason: "end_turn" },
	{ seq: 11, type: "summarized", coversToSeq: 7, summary: "fixed the tie rule" },
]);

export const all = { plain, coding, blocks, replaced, vetoed, abandoned, duplicateCallId, legacyTwin, coveredPair, coveredPairLegacy, voidedCovered, held, authority };
