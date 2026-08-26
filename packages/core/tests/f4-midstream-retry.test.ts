/**
 * F4 (RD1B-F4 / C7) — mid-stream truncation recovery.
 *
 * A retryable stream failure that arrives AFTER streaming began durably
 * voids the uncommitted draft (`model_output_abandoned`) and re-requests
 * under the SAME per-turn budget — never past a confirmed tool effect.
 * The abandon hygiene applies to every mid-stream exit: settle, drain
 * (receipts land), void, and only then a retry or the error terminal.
 *
 * Red on the pre-F4 tree: the catch path returned with the draft
 * un-voided under an error terminal, so the next request projected the
 * draft as committed history (ADR-0047 Gap B, live), and no mid-stream
 * retry existed at all (the `!streamed` guard withheld it).
 */

import { describe, expect, it } from "vitest";
import type { Adapter, StreamOptions } from "../src/protocol/adapter.js";
import type { Event, TerminalEvent } from "../src/protocol/events.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { loop } from "../src/kernel/loop.js";
import { projectMessages } from "../src/kernel/project.js";

async function collect(adapter: Adapter, registry: ToolRegistry, maxRetries: number): Promise<readonly Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({
		adapter,
		model: "faux-model",
		registry,
		messages: [{ role: "user", content: "go" }],
		maxRetries,
	})) {
		events.push(ev);
	}
	return events;
}

function terminalOf(events: readonly Event[]): TerminalEvent {
	const t = events.filter((e) => e.type === "terminal");
	expect(t.length, "exactly one terminal event per run").toBe(1);
	return t[0] as TerminalEvent;
}

function markersOf(events: readonly Event[]) {
	return events.filter((e) => e.type === "model_output_abandoned");
}

const CUT = { code: "overloaded", status: 529, retryable: true, message: "overloaded" };

describe("F4 — the mid-stream retry (T1: text-only draft)", () => {
	it("voids the draft, re-requests once, and the projection carries no draft text", async () => {
		let calls = 0;
		const flaky: Adapter = {
			stream: async function* () {
				calls += 1;
				if (calls === 1) {
					yield { seq: 0, type: "text_start" } as never;
					yield { seq: 0, type: "text_delta", text: "partial" } as never;
					throw CUT;
				}
				yield { seq: 0, type: "text_start" } as never;
				yield { seq: 0, type: "text_delta", text: "recovered" } as never;
				yield { seq: 0, type: "text_end" } as never;
				yield { seq: 0, type: "stop", reason: "end_turn" } as never;
			},
		};
		const events = await collect(flaky, new ToolRegistry(), 2);
		expect(calls, "exactly one re-request").toBe(2);
		const markers = markersOf(events);
		expect(markers.length, "the text-only draft is voided too — broader than the live void").toBe(1);
		// Order: every attempt-1 delta precedes the marker; every attempt-2
		// delta follows it (the marker is the boundary between attempts).
		const partialSeq = events.find((e) => e.type === "text_delta" && (e as { text: string }).text === "partial")!.seq;
		const recoveredSeq = events.find((e) => e.type === "text_delta" && (e as { text: string }).text === "recovered")!.seq;
		expect(partialSeq).toBeLessThan(markers[0]!.seq);
		expect(markers[0]!.seq).toBeLessThan(recoveredSeq);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
		// The glue test: the projection — what the NEXT request derives —
		// carries the recovered answer exactly once and the draft not at all.
		const text = JSON.stringify(projectMessages(events).filter((m) => m.role === "assistant"));
		expect(text).toContain("recovered");
		expect(text).not.toContain("partial");
	});

	it("re-requests byte-equivalently: the retry carries the SAME request the cut interrupted", async () => {
		let calls = 0;
		const seen: Array<Record<string, unknown>> = [];
		const flaky: Adapter = {
			stream: async function* (opts: StreamOptions) {
				calls += 1;
				seen.push({
					model: opts.model,
					messages: structuredClone(opts.messages),
					systemPrompt: opts.systemPrompt,
					tools: structuredClone(opts.tools),
				});
				if (calls === 1) {
					yield { seq: 0, type: "text_delta", text: "partial" } as never;
					throw CUT;
				}
				yield { seq: 0, type: "stop", reason: "end_turn" } as never;
			},
		};
		await collect(flaky, new ToolRegistry(), 2);
		expect(seen.length).toBe(2);
		expect(seen[1], "the marker voids exactly the suffix the original request never contained").toEqual(seen[0]);
	});
});

