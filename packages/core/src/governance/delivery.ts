/**
 * Delivery truth — "done" means the ledger says so, not the model (uooki
 * done_guard, 30 incidents distilled).
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

import type { Event } from "../protocol/events.js";

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
