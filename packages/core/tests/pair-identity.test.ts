/**
 * Pair identity (the M0 prerequisite): a tool_result pairs with the
 * INVOCATION it was recorded for (`invocationSeq === call.seq`), never with
 * a provider callId alone — the kernel's own rule since CX-1 F1. A reused
 * callId whose second call was voided must not let that call's receipt
 * pair with the first call's surviving declaration.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import { projectMessages } from "../src/index.js";

const log = [
	{ seq: 0, type: "user_input", content: "go" },
	{ seq: 1, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 2, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a" } },
	{ seq: 3, type: "stop", reason: "tool_use" },
	{ seq: 4, type: "tool_result", callId: "c1", invocationSeq: 2, content: "A", isError: false },
	{ seq: 5, type: "tool_call_start", callId: "c1", name: "read_file" },
	{ seq: 6, type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "b" } },
	{ seq: 7, type: "model_output_abandoned", voidFromSeq: 4, reason: "resume" },
	{ seq: 8, type: "tool_result", callId: "c1", invocationSeq: 6, content: "B", isError: false },
] as unknown as Event[];

describe("pair identity by invocation", () => {
	it("a voided call's receipt never pairs with an earlier call that reused its callId", () => {
		const tools = projectMessages(log).filter((m) => m.role === "tool");
		expect(tools.map((m) => (m.role === "tool" ? m.content : null))).toEqual(["A"]);
	});

	it("an old log (no invocationSeq) replays as it always did: both results pair by callId", () => {
		// The replay-compatibility contract for old logs, pinned as a FIXED
		// expectation: a parity test elsewhere would stay green if the
		// projection and its reader drifted together.
		const old = log.map((e) => {
			if (e.type !== "tool_result") return e;
			const { invocationSeq: _drop, ...rest } = e as { invocationSeq?: number };
			return rest;
		}) as Event[];
		const tools = projectMessages(old).filter((m) => m.role === "tool");
		expect(tools.map((m) => (m.role === "tool" ? m.content : null))).toEqual(["A", "B"]);
	});
});
