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
 * Producers are declared on tools (`delivers`, tools/tool.ts); the verdict
 * counts producer calls that completed (non-error results), against a
 * delivery claim in the text. The canonical lie — "generated-document" with zero
 * producer calls and a clean completed terminal — fails here.
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
