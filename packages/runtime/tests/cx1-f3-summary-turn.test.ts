/**
 * CX-1 F3 — a summary is accepted only from a COMPLETE text turn.
 *
 * The one-shot summary consumer collected text and usage and never
 * looked at the turn's shape: a `max_tokens` cut after the last
 * required heading, a turn with no stop at all, a turn that called a
 * tool — all passed the section check and were appended as
 * `summarized`, replacing history with a checkpoint that was not one
 * (audit F3). The invariant: exactly one stop, its reason `end_turn`,
 * zero tool-call events, no model output after the stop; `usage` after
 * the stop is the one permitted trailer. Any violation throws and
 * nothing is persisted (the E6 (b) contract).
 */

import { describe, expect, it } from "vitest";
import type { Adapter, AdapterEvent } from "@vincemakes/kiso-core";
import { summarizeConversation } from "../src/summarize.js";

const VALID = "## Goal\ng\n## Constraints\nc\n## User requests\nu\n## Files and changes\nf\n## Errors and fixes\ne\n## Current work\nw\n## Next steps\nn";

function scripted(events: AdapterEvent[], throwAtEnd?: Error): Adapter {
	return {
		stream: async function* () {
			for (const ev of events) yield ev;
			if (throwAtEnd !== undefined) throw throwAtEnd;
		},
	} as unknown as Adapter;
}

const call = (adapter: Adapter) => summarizeConversation({ adapter, model: "faux", messages: [{ role: "user", content: "history" }] });
const text = (t: string): AdapterEvent => ({ type: "text_delta", text: t, seq: 0 }) as unknown as AdapterEvent;
const stop = (reason: string): AdapterEvent => ({ type: "stop", reason, seq: 0 }) as unknown as AdapterEvent;
const usage = (): AdapterEvent => ({ type: "usage", known: true, inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, seq: 0 }) as unknown as AdapterEvent;

describe("CX-1 F3 — the summary turn must be complete", () => {
	it("a clean turn (text, one end_turn stop) is accepted", async () => {
		const r = await call(scripted([text(VALID), stop("end_turn")]));
		expect(r.text).toBe(VALID);
	});

	it("usage after the stop is the permitted trailer", async () => {
		const r = await call(scripted([text(VALID), stop("end_turn"), usage()]));
		expect(r.text).toBe(VALID);
		expect(r.usage?.inputTokens).toBe(10);
	});

	it("the audit's shape: max_tokens with every heading present → rejected", async () => {
		await expect(call(scripted([text(VALID), stop("max_tokens")]))).rejects.toThrow(/max_tokens|complete/);
	});

	it("the audit's shape: no stop at all → rejected", async () => {
		await expect(call(scripted([text(VALID)]))).rejects.toThrow(/stop|complete/);
	});

	it("the audit's shape: a tool call + tool_use stop → rejected", async () => {
		const ev = [text(VALID), { type: "tool_call_end", callId: "c1", name: "read_file", input: {}, seq: 0 } as unknown as AdapterEvent, stop("tool_use")];
		await expect(call(scripted(ev))).rejects.toThrow(/tool/);
	});

	it("a duplicate stop → rejected", async () => {
		await expect(call(scripted([text(VALID), stop("end_turn"), stop("end_turn")]))).rejects.toThrow(/stop/);
	});

	it("text after the stop → rejected", async () => {
		await expect(call(scripted([text(VALID), stop("end_turn"), text("more")]))).rejects.toThrow(/after/);
	});

	it("thinking after the stop → rejected", async () => {
		const ev = [text(VALID), stop("end_turn"), { type: "thinking", text: "hm", seq: 0 } as unknown as AdapterEvent];
		await expect(call(scripted(ev))).rejects.toThrow(/after/);
	});

	it("a stream error at the tail → rejected (propagates, nothing accepted)", async () => {
		await expect(call(scripted([text(VALID), stop("end_turn")], new Error("cut at the tail")))).rejects.toThrow("cut at the tail");
	});
});
