/**
 * The keyless demo script, as plain data with no imports of its own: the terminal's first-run demo and any other host that shows the
 * same tour (the desktop app's first-run guide) read it from here.
 */
import type { FauxScript } from "@vincemakes/kiso-evals";

/**
 * The keyless demo script: tours the tools so `kiso chat` exercises them.
 * FOUR turns: each user turn consumes two model rounds (call → result →
 * summary), so at least two consecutive user turns work in one process
 * (F group).
 */
export function fauxScript(): FauxScript {
	return [
		{
			events: [
				// bootstrap P1: a multi-delta thinking block — renders as ONE
				// streaming segment, not one line per token.
				{ type: "thinking", text: "Let me think about" },
				{ type: "thinking", text: " the workspace" },
				{ type: "thinking", text: " before acting." },
				{ type: "text_start" },
				{ type: "text_delta", text: "I'm the faux model. Let me look at the working directory." },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "The faux model is still here, with full context." },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "And this is the end of the scripted tour." },
				{ type: "stop", reason: "end_turn" },
			],
		},
	];
}
