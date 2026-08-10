/**
 * R-E 0.1.43 — the prefix table gate (Spec = Test): the directive's
 * durable-prefix table, executed as a permanent test. For every valid
 * durable prefix the recovery must derive EXACTLY ONE safe next action —
 * this file is that table, and npm run check runs it on every commit
 * (it survives the R-F round unchanged: a zero-behavior proof machine).
 *
 *   durable prefix                                   unique safe action
 *   user_input only                                   call the model
 *   tail draft, no stop (its call included)           abandon marker + re-request
 *   call_end + stop, no decided/started/result        re-enter the approval pipeline
 *   permission_requested pending                      wait for the human
 *   decided=approved, no started                      execute the persisted call
 *   decided=denied, no result                         write the denial result
 *   started, no receipt                               UNCERTAIN — the human decides (never auto-rerun)
 *   receipt (succeeded/failed), no result             complete the result from the receipt
 *   resolved, no result                               write the resolution fill
 *   result complete                                   continue
 *   terminal                                          done
 *
 * R-E 0.1.44 — the LIVE-ORDER rows: the live writer interleaves the stop
 * INSIDE the last call's lifecycle (started < stop < succeeded/result) and
 * kills at the approval panel (a tool-call-only suffix with no stop). The
 * abandon marker must void model output ONLY — never the framework's facts
 * (tool_result, permission*, tool_execution); an orphan result never
 * projects alone; a stored request whose invocation is voided is expired.
 *   [live] single-call straddle (started < stop < receipt)   the result is a framework fact — never voided
 *   [live] dual-call parallel straddle (0143b)               every pair stays closed
 *   [live] the 0143 shape (straddle + post-marker run)       pair atomicity — the orphan never projects
 *   [live] no-stop + request (the approval-panel kill)       the voided request is expired — never re-presented/executed
 *
 * Each row builds a store with exactly the listed durable prefix, resumes
 * it, and asserts the one safe action — nothing else. A row that needs
 * two actions (or executes without its durable authorization) is a
 * prefix-completeness violation, not a test bug.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event, type Message, type Tool } from "@vincemakes/kiso-core";
import { createAgent, type AgentSession, SessionStore } from "../src/index.js";

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

/** A provider that serves one scripted turn per stream call and captures
 *  every request — the gate asserts on the request bytes too. */
function scriptedAdapter(script: ReadonlyArray<ReadonlyArray<AdapterEvent>>) {
	const requests: Message[][] = [];
	let call = 0;
	const adapter: Adapter = {
		stream(options) {
			requests.push(options.messages as Message[]);
			const turn = script[Math.min(call, script.length - 1)] ?? [];
			call++;
			return {
				async *[Symbol.asyncIterator]() {
					for (const ev of turn) yield ev;
				},
			};
		},
	};
	return { adapter, requests };
}

const END_TURN: ReadonlyArray<AdapterEvent> = [{ type: "stop", reason: "end_turn", seq: 0 }];
const FRESH: ReadonlyArray<AdapterEvent> = [
	{ type: "text_delta", text: "FRESH OUTPUT", seq: 0 },
	{ type: "stop", reason: "end_turn", seq: 1 },
];

// The durable prefix pieces (explicit seqs — the store writes them as-is).
const USER: Event = { seq: 0, type: "user_input", content: "go" };
const CALL: Event = { seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } };
const STOP: Event = { seq: 2, type: "stop", reason: "tool_use" };
const REQ: Event = { seq: 3, type: "permission_requested", decisionId: "d1", callId: "c1", name: "web_search", input: { query: "k" } };
const DECIDED: Event = { seq: 4, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "approved" };
const DECIDED_DENIED: Event = { seq: 4, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "denied", reason: "human said no" };
const STARTED: Event = { seq: 5, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } };
const SUCCEEDED: Event = { seq: 6, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "receipt content", isError: false } };
const FAILED: Event = { seq: 6, type: "tool_execution_failed", executionId: "ex-1", callId: "c1", error: "boom", errorKind: "fatal", safeToRetry: false };
const RESOLVED: Event = { seq: 6, type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "abandoned" };
const RESULT: Event = { seq: 7, type: "tool_result", callId: "c1", content: "results for k", isError: false, executionId: "ex-1" };
const TERMINAL: Event = { seq: 1, type: "terminal", outcome: { kind: "completed" } };

