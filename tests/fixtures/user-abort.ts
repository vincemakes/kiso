/**
 * Fixture: USER ABORT — the user hits stop mid-run; the loop must land on an
 * honest `aborted` terminal, not a fake `completed`.
 *
 * Incident (uooki production, 2026): long artifact turns had a dead
 * interrupt window — a stop arriving before the executor registered its
 * steering channel returned 409 and the turn kept running to "completed".
 * The structural fix: the loop checks the signal at every phase boundary
 * and the terminal is honest about who ended the run.
 */

import type { AbortSignalLike } from "../../src/protocol/adapter";
import type { Fixture } from "./types";

/** A signal that flips to aborted after N events (test-controlled). */
export function makeAbortSignal(flipAfter: number): { signal: AbortSignalLike; flip: () => void } {
	let aborted = false;
	const listeners: Array<() => void> = [];
	return {
		signal: {
			get aborted() {
				return aborted;
			},
			addEventListener: (_type, listener) => {
				listeners.push(listener as () => void);
			},
			removeEventListener: () => {},
		},
		flip: () => {
			aborted = true;
			for (const l of listeners) l();
		},
	};
}

export const userAbort: Fixture = {
	name: "user-abort",
	incident:
		"uooki long artifact turn: stop during the pre-executor window returned 409, turn ran to 'completed' (2026-07-26)",
	script: [
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "working on it…" },
				{ type: "text_end" },
				{ type: "tool_call_end", callId: "c1", name: "create_artifact", input: {} },
			],
		},
		{ events: [{ type: "stop", reason: "end_turn" }] },
	],
	staticCheck: (events) => {
		// The shape: a long turn that CAN be interrupted mid-tool-call.
		if (!events.some((e) => e.type === "tool_call_end")) {
			return ["script lost the tool call that the user interrupts"];
		}
		return [];
	},
	requiredTerminal: ["aborted"], // with the signal flipped, the loop MUST land here
};
