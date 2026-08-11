/**
 * R-F 0.1.46 — the α-gap ruling (ADR-0047 Amendment 2). The OPEN row of
 * ADR-0047 Amendment 1: the ALREADY-EXECUTED draft call — a kill that
 * lands after the execution began leaves the started + receipt INSIDE a
 * no-stop suffix. The declaration is voided as model output; the
 * framework facts (started, receipt, result) survive in the audit; pair
 * atomicity drops the orphan result from the provider projection.
 *
 * RULED (2026-08-11, the round's adjudication): pin current — the
 * receipted execution is an OUTCOME (the mirror of ruling #12: a complete
 * receipt IS the outcome), NEVER uncertain; the audit keeps the receipt.
 * Only the started-no-receipt window stays uncertain (the crash window).
 *
 * This row is NEW (not part of the inviolable R-E gates) — it asserts the
 * adjudicated behavior THROUGH THE PLAN: the first derivation is
 * ABANDON_DRAFT (the draft dies), then CONTINUE_MODEL (nothing left to
 * repair — the receipted pair is complete), then TERMINAL — and the
 * resume walks the same ordinary program: no ResumeBlockedError, the
 * provider stream stays pair-closed, the terminal completes.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event, type Message, type Tool } from "@vincemakes/kiso-core";
import { createAgent, type AgentSession, SessionStore } from "../src/index.js";
import { deriveRecoveryPlan } from "../src/recovery-plan.js";

/** A tool whose side effect is a marker file — observable across the run. */
function markerTool(markerPath: string): Tool<{ query: string }> {
	return defineTool<{ query: string }>({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		execute: async (input) => {
			writeFileSync(markerPath, input.query, "utf8");
			return { content: `results for ${input.query}`, isError: false };
		},
	});
}

/** One scripted turn, then nothing — the resumed continuation ends clean. */
function doneAdapter() {
	const requests: Message[][] = [];
	const adapter: Adapter = {
		stream(options) {
			requests.push(options.messages as Message[]);
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "stop" as const, reason: "end_turn", seq: 0 } satisfies AdapterEvent;
				},
			};
		},
	};
	return { adapter, requests };
}

/** The provider pairing invariant: every projected tool_use has its tool
 *  message and vice versa — an orphan result is the live 400's shape. */
const pairClosed = (msgs: readonly Message[]): boolean => {
	const calls = msgs
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.blocks.filter((b) => b.type === "tool_use"))
		.map((b) => b.callId)
		.sort();
	const tools = msgs.filter((m) => m.role === "tool").map((m) => m.callId).sort();
	return calls.length === tools.length && calls.every((id, i) => id === tools[i]);
};

const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal");

// The α prefix (explicit seqs): turn 1 completes cleanly; turn 2 is the
// DRAFT — the α shape: a kill AFTER the execution began leaves the full
// receipt inside the no-stop suffix.
const USER: Event = { seq: 0, type: "user_input", content: "go" };
const CALL: Event = { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } };
const DECIDED: Event = { seq: 2, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "approved", decidedBy: "mode:default" };
const STARTED: Event = { seq: 3, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } };
const SUCCEEDED: Event = { seq: 4, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "receipt", isError: false } };
const RESULT: Event = { seq: 5, type: "tool_result", callId: "c1", content: "receipt", isError: false, executionId: "ex-1" };
const STOP: Event = { seq: 6, type: "stop", reason: "end_turn" };
// the draft's own turn — the α shape: text + call + a COMPLETE execution
const DRAFT_TEXT: Event = { seq: 7, type: "text_delta", text: "let me do the thing" };
const DRAFT_CALL: Event = { seq: 8, type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "x" } };
const DRAFT_DECIDED: Event = { seq: 9, type: "permission_decided", decisionId: "d2", callId: "c2", decision: "approved", decidedBy: "mode:default" };
const DRAFT_STARTED: Event = { seq: 10, type: "tool_execution_started", executionId: "ex-2", callId: "c2", name: "web_search", input: { query: "x" } };
const DRAFT_SUCCEEDED: Event = { seq: 11, type: "tool_execution_succeeded", executionId: "ex-2", callId: "c2", result: { content: "draft receipt", isError: false } };
const DRAFT_RESULT: Event = { seq: 12, type: "tool_result", callId: "c2", content: "draft receipt", isError: false, executionId: "ex-2" };