type GateRow = {
	name: string;
	action: string;
	prefix: ReadonlyArray<Event>;
	script: ReadonlyArray<ReadonlyArray<AdapterEvent>>;
	/** defer: the composed chain asks on UNDECIDED (row 3). */
	policy?: "defer";
	assert: (ctx: { session: AgentSession; requests: Message[][]; marker: string; dir: string }) => Promise<void>;
};

const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal");

/** R-E 0.1.44: the provider pairing invariant — every projected tool_use has
 *  its tool message and vice versa (an unpaired tool_use or an orphan
 *  tool_result is the live 400's shape). */
const pairClosed = (msgs: readonly Message[]): boolean => {
	const calls = msgs
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.blocks.filter((b) => b.type === "tool_use"))
		.map((b) => b.callId)
		.sort();
	const tools = msgs.filter((m) => m.role === "tool").map((m) => m.callId).sort();
	return calls.length === tools.length && calls.every((id, i) => id === tools[i]);
};

const TABLE: ReadonlyArray<GateRow> = [
	{
		name: "user_input only",
		action: "call the model",
		prefix: [USER],
		script: [END_TURN],
		assert: async ({ session, requests, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(requests.length).toBe(1); // the model WAS called
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
			const records = new SessionStore(dir).load("s");
			expect(records.some((r) => r.event.type === "model_output_abandoned")).toBe(false); // no draft — no marker
		},
	},
	{
		name: "tail draft, no stop (its call included)",
		action: "abandon marker + re-request the model",
		prefix: [
			USER,
			{ seq: 1, type: "text_delta", text: "the draft answer begins" },
			{ ...CALL, seq: 2 },
			{ seq: 3, type: "text_delta", text: " and continues" },
		],
		script: [FRESH],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			const records = new SessionStore(dir).load("s");
			const markerEvent = records.find((r) => r.event.type === "model_output_abandoned")?.event;
			expect(markerEvent).toBeDefined(); // the void marker was appended
			expect(markerEvent).toMatchObject({ voidFromSeq: 0 }); // voids everything after the user_input
			expect(requests[0]).toBeDefined();
			expect(
				requests[0]!.some((m) => m.role === "assistant" && JSON.stringify(m).includes("the draft answer begins")),
			).toBe(false); // the draft never reaches the provider
			expect(requests[0]!.some((m) => m.role === "assistant" && m.blocks.some((b) => b.type === "tool_use"))).toBe(false); // nor its call
			expect(existsSync(marker)).toBe(false); // the draft's call never executed
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "call_end + stop, no decided/started/result",
		action: "re-enter the approval pipeline",
		prefix: [USER, CALL, STOP],
		script: [END_TURN],
		policy: "defer",
		assert: async ({ session, requests, marker }) => {
			const events: Event[] = [];
			let asks = 0;
			for await (const ev of session.resume()) {
				events.push(ev);
				if (ev.type === "permission_requested") {
					asks++;
					await session.approve(ev.decisionId, true);
				}
			}
			expect(asks).toBe(1); // the UNDECIDED call re-entered the pipeline — exactly one ask
			expect(existsSync(marker)).toBe(true); // the re-decided call executed
			expect(requests.length).toBe(1); // the continuation re-drove the model — pair-closed
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "permission_requested pending",
		action: "wait for the human",
		prefix: [USER, CALL, STOP, REQ],
		script: [END_TURN],
		assert: async ({ session, requests, marker }) => {
			const events: Event[] = [];
			const announced: string[] = [];
			for await (const ev of session.resume()) {
				events.push(ev);
				if (ev.type === "permission_requested") {
					announced.push(ev.decisionId);
					expect(existsSync(marker)).toBe(false); // NOTHING executes before the human decides
					await session.approve(ev.decisionId, true);
				}
			}
			expect(announced).toEqual(["d1"]); // the STORED request — same decisionId, never re-asked
			expect(existsSync(marker)).toBe(true); // executed only after the human
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "decided=approved, no started",
		action: "execute the persisted call",
		prefix: [USER, CALL, STOP, REQ, DECIDED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(events.some((e) => e.type === "permission_requested")).toBe(false); // never re-asked
			expect(existsSync(marker)).toBe(true); // the persisted call executed
			const records = new SessionStore(dir).load("s");
			expect(records.filter((r) => r.event.type === "permission_decided")).toHaveLength(1); // never re-decided
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "decided=denied, no result",
		action: "write the denial result",
		prefix: [USER, CALL, STOP, REQ, DECIDED_DENIED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(existsSync(marker)).toBe(false); // the durable denial held — never executed
			const records = new SessionStore(dir).load("s");
			const results = records.filter((r) => r.event.type === "tool_result");
			expect(results).toHaveLength(1);
			expect(results[0]!.event).toMatchObject({ callId: "c1", isError: true }); // the denial result
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "started, no receipt",
		action: "UNCERTAIN — the human decides (never auto-rerun)",
		prefix: [USER, CALL, STOP, REQ, DECIDED, STARTED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			await expect(async () => {
				for await (const _ev of session.resume()) {
					// drain — the resume must be blocked, not resolved
				}
			}).rejects.toThrow(/uncertain/);
			expect(existsSync(marker)).toBe(false); // never auto-rerun
			await session.resolveUncertain("ex-1", "abandoned");
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			const records = new SessionStore(dir).load("s");
			expect(records.some((r) => r.event.type === "tool_result" && r.event.errorKind === "precondition")).toBe(true); // the resolution fill
			expect(existsSync(marker)).toBe(false); // abandoned — still never rerun
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "receipt (succeeded), no result",
		action: "complete the result from the receipt",
		prefix: [USER, CALL, STOP, REQ, DECIDED, STARTED, SUCCEEDED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(existsSync(marker)).toBe(false); // completed FROM THE RECEIPT — never re-executed
			const records = new SessionStore(dir).load("s");
			const results = records.filter((r) => r.event.type === "tool_result");
			expect(results).toHaveLength(1);
			expect(results[0]!.event).toMatchObject({ content: "receipt content", isError: false });
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "receipt (failed), no result",
		action: "complete the result from the receipt",
		prefix: [USER, CALL, STOP, REQ, DECIDED, STARTED, FAILED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(existsSync(marker)).toBe(false);
			const records = new SessionStore(dir).load("s");
			const results = records.filter((r) => r.event.type === "tool_result");
			expect(results).toHaveLength(1);
			expect(results[0]!.event).toMatchObject({ content: "boom", isError: true }); // the receipt's error
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "resolved, no result",
		action: "write the resolution fill",
		prefix: [USER, CALL, STOP, REQ, DECIDED, STARTED, RESOLVED],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(existsSync(marker)).toBe(false);
			const records = new SessionStore(dir).load("s");
			expect(records.some((r) => r.event.type === "tool_result" && r.event.errorKind === "precondition")).toBe(true);
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "result complete",
		action: "continue",
		prefix: [USER, CALL, STOP, REQ, DECIDED, STARTED, SUCCEEDED, RESULT],
		script: [END_TURN],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			const records = new SessionStore(dir).load("s");
			expect(records.filter((r) => r.event.type === "tool_execution_started" && r.event.callId === "c1")).toHaveLength(1); // never re-executed
			expect(records.filter((r) => r.event.type === "tool_result")).toHaveLength(1); // never re-completed
			expect(records.filter((r) => r.event.type === "permission_decided")).toHaveLength(1); // never re-decided
			expect(existsSync(marker)).toBe(false);
			expect(requests.length).toBe(1); // the continuation re-drove the model
			expect(requests[0]!.some((m) => m.role === "tool" && m.callId === "c1")).toBe(true); // with the closed pair
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "live-order: the minimal single-call straddle (started < stop < succeeded/result)",
		action: "the void covers model output only — the straddling result survives and the pair stays closed",
		prefix: [
			USER,
			{ ...CALL, seq: 1 },
			{ ...DECIDED, seq: 2, decidedBy: "mode:default" },
			{ ...STARTED, seq: 3 },
			{ ...STOP, seq: 4 },
			{ ...SUCCEEDED, seq: 5 },
			{ ...RESULT, seq: 6 },
			{ seq: 7, type: "text_delta", text: "the post-tool answer begins" },
		],
		script: [FRESH],
		assert: async ({ session, requests }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(pairClosed(requests[0]!)).toBe(true); // the straddling result was never swallowed
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "live-order: the dual-call parallel straddle (0143b — call 2's receipt after the stop)",
		action: "both pairs stay closed — the late result is a framework fact, never voided",
		prefix: [
			USER,
			{ ...CALL, seq: 1, callId: "c1" },
			{ ...REQ, seq: 2, decisionId: "d1", callId: "c1" },
			{ ...DECIDED, seq: 3, decisionId: "d1", callId: "c1", decidedBy: "mode:default" },
			{ ...STARTED, seq: 4, executionId: "ex-1", callId: "c1" },
			{ ...SUCCEEDED, seq: 5, executionId: "ex-1", callId: "c1" },
			{ ...RESULT, seq: 6, callId: "c1", executionId: "ex-1" },
			{ ...CALL, seq: 7, callId: "c2" },
			{ ...REQ, seq: 8, decisionId: "d2", callId: "c2" },
			{ ...DECIDED, seq: 9, decisionId: "d2", callId: "c2", decidedBy: "mode:default" },
			{ ...STARTED, seq: 10, executionId: "ex-2", callId: "c2" },
			{ ...STOP, seq: 11 },
			{ ...SUCCEEDED, seq: 12, executionId: "ex-2", callId: "c2" },
			{ ...RESULT, seq: 13, callId: "c2", executionId: "ex-2" },
			{ seq: 14, type: "text_delta", text: "the post-tool answer begins" },
		],
		script: [FRESH],
		assert: async ({ session, requests }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(pairClosed(requests[0]!)).toBe(true); // both straddled results survive the void
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "live-order: the 0143 shape — the straddle plus the voided request's post-marker execution",
		action: "pair atomicity — the voided declaration's orphan result never projects",
		prefix: [
			USER,
			{ ...CALL, seq: 1, callId: "c1" },
			{ ...REQ, seq: 2, decisionId: "d1", callId: "c1" },
			{ ...DECIDED, seq: 3, decisionId: "d1", callId: "c1", decidedBy: "mode:default" },
			{ ...STARTED, seq: 4, executionId: "ex-1", callId: "c1" },
			{ ...CALL, seq: 5, callId: "c2" },
			{ ...SUCCEEDED, seq: 6, executionId: "ex-1", callId: "c1" },
			{ ...RESULT, seq: 7, callId: "c1", executionId: "ex-1" },
			{ ...REQ, seq: 8, decisionId: "d2", callId: "c2" },
			{ ...DECIDED, seq: 9, decisionId: "d2", callId: "c2", decidedBy: "mode:default" },
			{ ...STARTED, seq: 10, executionId: "ex-2", callId: "c2" },
			{ ...STOP, seq: 11 },
			{ ...SUCCEEDED, seq: 12, executionId: "ex-2", callId: "c2" },
			{ ...RESULT, seq: 13, callId: "c2", executionId: "ex-2" },
			{ seq: 14, type: "text_delta", text: "let me edit that file" },
			{ ...CALL, seq: 15, callId: "c3" },
			{ ...REQ, seq: 16, decisionId: "d3", callId: "c3", invocationSeq: 15 },
		],
		script: [FRESH],
		assert: async ({ session, requests }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) {
				events.push(ev);
				// 0.1.43: the voided request still binds and re-executes after
				// the marker; the fix expires it. Approve so the 0.1.43
				// trajectory runs to the re-drive (the red is the projection,
				// not a hang).
				if (ev.type === "permission_requested") await session.approve(ev.decisionId, true);
			}
			expect(pairClosed(requests[0]!)).toBe(true); // turn 1's straddled pair AND no orphan from the voided call
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "live-order: the no-stop + request shape (the approval-panel kill — a tool-call-only suffix)",
		action: "a stored request whose invocation is voided is expired — never re-presented, never executed",
		prefix: [
			USER,
			{ ...CALL, seq: 1, callId: "c1" },
			{ ...REQ, seq: 2, decisionId: "d1", callId: "c1" },
			{ ...DECIDED, seq: 3, decisionId: "d1", callId: "c1", decidedBy: "mode:default" },
			{ ...STARTED, seq: 4, executionId: "ex-1", callId: "c1" },
			{ ...SUCCEEDED, seq: 5, executionId: "ex-1", callId: "c1" },
			{ ...RESULT, seq: 6, callId: "c1", executionId: "ex-1" },
			{ ...STOP, seq: 7 },
			// the draft's own turn: pure tool-call output — no text, no stop;
			// the model called again and the kill landed at the approval panel
			{ seq: 8, type: "tool_call_input_delta", callId: "c2", inputJsonDelta: "{\"path\":" },
			{ ...CALL, seq: 9, callId: "c2" },
			{ ...REQ, seq: 10, decisionId: "d2", callId: "c2", invocationSeq: 9 },
		],
		script: [FRESH],
		assert: async ({ session, requests, marker, dir }) => {
			const events: Event[] = [];
			let announced = 0;
			for await (const ev of session.resume()) {
				events.push(ev);
				if (ev.type === "permission_requested") {
					announced++;
					expect(announced).toBe(0); // the voided request is never re-presented (red on 0.1.43)
				}
			}
			const records = new SessionStore(dir).load("s");
			expect(records.some((r) => r.event.type === "permission_expired" && r.event.decisionId === "d2")).toBe(true); // expired — the dead-run precedent
			expect(records.some((r) => r.event.type === "tool_execution_started" && r.event.callId === "c2")).toBe(false); // never executed
			expect(existsSync(marker)).toBe(false); // nor its side effect
			expect(pairClosed(requests[0]!)).toBe(true); // the continuation stays clean
			expect(terminalOf(events)?.outcome.kind).toBe("completed");
		},
	},
	{
		name: "terminal",
		action: "done",
		prefix: [USER, TERMINAL],
		script: [END_TURN],
		assert: async ({ session, requests }) => {
			const events: Event[] = [];
			for await (const ev of session.resume()) events.push(ev);
			expect(events).toEqual([]); // nothing to recover
			expect(requests.length).toBe(0); // the model was never asked
		},
	},
];

describe("the prefix table gate (Spec = Test)", () => {
	for (const row of TABLE) {
		it(`${row.name} → ${row.action}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "kiso-gate-"));
			const marker = join(dir, "side-effect.txt");
			const store = new SessionStore(dir);
			for (const ev of row.prefix) await store.append("s", "r1", ev);
			store.closeAll();

			const { adapter, requests } = scriptedAdapter(row.script);
			const agent = createAgent({
				model: "faux",
				store: new SessionStore(dir),
				tools: [markerTool(marker)],
				adapter,
				...(row.policy === "defer" ? { permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] } } : {}),
			});
			const session = await agent.session({ id: "s" });
			await row.assert({ session, requests, marker, dir });
		});
	}
});
