/**
 * R4 — the projection is total and cannot leak.
 *
 * Every durable type is fed through toWireEvent with every field it has
 * populated; what comes out is exactly the protocol's allowlist and never
 * a field beyond it. The sanitizer is pinned on the cases the hosting
 * product wrote it for: prose keys stripped, long values cut, thinking off
 * unless asked.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "@vincemakes/kiso-core";
import { DURABLE_TO_WIRE, NOT_ON_WIRE, WIRE_FIELDS } from "@vincemakes/kiso-protocol";
import { MAX_ARG_DEPTH, MAX_ARG_VALUE_CHARS, sanitizeToolArgs, toWireEvent } from "../src/wire.js";

/** One populated sample per durable type — every field the type declares,
 *  so an allowlist row that names a field the type does not carry, or a
 *  projection that lets an extra one through, both show here. */
const SAMPLES: readonly Event[] = [
	{ seq: 1, type: "user_input", content: "hi", source: "user" },
	{ seq: 2, type: "user_input_replaced", replaces: 1, content: "hello", source: "user" },
	{ seq: 3, type: "assistant_start" },
	{ seq: 4, type: "text_start" },
	{ seq: 5, type: "text_delta", text: "a" },
	{ seq: 6, type: "text_end" },
	{ seq: 7, type: "thinking", text: "hmm" },
	{ seq: 8, type: "tool_call_start", callId: "c", name: "t", source: "user" },
	{ seq: 9, type: "tool_call_input_delta", callId: "c", delta: "{" } as unknown as Event,
	{ seq: 10, type: "tool_call_end", callId: "c", name: "t", input: { path: "x", prompt: "secret", note: "n".repeat(300) } },
	{ seq: 11, type: "tool_result", callId: "c", content: "the whole result body", isError: false, errorKind: "transient", executionId: "e", source: "tool_result", tags: ["t"] },
	{ seq: 12, type: "tool_execution_started", executionId: "e", callId: "c", name: "t", input: { prompt: "secret" } },
	{ seq: 13, type: "tool_execution_succeeded", executionId: "e", callId: "c", result: { content: "body", isError: false } } as unknown as Event,
	{ seq: 14, type: "tool_execution_failed", executionId: "e", callId: "c", error: "boom", errorKind: "fatal", safeToRetry: false, tags: [] },
	{ seq: 15, type: "tool_execution_resolved", executionId: "e", callId: "c", resolution: "rerun" },
	{ seq: 16, type: "permission_requested", decisionId: "d", callId: "c", name: "deploy", input: { env: "prod", prompt: "secret" }, speaker: "s" },
	{ seq: 17, type: "permission_decided", decisionId: "d", callId: "c", decision: "approved" },
	{ seq: 18, type: "permission_expired", decisionId: "d", reason: "run ended" },
	{ seq: 19, type: "uncertain_pending", executionId: "e", callId: "c", name: "t", error: "crashed" },
	{ seq: 20, type: "model_output_abandoned", voidFromSeq: 5, reason: "resume" },
	{ seq: 21, type: "summarized", coversToSeq: 10, summary: "so far" } as unknown as Event,
	{ seq: 22, type: "compacted" } as unknown as Event,
	{ seq: 23, type: "microcompacted" } as unknown as Event,
	{ seq: 24, type: "usage", known: true, input: 1, output: 1 } as unknown as Event,
	{ seq: 25, type: "stop", reason: "end_turn" } as unknown as Event,
	{ seq: 26, type: "assistant_end" },
	{ seq: 27, type: "terminal", outcome: { kind: "completed" } },
];

