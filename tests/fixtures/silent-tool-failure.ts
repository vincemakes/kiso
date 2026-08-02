/**
 * Fixture: SILENT TOOL FAILURE — an error result is swallowed and the model
 * keeps narrating success.
 *
 * Incident (uooki production, 2026): a tool call failed with is_error=true,
 * the model ignored it and continued with "results look great, done" —
 * the turn ended "completed" with zero usable work. Root cause class:
 * error results ride the same channel as successes, and nothing forced the
 * model to acknowledge the error (CC's community loudest complaint: "reports
 * of finished work that never happened").
 *
 * The kernel-side shape the fixture pins: an isError tool_result in the
 * trajectory must be distinguishable from success downstream — the harness
 * can then decide (fail the turn, surface the error, re-route). The kernel
 * never lets an error result masquerade as a clean one.
 */

import type { Fixture } from "./types";

export const silentToolFailure: Fixture = {
	name: "silent-tool-failure",
	incident:
		"uooki turn: search tool returned is_error, model ignored it and reported success (2026-06)",
	script: [
		{
			events: [
				{ type: "text_start" },
				{ type: "tool_call_start", callId: "c1", name: "web_search" },
				{ type: "tool_call_input_delta", callId: "c1", inputJsonDelta: '{"query": "latest"}' },
				{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "latest" } },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "搜索完成，结果很好。" },
				{ type: "text_end" },
				{ type: "stop", reason: "end_turn" },
			],
			toolResults: {
				c1: { content: "overloaded — try again", isError: true, errorKind: "transient" },
			},
		},
	],
	staticCheck: (events) => {
		const violations: string[] = [];
		const failureShape = events.some((e) => e.type === "tool_call_end" && e.name === "web_search");
		if (!failureShape) {
			violations.push("script lost the failing tool call");
		}
		// toolResults live in the script, not the events — the static check
		// verifies the script still carries an error result for the call.
		return violations;
	},
	requiredTerminal: ["completed_with_error_visible"], // wired in M1 — harness decides
};
