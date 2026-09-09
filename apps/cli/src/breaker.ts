/**
 * LT-2 — the loop breaker (kiso-doc/kiso-lt1-mini-spec-2026-09-09.md, part
 * one, corrected by the chain law — see below).
 *
 * An agent that keeps issuing the SAME failing call — same tool, same
 * input, failure after failure — is not making progress, and since R3e
 * removed the silent turn limit nothing stopped it. This extension does,
 * in the one place the product already decides tool calls: the approval
 * chain. It rides the chain like the five mode tiers do (a `decide()` that
 * speaks or abstains), placed at the HEAD so that when it speaks, the
 * verdict's `decidedBy` names it.
 *
 * THE VERDICT IS A DENY WITH A REASON, NOT AN ASK. The spec asked for a
 * human question; the chain composes deny > allow > ask over the speaking
 * verdicts, so an `ask` from here would lose to the tier's `allow` (a read
 * under `default`, anything under `bypass`) and the loop would go on. A
 * deny wins over every tier — the same law that lets a user extension's
 * deny beat `bypass` — and the model receives it as the call's result with
 * the reason (the 1c grammar: refuse with a reason and continue), so the
 * next turn has to change course. The human sees the denial on the
 * transcript with `decidedBy: breaker`; the 50-turn checkpoint (part two)
 * is where a human is asked.
 *
 * Counting: CONSECUTIVE failed results of one (tool, input) key within a
 * run. A success, a different call, or the run's terminal resets it. The
 * third identical attempt is denied. N = 3 is named below; dogfood moves it
 * with a finding, never silently.
 */

import type { Event, KisoExtension, PolicyVerdict } from "@vincemakes/kiso-core";

/** The third identical failed attempt is the one refused. */
export const BREAKER_LIMIT = 3;

/** The name the verdict wears (`decidedBy`). */
export const BREAKER_NAME = "breaker";

/** A stable key for (tool, input): object keys sorted at every depth, so
 *  two calls that mean the same thing key the same whatever order the
 *  model wrote the fields in. */
export function callKey(name: string, input: unknown): string {
	return `${name}\0${stable(input)}`;
}

function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v) ?? "undefined";
}

/** The per-run state, kept small: the last failed key and how many times
 *  in a row it failed. `calls` maps a callId to its key while a call is in
 *  flight (the failure arrives on the result event, keyed by callId). */
export interface BreakerState {
	lastKey: string | null;
	failures: number;
	readonly calls: Map<string, string>;
}

export function breakerState(): BreakerState {
	return { lastKey: null, failures: 0, calls: new Map() };
}

/** What the log says, applied to the state. Exported so the rule is testable
 *  as a pure function of the event sequence. */
export function observe(state: BreakerState, event: Event): void {
	switch (event.type) {
		case "tool_call_end":
			state.calls.set(event.callId, callKey(event.name, event.input));
			return;
		case "tool_result": {
			const key = state.calls.get(event.callId);
			state.calls.delete(event.callId);
			if (key === undefined) return;
			if (!event.isError) {
				state.lastKey = null;
				state.failures = 0;
				return;
			}
			if (state.lastKey === key) state.failures += 1;
			else {
				state.lastKey = key;
				state.failures = 1;
			}
			return;
		}
		case "terminal":
			// a run's end is a clean slate: the next run starts at zero
			state.lastKey = null;
			state.failures = 0;
			state.calls.clear();
			return;
		default:
			return;
	}
}

/** The verdict for a call about to be decided: the (limit − 1)th consecutive
 *  failure of this exact key has already happened, so this attempt would be
 *  the limit-th — refused, with the count in the reason. */
export function verdict(state: BreakerState, name: string, input: unknown, limit = BREAKER_LIMIT): PolicyVerdict {
	if (state.lastKey !== null && state.lastKey === callKey(name, input) && state.failures >= limit - 1) {
		return {
			action: "deny",
			reason: `${BREAKER_NAME}: the same ${name} call failed ${state.failures} times in a row — change the input or the approach; the identical call is not tried again`,
		};
	}
	return { action: "abstain" };
}

/** The extension: one state per process (a session runs one run at a time,
 *  and the terminal resets it), the log observed through the hook, the
 *  verdict through the chain. */
export function breakerExtension(limit = BREAKER_LIMIT): KisoExtension {
	const state = breakerState();
	return {
		name: BREAKER_NAME,
		hooks: {
			async onEvent(event) {
				observe(state, event);
			},
		},
		approvals: [
			{
				decide: async (payload) => verdict(state, payload.name, payload.input, limit),
			},
		],
	};
}
