/**
 * ADR-0063 M0 — `resolveHistory`, the projection's structural resolution
 * shared with the runtime's effective history. These pin its contract: pure
 * over the complete ordered log; the same ordered log always yields the
 * same resolution.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "../src/protocol/events.js";
import type { EventInput } from "../src/index.js";
import { resolveHistory } from "../src/index.js";

const log = (events: unknown[]): Event[] => events as Event[];

describe("resolveHistory", () => {
	it("the FINAL replacement for an input wins; null is a veto", () => {
		const r = resolveHistory(
			log([
				{ seq: 0, type: "user_input", content: "a" },
				{ seq: 1, type: "user_input_replaced", replaces: 0, content: "b" },
				{ seq: 2, type: "user_input_replaced", replaces: 0, content: "c", source: "user" },
				{ seq: 3, type: "user_input", content: "x" },
				{ seq: 4, type: "user_input_replaced", replaces: 3, content: null },
			]),
		);
		expect(r.replaced.get(0)).toEqual({ content: "c", source: "user" });
		expect(r.replaced.get(3)).toEqual({ content: null });
	});

	it("the live checkpoint is the greatest coversToSeq, the later one on a tie, with its own seq", () => {
		const r = resolveHistory(
			log([
				{ seq: 0, type: "user_input", content: "a" },
				{ seq: 5, type: "summarized", coversToSeq: 3, summary: "s1" },
				{ seq: 6, type: "summarized", coversToSeq: 4, summary: "s2" },
				{ seq: 7, type: "summarized", coversToSeq: 4, summary: "s3" },
				{ seq: 8, type: "summarized", coversToSeq: 2, summary: "s4" },
			]),
		);
		expect(r.summary).toEqual({ eventSeq: 7, to: 4, summary: "s3" });
	});

	it("covers (−1, to]; seed events and summarized events are never covered", () => {
		const seed = { type: "user_input", content: "seed" } as unknown as EventInput;
		const inside = { seq: 2, type: "text_delta", text: "t" } as unknown as Event;
		const after = { seq: 4, type: "user_input", content: "u" } as unknown as Event;
		const summary = { seq: 9, type: "summarized", coversToSeq: 3, summary: "s" } as unknown as Event;
		const r = resolveHistory([seed, inside, after, summary]);
		expect(r.status(seed)).toBe("effective");
		expect(r.status(inside)).toBe("covered");
		expect(r.status(after)).toBe("effective");
		expect(r.status(summary)).toBe("effective");
	});

	it("voids model output only, and voided wins over covered", () => {
		const draft = { seq: 1, type: "text_delta", text: "draft" } as unknown as Event;
		const result = { seq: 2, type: "tool_result", callId: "c", content: "r", isError: false } as unknown as Event;
		const events = log([
			{ seq: 0, type: "user_input", content: "a" },
			draft,
			result,
			{ seq: 3, type: "model_output_abandoned", voidFromSeq: 0, reason: "resume" },
			{ seq: 4, type: "user_input", content: "b" },
			{ seq: 9, type: "summarized", coversToSeq: 4, summary: "s" },
		]);
		const r = resolveHistory(events);
		expect(r.status(draft)).toBe("voided");
		expect(r.status(result)).toBe("covered");
	});

	it("the same ordered log always yields the same resolution", () => {
		const events = log([
			{ seq: 0, type: "user_input", content: "a" },
			{ seq: 1, type: "user_input_replaced", replaces: 0, content: "b" },
			{ seq: 2, type: "summarized", coversToSeq: 0, summary: "s" },
		]);
		const a = resolveHistory(events);
		const b = resolveHistory(events);
		expect([...a.replaced]).toEqual([...b.replaced]);
		expect(a.summary).toEqual(b.summary);
		expect(events.map(a.status)).toEqual(events.map(b.status));
	});
});
