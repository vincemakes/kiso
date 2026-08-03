/**
 * Fixture: PERMISSION NEGOTIATION — the same call shape can be denied once
 * and allowed later; the model must see both outcomes distinctly.
 *
 * Incident (mauri ADR-0002): a permission system that is a yes/no gate has
 * no memory and no upgrade path. CC's ask model allows deny-with-reason,
 * and the reason feeds back to the model so it can adjust. The kernel's
 * contract: each decision is a distinct tool_result — `precondition` for a
 * refusal (the tool never ran), a normal result for the allowed retry.
 */

import type { Fixture } from "./types.js";

export const permissionNegotiation: Fixture = {
	name: "permission-negotiation",
	incident:
		"uooki GatePipeline was a message-prefix interceptor with no session memory — a denied call could not be re-attempted after user approval (mauri ADR-0002 audit)",
	script: [
		{
			events: [
				{
					type: "tool_call_end",
					callId: "c1",
					name: "code_execute",
					input: { code: "1+1" },
				},

				{ type: "stop", reason: "tool_use" }],
		},
		{
			events: [
				{
					type: "tool_call_end",
					callId: "c2",
					name: "code_execute",
					input: { code: "1+1" },
				},

				{ type: "stop", reason: "tool_use" }],
		},
		{ events: [{ type: "stop", reason: "end_turn" }] },
	],
	staticCheck: (events) => {
		const calls = events.filter((e) => e.type === "tool_call_end" && e.name === "code_execute");
		if (calls.length < 2) {
			return ["script needs two calls of the same shape (deny then allow)"];
		}
		return [];
	},
	requiredTerminal: ["completed"],
};
