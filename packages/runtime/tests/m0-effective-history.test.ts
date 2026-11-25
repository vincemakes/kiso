/**
 * ADR-0063 M0 — effective history (spec rev 2.2 § 3–§ 4). The parity test
 * is the one that enforces "no second interpreter": the current view of the
 * evidence must say what `projectMessages` renders. The other tests pin the
 * covered view, the statuses, the pairing rule and the two authority
 * functions.
 */

import { describe, expect, it } from "vitest";
import { projectMessages, resolveHistory, type Event } from "@vincemakes/kiso-core";
import {
	effectiveHistory,
	humanAuthority,
	humanAuthoredSurface,
	parityMismatches,
} from "../src/effective-history.js";

const log = (events: unknown[]): Event[] => events as Event[];

const plain = log([
	{ seq: 0, type: "user_input", content: "hello" },
	{ seq: 1, type: "text_delta", text: "hi " },
	{ seq: 2, type: "text_delta", text: "there" },
	{ seq: 3, type: "stop", reason: "end_turn" },
	{ seq: 4, type: "user_input", content: "bye" },
]);

const replaced = log([
	{ seq: 0, type: "user_input", content: "typed by the person" },
	{ seq: 1, type: "user_input_replaced", replaces: 0, content: "rewritten by the hook" },
	{ seq: 2, type: "text_delta", text: "ok" },
	{ seq: 3, type: "stop", reason: "end_turn" },
]);

const vetoed = log([
	{ seq: 0, type: "user_input", content: "never sent" },
	{ seq: 1, type: "user_input_replaced", replaces: 0, content: null },
	{ seq: 2, type: "user_input", content: "next" },
]);

const abandoned = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "text_delta", text: "draft" },
	{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "resume" },
	{ seq: 3, type: "text_delta", text: "retry" },
	{ seq: 4, type: "stop", reason: "end_turn" },
]);

// The P0 fixture: c1 reused; the second c1 is voided; its receipt names it.
const duplicateCallId = log([
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
const legacyTwin = duplicateCallId.map((e) => {
	if (e.type !== "tool_result") return e;
	const { invocationSeq: _drop, ...rest } = e as { invocationSeq?: number };
	return rest as unknown as Event;
});

// Fixture 4b: a call and its result both inside the live checkpoint, a
// superseded checkpoint before it.
const coveredPair = log([
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
const coveredPairLegacy = coveredPair.map((e) => {
	if (e.type !== "tool_result") return e;
	const { invocationSeq: _drop, ...rest } = e as { invocationSeq?: number };
	return rest as unknown as Event;
});

// Voided wins over covered: a draft that a later checkpoint also covers.
const voidedCovered = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "text_delta", text: "draft" },
	{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "resume" },
	{ seq: 3, type: "text_delta", text: "retry" },
	{ seq: 4, type: "stop", reason: "end_turn" },
	{ seq: 5, type: "user_input", content: "next" },
	{ seq: 6, type: "summarized", coversToSeq: 4, summary: "s" },
]);

// A mid-execution input the projection holds past the turn's results.
const held = log([
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "user_input", content: "interjection" },
	{ seq: 5, type: "tool_result", callId: "c1", invocationSeq: 2, content: "A", isError: false },
]);

