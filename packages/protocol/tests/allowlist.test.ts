/**
 * The wire's classification is TOTAL over the durable union: every one of
 * the runtime's 28 event types is either on the wire (with an allowlist
 * row) or named off it. A new durable variant cannot reach a client by
 * default and cannot be forgotten either — this test goes red until it is
 * classified. The 28 names are pinned here as data on purpose: this
 * package imports nothing from the runtime.
 */

import { describe, expect, it } from "vitest";
import { DURABLE_TO_WIRE, NOT_ON_WIRE, PROTOCOL_VERSION, WIRE_FIELDS } from "../src/index.js";

const DURABLE_TYPES = [
	"assistant_end",
	"assistant_start",
	"compacted",
	"context_records",
	"microcompacted",
	"model_output_abandoned",
	"permission_decided",
	"permission_expired",
	"permission_requested",
	"stop",
	"summarized",
	"terminal",
	"text_delta",
	"text_end",
	"text_start",
	"thinking",
	"tool_call_end",
	"tool_call_input_delta",
	"tool_call_start",
	"tool_execution_failed",
	"tool_execution_resolved",
	"tool_execution_started",
	"tool_execution_succeeded",
	"tool_result",
	"uncertain_pending",
	"usage",
	"user_input",
	"user_input_replaced",
] as const;

describe("the wire classification is total", () => {
	it("on-wire ∪ off-wire = the 28 durable types, disjoint", () => {
		const on = Object.keys(DURABLE_TO_WIRE).sort();
		const off = [...NOT_ON_WIRE].sort();
		expect(DURABLE_TYPES).toHaveLength(28);
		expect([...on, ...off].sort()).toEqual([...DURABLE_TYPES]);
		expect(on.filter((t) => off.includes(t as never))).toEqual([]);
	});

	it("every wire type has an allowlist row, and no row names a type that is not on the wire", () => {
		const wireTypes = new Set(Object.values(DURABLE_TO_WIRE));
		for (const t of wireTypes) expect(WIRE_FIELDS, `row for ${t}`).toHaveProperty(t);
		for (const t of Object.keys(WIRE_FIELDS)) expect(wireTypes.has(t as never), `${t} is on the wire`).toBe(true);
	});

	it("seq and type are never in an allowlist (they are implicit on every event)", () => {
		for (const [t, fields] of Object.entries(WIRE_FIELDS)) {
			expect(fields, t).not.toContain("seq");
			expect(fields, t).not.toContain("type");
		}
	});

	it("the version is 1", () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});
});
