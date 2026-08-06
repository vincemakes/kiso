/**
 * The ergonomics batch B4 (pure move) — the faux-mode glue: the durable script position
 * (fauxSkip), the script sources (env override + the built-in demo), and
 * the exhaustion guard. All bodies moved verbatim from index.ts.
 */

import { readFileSync } from "node:fs";
import { escapeTerminal } from "@vincemakes/kiso-tui";
import { SessionStore } from "@vincemakes/kiso-runtime";
import type { FauxScript } from "@vincemakes/kiso-evals";
import { sessionsDir, type LineInput } from "./state.js";

/**
 * E area: how many faux-script turns a session has already consumed. The faux
 * provider's script counter is per-process, so a FRESH process that resumes
 * a session would restart the script at turn 0 — re-issuing the first
 * scripted call instead of continuing the trajectory. The session log is
 * the durable position: a turn is consumed when it produced a tool_result
 * or an end_turn stop — AND when its tool call is unfinished (started but
 * no result): the recovery completes those turns WITHOUT a provider call
 * (executes the approved call, or fills the human verdict), so the model's
 * next response is the turn AFTER them.
 */
export function fauxSkip(id: string): number {
	const events = new SessionStore(sessionsDir())
		.load(id)
		.map((r) => r.event);
	const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => e.callId));
	return (
		events.filter((e) => e.type === "tool_result").length +
		events.filter((e) => e.type === "stop" && e.reason === "end_turn").length +
		events.filter((e) => e.type === "tool_call_end" && !results.has(e.callId)).length
	);
}

/**
 * E area: KISO_FAUX_SCRIPT=<path> overrides the demo script with a JSON
 * FauxScript file — the kill -9 e2e drives the CLI through an exact
 * multi-tool trajectory. Absent → the built-in demo script.
 */
export function readFauxScript(): FauxScript {
	const path = process.env.KISO_FAUX_SCRIPT;
	if (path === undefined) return fauxScript();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FauxScript;
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed;
	} catch (err) {
		console.error(`[KISO_FAUX_SCRIPT] cannot load ${path}: ${(err as Error).message}`);
		process.exit(1);
	}
}

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

/** round 10: a faux-mode run whose scripted turns are exhausted must NOT print a
 * provider error and exit 0 — the honest outcome is a loud message and a
 * non-zero exit. Thrown as a CONTROLLED exception (never process.exit):
 * the REPL closes, the error propagates through main's finally (so
 * agent.close() runs and no lock is left behind), and main's catch sets
 * the exit code. Only the exhaustion signature (the empty stream after
 * the declared turns) triggers the script-specific message; any other
 * error terminal still exits non-zero. */
export class FauxExhaustionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FauxExhaustionError";
	}
}

export function failOnFauxExhaustion(
	last: import("@vincemakes/kiso-core").Event | undefined,
	faux: boolean,
	input: LineInput | undefined,
): void {
	if (!faux) return;
	if (last?.type !== "terminal" || last.outcome.kind !== "error") return;
	const message = last.outcome.error.message;
	input?.close(); // the REPL must not stay open waiting for a line
	throw new FauxExhaustionError(
		message.startsWith("provider stream ended without a stop event")
			? "[faux mode] the scripted demo turns are exhausted — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model"
			: `[faux mode] the scripted model failed: ${escapeTerminal(message.slice(0, 200))}`,
	);
}
