/**
 * Fixture: UNKNOWN TOOL — the model calls a tool that is not registered.
 *
 * Incident class (uooki + CC community): a tool name drifts (renamed,
 * ghost entry, typo'd enum) and the harness either silently drops the call
 * (agent loops forever trying to find the tool) or executes something
 * unexpected. The kernel's answer is structural: an unregistered tool is
 * refused with an `invalid_input` error result — the model sees the refusal,
 * the trajectory records it, nothing silently vanishes.
 */

import type { Fixture } from "./types.js";

export const unknownTool: Fixture = {
	name: "unknown-tool",
	incident:
		"uooki ghost-tool class: manifest listed a toolkit class name instead of the callable function name; activate_tools silently dropped it and the agent looped (2026-07)",
	script: [
		{
			events: [
				{
					type: "tool_call_end",
					callId: "c1",
					name: "text_to_speech_toolkit", // the ghost: a class name, not a function
					input: {},
				},

				{ type: "stop", reason: "tool_use" }],
		},
		{ events: [{ type: "stop", reason: "end_turn" }] },
	],
	staticCheck: (events) => {
		if (!events.some((e) => e.type === "tool_call_end" && e.name === "text_to_speech_toolkit")) {
			return ["script lost the ghost tool call"];
		}
		return [];
	},
	requiredTerminal: ["completed"], // the loop completes; the refusal must be in the trajectory
};