describe("F4 — receipts land before the marker (T2: draft with executions)", () => {
	it("settles a started precommit-safe read, then voids; the projection is pair-clean", async () => {
		let calls = 0;
		let executed = 0;
		const reader: Tool<Record<string, never>> = defineTool({
			name: "reader",
			description: "a precommit-safe read",
			parameters: { type: "object", properties: {} },
			effects: { precommitSafe: true, concurrency: "shared" },
			execute: async () => {
				executed += 1;
				return { content: "read result", isError: false };
			},
		});
		const writer: Tool<Record<string, never>> = defineTool({
			name: "writer",
			description: "a commit-required effect",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: "wrote", isError: false }),
		});
		const registry = new ToolRegistry();
		registry.register(reader);
		registry.register(writer);
		const flaky: Adapter = {
			stream: async function* () {
				calls += 1;
				if (calls === 1) {
					yield { seq: 0, type: "tool_call_end", callId: "r1", name: "reader", input: {} } as never;
					yield { seq: 0, type: "tool_call_end", callId: "w1", name: "writer", input: {} } as never;
					throw CUT;
				}
				yield { seq: 0, type: "text_delta", text: "done without tools" } as never;
				yield { seq: 0, type: "stop", reason: "end_turn" } as never;
			},
		};
		const events = await collect(flaky, registry, 2);
		expect(calls).toBe(2);
		expect(terminalOf(events).outcome).toEqual({ kind: "completed" });
		const markers = markersOf(events);
		expect(markers.length).toBe(1);
		// The read ran (precommit-safe + allowed), and its RECEIPT landed
		// durably BEFORE the marker — the settle precedes the void.
		expect(executed).toBe(1);
		const started = events.filter((e) => e.type === "tool_execution_started");
		const succeeded = events.filter((e) => e.type === "tool_execution_succeeded");
		expect(started.map((e) => (e as { callId: string }).callId)).toEqual(["r1"]);
		expect(succeeded.length).toBe(1);
		expect(succeeded[0]!.seq).toBeLessThan(markers[0]!.seq);
		// The parked commit-required call NEVER started: the turn did not
		// commit, so the writer bailed with no started event (invariant 3).
		expect(started.some((e) => (e as { name: string }).name === "writer")).toBe(false);
		// Pair atomicity: the voided declaration and its orphan receipt stay
		// in the audit but OUT of the provider projection.
		const messages = projectMessages(events);
		expect(messages.filter((m) => m.role === "tool")).toEqual([]);
		const assistantJson = JSON.stringify(messages.filter((m) => m.role === "assistant"));
		expect(assistantJson).not.toContain("tool_use");
	});
});

describe("F4 — exhaustion hygiene (T5: void before the error terminal)", () => {
	it("a spent budget still settles and voids the draft; nothing glues on the next request", async () => {
		let calls = 0;
		const alwaysCut: Adapter = {
			stream: async function* () {
				calls += 1;
				yield { seq: 0, type: "text_delta", text: `draft-${calls}` } as never;
				throw CUT;
			},
		};
		const events = await collect(alwaysCut, new ToolRegistry(), 1);
		expect(calls, "one retry under maxRetries=1, then exhaustion").toBe(2);
		const markers = markersOf(events);
		expect(markers.length, "EVERY abandoned attempt is voided — the exhausted one too").toBe(2);
		const terminal = terminalOf(events);
		expect(terminal.outcome.kind).toBe("error");
		// The marker precedes the terminal in yield order.
		const lastMarkerIdx = events.findIndex((e) => e.seq === markers[1]!.seq);
		const terminalIdx = events.findIndex((e) => e.type === "terminal");
		expect(lastMarkerIdx).toBeLessThan(terminalIdx);
		// The glue test: neither draft survives into the projection.
		const assistantText = JSON.stringify(projectMessages(events).filter((m) => m.role === "assistant"));
		expect(assistantText).not.toContain("draft-1");
		expect(assistantText).not.toContain("draft-2");
	});

	it("a non-retryable mid-stream error voids the draft before its terminal", async () => {
		const fatal: Adapter = {
			stream: async function* () {
				yield { seq: 0, type: "text_delta", text: "doomed draft" } as never;
				throw { code: "invalid_request", status: 400, retryable: false, message: "bad request" };
			},
		};
		const events = await collect(fatal, new ToolRegistry(), 2);
		expect(markersOf(events).length, "abandon hygiene is not retry-only").toBe(1);
		expect(terminalOf(events).outcome.kind).toBe("error");
		const assistantText = JSON.stringify(projectMessages(events).filter((m) => m.role === "assistant"));
		expect(assistantText).not.toContain("doomed");
	});
});