// One assistant message with several text blocks: an explicit boundary,
// then a tool call between two texts.
const blocks = log([
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
const authority = log([
	{ seq: 0, type: "user_input", content: "plain" },
	{ seq: 1, type: "user_input", content: "the expanded body says something the line does not", via: { kind: "skill", name: "deploy", line: "/deploy staging" } },
	{ seq: 2, type: "user_input", content: "task t1 exited", via: { kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] } },
	{ seq: 3, type: "user_input", content: "hi from a peer", via: { kind: "peer", event: "message", from: "w2", messageId: "m1", rootId: "r1" } },
	{ seq: 4, type: "user_input", content: "a recycled chip", source: "suggestion" },
	{ seq: 5, type: "permission_decided", decisionId: "d1", decision: "denied", reason: "not on main" },
	{ seq: 6, type: "permission_decided", decisionId: "d2", decision: "approved", reason: "policy", decidedBy: "ext" },
]);

const all = { plain, blocks, replaced, vetoed, abandoned, duplicateCallId, legacyTwin, coveredPair, coveredPairLegacy, voidedCovered, held, authority };

describe("M0 effective history", () => {
	it.each(Object.entries(all))("projection parity: %s", (_name, events) => {
		expect(parityMismatches(events)).toEqual([]);
	});

	it("coverage: covered evidence stays, effective, with coveredBy the live checkpoint's seq", () => {
		const ev = effectiveHistory(coveredPair);
		const at = (seq: number) => ev.find((e) => e.seq === seq)!;
		for (const seq of [0, 2, 4, 5]) expect(at(seq).provenance.coveredBy).toBe(11);
		expect(at(4)).toMatchObject({ kind: "tool", content: "tests passed", structuralStatus: "effective" });
		expect(at(7).provenance.coveredBy).toBeUndefined();
	});

	it("4b: the covered call and result pair, legacy twin included", () => {
		for (const events of [coveredPair, coveredPairLegacy]) {
			const result = effectiveHistory(events).find((e) => e.kind === "tool")!;
			expect(result.structuralStatus).toBe("effective");
			expect(result.provenance.coveredBy).toBe(11);
		}
	});

	it("voided wins over covered: an abandoned draft is never effective evidence", () => {
		const draft = effectiveHistory(voidedCovered).find((e) => e.content === "draft")!;
		expect(draft.structuralStatus).toBe("abandoned");
		expect(draft.provenance.coveredBy).toBeUndefined();
	});

	it("statuses: replaced (audit), vetoed, abandoned, orphaned", () => {
		expect(effectiveHistory(replaced).filter((e) => e.seq === 0).map((e) => [e.structuralStatus, e.content])).toEqual([["effective", "rewritten by the hook"]]);
		expect(effectiveHistory(replaced, { audit: true }).filter((e) => e.seq === 0).map((e) => e.structuralStatus)).toEqual(["replaced", "effective"]);
		expect(effectiveHistory(vetoed).find((e) => e.seq === 0)?.structuralStatus).toBe("vetoed");
		expect(effectiveHistory(abandoned).find((e) => e.content === "draft")?.structuralStatus).toBe("abandoned");
		const results = effectiveHistory(duplicateCallId).filter((e) => e.kind === "tool");
		expect(results.map((e) => [e.content, e.structuralStatus])).toEqual([["A", "effective"], ["B", "orphaned"]]);
	});

	it("4a: legacy pairing matches the projection (parity, not a fixed expectation)", () => {
		const evidenced = effectiveHistory(legacyTwin).filter((e) => e.kind === "tool" && e.structuralStatus === "effective").map((e) => e.content);
		const projected = projectMessages(legacyTwin).flatMap((m) => (m.role === "tool" ? [m.content] : []));
		expect(evidenced).toEqual(projected);
	});

	it("humanAuthority, one case per row", () => {
		expect(authority.map(humanAuthority)).toEqual(["user", "user", "runtime", "peer", "none", "user", "runtime"]);
		expect(humanAuthority(plain[1]!)).toBe("none");
	});

	it("humanAuthoredSurface: the person's own text, never a rewrite or an expanded body", () => {
		const r = resolveHistory(authority);
		expect(authority.map((e) => humanAuthoredSurface(e, r))).toEqual(["plain", "/deploy staging", null, null, null, "not on main", null]);
		const rr = resolveHistory(replaced);
		expect(humanAuthoredSurface(replaced[0]!, rr)).toBe("typed by the person");
		const rv = resolveHistory(vetoed);
		expect(humanAuthoredSurface(vetoed[0]!, rv)).toBeNull();
	});

	it("evidence authority follows humanAuthority (none becomes unknown)", () => {
		expect(effectiveHistory(authority).map((e) => e.authority)).toEqual(["user", "user", "runtime", "peer", "unknown", "user", "runtime"]);
	});
});
