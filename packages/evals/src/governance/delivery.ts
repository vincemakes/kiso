/**
 * Delivery truth — "done" means the ledger says so, not the model (uooki
 * done_guard, 30 incidents distilled).
 *
 * EC-1 (0.13.0): this module MOVED here from packages/core/src/governance/.
 * The extraction criterion the round adopted is not "who has zero external
 * callers" but "if this module left core, could the kernel still define its
 * own execution-correctness semantics?" — and for a trajectory verdict the
 * answer is plainly yes: delivery is an L7 EVAL concern, computed after the
 * fact from events the loop already yielded. It had no consumer inside
 * packages/core/src at all; its only real caller has always been the
 * terminal-lies fixture next door. The kernel's own line budget (2,000 —
 * the README's loudest promise) paid for the EC-1 scheduler by giving this
 * module the home it always belonged in. Behavior is UNCHANGED: same
 * verdict, same fields, byte for byte (the zero-behavior proof is
 * packages/core/tests/m3.test.ts, which still exercises it).
 *
 * The kernel's terminal is honest but shallow: `completed` means "the loop
 * ended on its own terms". Whether the turn DELIVERED what was asked is a
 * harness-side verdict over the trajectory — this module computes it from
 * the same events the loop yielded, so the verdict is replayable and the
 * model's narration never participates in its own grading.
 *
 * Producers are named by the CALLER, in `DeliveryConfig.producers` — the
 * hand-maintained set is the ONLY source of delivery truth. SC-1b removed
 * `Tool.delivers`, the flag this note used to describe as the eventual
 * replacement: it was declared on the contract and read by nothing, here
 * or anywhere. Should a tool's own declaration ever supersede the caller's
 * set, it enters as a new field with a wiring and a gate, never as a
 * standing promise the code has not kept.
 *
 * The verdict counts producer calls that COMPLETED (non-error results).
 * `claimedInText` is computed and REPORTED but does not enter `passed` —
 * a caller that wants "claimed but not delivered" to fail combines the two
 * itself (the evals fixture does). With `required: false`, text claiming
 * delivery over zero producer calls passes here. The canonical lie —
 * "generated-document" with zero producer calls and a clean completed
 * terminal — is caught by that combination.
 *
 * In M3.5 the emission side (artifact URLs extracted from results) joins;
 * today a completed producer IS the emission.
 */

import type { Event } from "@vincemakes/kiso-core";

export interface DeliveryConfig {
	/** Whether this turn was required to deliver at all. */
	readonly required: boolean;
	/** Tool names that produce a deliverable. */
	readonly producers: ReadonlySet<string>;
}

export interface DeliveryVerdict {
	readonly passed: boolean;
	/** Producer calls the model actually made. */
	readonly producerCalls: readonly string[];
	/** Producer calls that completed (non-error result). */
	readonly completedProducers: readonly string[];
	/** The text claimed delivery (a claim is a lie only when unbacked). */
	readonly claimedInText: boolean;
}

const CLAIM_PATTERN = /created|completed|delivered|done/i;

export function analyzeDelivery(events: readonly Event[], config: DeliveryConfig): DeliveryVerdict {
	const producerCalls: string[] = [];
	const completedProducers: string[] = [];
	let claimedInText = false;

	for (const ev of events) {
		switch (ev.type) {
			case "text_delta":
				if (CLAIM_PATTERN.test(ev.text)) claimedInText = true;
				break;
			case "tool_call_end":
				if (config.producers.has(ev.name)) producerCalls.push(ev.callId);
				break;
			case "tool_result":
				if (producerCalls.includes(ev.callId) && !ev.isError) {
					completedProducers.push(ev.callId);
				}
				break;
		}
	}

	return {
		passed: !config.required || completedProducers.length > 0,
		producerCalls,
		completedProducers,
		claimedInText,
	};
}