const PREFIX: readonly Event[] = [
	USER, CALL, DECIDED, STARTED, SUCCEEDED, RESULT, STOP, DRAFT_TEXT, DRAFT_CALL, DRAFT_DECIDED, DRAFT_STARTED, DRAFT_SUCCEEDED, DRAFT_RESULT,
];

describe("the α-gap ruling (ADR-0047 Amendment 2): the already-executed draft call", () => {
	it("the plan derives ABANDON_DRAFT first — the draft dies, the receipted execution is an outcome, never uncertain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-alpha-"));
		const marker = join(dir, "side-effect.txt");
		const store = new SessionStore(dir);
		for (const ev of PREFIX) await store.append("s", "r1", ev);
		store.closeAll();

		// The FIRST derivation, on the raw durable prefix: the draft dies
		// before anything else — and it is ABANDON_DRAFT, never
		// RESOLVE_UNCERTAIN (the receipted execution is not uncertain).
		expect(deriveRecoveryPlan(PREFIX, PREFIX)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 6 });

		const { adapter, requests } = doneAdapter();
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [markerTool(marker)],
			adapter,
		});
		const session = await agent.session({ id: "s" });

		// The resume walks the same ordinary program: no ResumeBlockedError
		// (the α execution was receipted — an outcome), the run completes.
		const events: Event[] = [];
		for await (const ev of session.resume()) events.push(ev);
		expect(terminalOf(events)?.outcome.kind).toBe("completed");
		expect(requests.length).toBe(1); // the continuation re-drove the model

		// The audit keeps the receipt — the framework facts survive the void.
		const records = new SessionStore(dir).load("s");
		expect(records.some((r) => r.event.type === "tool_execution_started" && r.event.executionId === "ex-2")).toBe(true);
		expect(records.some((r) => r.event.type === "tool_execution_succeeded" && r.event.executionId === "ex-2")).toBe(true);
		expect(records.some((r) => r.event.type === "tool_result" && r.event.executionId === "ex-2")).toBe(true);

		// Pair atomicity: the orphan result never reaches the provider.
		expect(pairClosed(requests[0]!)).toBe(true);

		// The draft's call never executed against the world.
		expect(existsSync(marker)).toBe(false);

		// The plan sequence: after the marker, nothing left to repair; after
		// the run, terminal.
		const events2 = records.map((r) => r.event);
		expect(deriveRecoveryPlan([...PREFIX, { seq: 13, type: "model_output_abandoned", voidFromSeq: 6, reason: "x" }], PREFIX)).toEqual({
			kind: "CONTINUE_MODEL",
		});
		expect(deriveRecoveryPlan(events2, PREFIX).kind).toBe("TERMINAL");
	});

	it("the started-no-receipt window INSIDE a draft stays uncertain — the crash window is the human's (the ruling's other side)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-alpha2-"));
		const store = new SessionStore(dir);
		// the draft's execution STARTED but never receipted — the kill landed
		// INSIDE the window: still UNCERTAIN (the ruling pins only the
		// RECEIPTED execution; the window itself is the human's).
		const prefix: readonly Event[] = [...PREFIX.slice(0, 11)];
		for (const ev of prefix) await store.append("s", "r1", ev);
		store.closeAll();

		expect(deriveRecoveryPlan(prefix, prefix)).toEqual({ kind: "RESOLVE_UNCERTAIN", executionId: "ex-2" });
	});
});
