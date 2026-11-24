import type { Event } from "@vincemakes/kiso-core";

/**
 * The decision card (plan-decision-card-2026-11-24): what `finish_with_choices` left in front of the person. A pure function of the
 * log, so the page, the route that answers it and a cold open all agree: the card is live iff a successful result of the call, tagged
 * with core's END_TURN, ended the run (`completed`) and nothing came after it: no input of any kind, no further model request.
 */
export interface DecisionCard {
	/** the identity of the call: the seq of its tool_call_end (a callId is correlation only and may repeat across runs) */
	readonly invocationSeq: number;
	readonly choices: readonly string[];
	/** false: the first choice is not a recommendation (the choice is the person's alone) */
	readonly recommended: boolean;
}

export const FINISH_TOOL = "finish_with_choices";

export function liveCard(events: readonly Event[]): DecisionCard | null {
	let at = -1;
	for (let i = events.length - 1; i >= 0 && at < 0; i -= 1) {
		const e = events[i]!;
		if (e.type === "tool_result" && !e.isError && (e.tags ?? []).includes("end-turn")) at = i;
		else if (e.type === "user_input" || e.type === "stop" || e.type === "tool_call_end") return null; // overtaken: an input, or the model asked again
	}
	if (at < 0 || !events.slice(at).some((e) => e.type === "terminal" && e.outcome.kind === "completed")) return null;
	const invocationSeq = (events[at] as { readonly invocationSeq?: number }).invocationSeq;
	const call = events.find((e) => e.seq === invocationSeq && e.type === "tool_call_end" && e.name === FINISH_TOOL);
	const input = call?.type === "tool_call_end" ? (call.input as { choices?: unknown; recommended?: unknown } | null) : null;
	const choices = input?.choices;
	if (invocationSeq === undefined || !Array.isArray(choices) || choices.length < 2 || choices.length > 3 || !choices.every((c) => typeof c === "string" && c !== "")) return null;
	return { invocationSeq, choices: choices as string[], recommended: input?.recommended !== false };
}
