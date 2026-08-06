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
 * trajectory must carry its errorKind and remain distinguishable from
 * success downstream — the harness can then decide (fail the turn, surface
 * the error, re-route). The kernel never lets an error result masquerade
 * as a clean one. The failing tool itself is scripted in the loop test
 * (a defineTool'd web_search returning errorKind "transient").
 */

import type { Fixture } from "./types.js";

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

				{ type: "stop", reason: "tool_use" }],
		},
		{
			events: [
				{ type: "text_delta", text: "The search finished successfully." },
				{ type: "text_end" },
				{ type: "stop", reason: "end_turn" },
			],
		},
	],
	staticCheck: (events) => {
		const violations: string[] = [];
		if (!events.some((e) => e.type === "tool_call_end" && e.name === "web_search")) {
			violations.push("script lost the failing tool call");
		}
		if (!events.some((e) => e.type === "text_delta" && /success|done/i.test(e.text))) {
			violations.push("script lost the success narration that swallows the error");
		}
		return violations;
	},
	requiredTerminal: ["completed"], // the loop completes; the error must stay VISIBLE in the trajectory
};