describe("R4: the projection", () => {
	it("covers every durable type once", () => {
		const types = SAMPLES.map((e) => e.type).sort();
		expect(new Set(types).size).toBe(27);
		expect(types).toEqual([...Object.keys(DURABLE_TO_WIRE), ...NOT_ON_WIRE].sort());
	});

	it("emits exactly the allowlisted fields and nothing beyond them; off-wire types yield null", () => {
		for (const event of SAMPLES) {
			const wire = toWireEvent(event, { exposeThinking: true });
			const wireType = (DURABLE_TO_WIRE as Record<string, string | undefined>)[event.type];
			if (wireType === undefined) {
				expect(wire, event.type).toBeNull();
				continue;
			}
			expect(wire, event.type).not.toBeNull();
			expect(wire!.type).toBe(wireType);
			expect(wire!.seq).toBe(event.seq);
			const emitted = Object.keys(wire!).filter((k) => k !== "seq" && k !== "type").sort();
			const allowed = [...WIRE_FIELDS[wireType as keyof typeof WIRE_FIELDS]].sort();
			for (const k of emitted) expect(allowed, `${event.type}.${k}`).toContain(k);
			// every allowlisted field the sample carries is present
			for (const k of allowed) if (k in event) expect(wire, `${event.type}.${k}`).toHaveProperty(k);
		}
	});

	it("never carries a tool result's content, a receipt's result, or a request's speaker", () => {
		const result = toWireEvent(SAMPLES[10]!)!;
		expect(result).not.toHaveProperty("content");
		expect(result).not.toHaveProperty("tags");
		expect(toWireEvent(SAMPLES[12]!)!).not.toHaveProperty("result");
		expect(toWireEvent(SAMPLES[15]!)!).not.toHaveProperty("speaker");
	});

	it("ADR-0062: a user_input carries its via, so a page knows a message from another session", () => {
		const via = { kind: "peer", event: "message", from: "k/2026-11-16T10-00-00-a1b2", messageId: "m1", rootId: "r1" };
		expect(toWireEvent({ seq: 3, type: "user_input", content: "hello", source: "system", via } as never)).toEqual({ seq: 3, type: "user_input", content: "hello", source: "system", via });
	});

	it("thinking is off the wire unless asked", () => {
		expect(toWireEvent(SAMPLES[6]!)).toBeNull();
		expect(toWireEvent(SAMPLES[6]!, { exposeThinking: true })).toMatchObject({ type: "thinking", text: "hmm" });
	});

	it("sanitizes tool arguments on tool_call_end and permission_requested: prose keys stripped, long values cut", () => {
		const call = toWireEvent(SAMPLES[9]!) as { input: Record<string, unknown> };
		expect(call.input).not.toHaveProperty("prompt");
		expect(call.input.path).toBe("x");
		expect((call.input.note as string).length).toBe(MAX_ARG_VALUE_CHARS + 1); // the prefix plus the ellipsis
		const ask = toWireEvent(SAMPLES[15]!) as { input: Record<string, unknown> };
		expect(ask.input).toEqual({ env: "prod" });
	});

	it("the rename: model_output_abandoned is draft_voided on the wire, carrying voidFromSeq", () => {
		expect(toWireEvent(SAMPLES[19]!)).toEqual({ seq: 20, type: "draft_voided", voidFromSeq: 5, reason: "resume" });
	});

	it("a product-supplied sanitizer replaces the default", () => {
		const wire = toWireEvent(SAMPLES[9]!, { sanitize: () => ({ redacted: true }) }) as { input: unknown };
		expect(wire.input).toEqual({ redacted: true });
	});

	it("the sanitizer walks nested objects and arrays: prose keys stripped and long strings cut at every depth, nesting capped", () => {
		const out = sanitizeToolArgs({
			options: { prompt: "secret", note: "n".repeat(300), inner: { body: "secret", keep: 1 } },
			list: [{ text: "secret", keep: 2 }, "s".repeat(300), 3],
		}) as Record<string, unknown>;
		expect(out).toEqual({
			options: { note: `${"n".repeat(MAX_ARG_VALUE_CHARS)}…`, inner: { keep: 1 } },
			list: [{ keep: 2 }, `${"s".repeat(MAX_ARG_VALUE_CHARS)}…`, 3],
		});
		let deep: unknown = { leaf: 1 };
		for (let i = 0; i < MAX_ARG_DEPTH + 2; i++) deep = { d: deep };
		expect(JSON.stringify(sanitizeToolArgs(deep))).toContain('"{…}"');
	});

	it("the default sanitizer leaves non-objects alone", () => {
		expect(sanitizeToolArgs(null)).toBeNull();
		expect(sanitizeToolArgs([1])).toEqual([1]);
		expect(sanitizeToolArgs("s")).toBe("s");
	});
});
