/**
 * ADR-0064 A2 — the lease bootstrap in core: one event, only at seq 0, a
 * program-written user message at the head of the projection, and never
 * covered by a checkpoint (the A2 spec's invariants 1 and the placement).
 */
import { describe, expect, it } from "vitest";
import { isKisoEvent, projectMessages, resolveHistory, SUMMARY_FRAMING, type Event } from "../src/index.js";

const BOOT = "Work snapshot at revision 4, taken when this session started.";
const log = (events: unknown[]): Event[] => events as Event[];
const boot = { seq: 0, type: "context_bootstrap", meta: { leaseId: "L1" }, projection: BOOT };

describe("the context_bootstrap event", () => {
	it("is valid only at seq 0, with an object meta and a non-empty projection", () => {
		expect(isKisoEvent(boot)).toBe(true);
		expect(isKisoEvent({ ...boot, seq: 1 })).toBe(false);
		expect(isKisoEvent({ ...boot, meta: "L1" })).toBe(false);
		expect(isKisoEvent({ ...boot, meta: null })).toBe(false);
		expect(isKisoEvent({ ...boot, projection: "" })).toBe(false);
	});

	it("renders first, as a program-written user message, before the person's input", () => {
		const messages = projectMessages(log([boot, { seq: 1, type: "user_input", content: "go" }, { seq: 2, type: "text_delta", text: "ok" }, { seq: 3, type: "stop", reason: "end_turn" }]));
		expect(messages[0]).toEqual({ role: "user", content: BOOT, source: "system" });
		expect(messages[1]).toMatchObject({ role: "user", content: "go" });
	});

	it("is never covered: after a checkpoint the order is [bootstrap][summary][tail]", () => {
		const events = log([
			boot,
			{ seq: 1, type: "user_input", content: "first" },
			{ seq: 2, type: "text_delta", text: "one" },
			{ seq: 3, type: "stop", reason: "end_turn" },
			{ seq: 4, type: "user_input", content: "second" },
			{ seq: 5, type: "text_delta", text: "two" },
			{ seq: 6, type: "stop", reason: "end_turn" },
			{ seq: 7, type: "summarized", coversToSeq: 3, summary: "S" },
		]);
		expect(resolveHistory(events).status(events[0]!)).toBe("effective");
		expect(resolveHistory(events).status(events[1]!)).toBe("covered");
		const messages = projectMessages(events);
		expect(messages.map((m) => (m.role === "user" ? m.content : m.role))).toEqual([BOOT, `${SUMMARY_FRAMING}\n\nS`, "second", "assistant"]);
	});
});
