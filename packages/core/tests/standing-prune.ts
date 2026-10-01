/**
 * ADR-0055 Amendment 1 (A4): the kernel no longer owns a standing
 * microcompact trigger; it asks, before every request, through
 * LoopConfig.compact. These kernel gates still drive the SAME decision the
 * kernel used to make — the estimate over a threshold, the runtime's
 * boundary rule — through that one hook, so what they pin (the append,
 * the yield, the re-derive, the replay) is the kernel's part, unchanged.
 */
import type { Event, EventInput, Message } from "@vincemakes/kiso-core";
import { estimateTokens } from "@vincemakes/kiso-runtime";
import { microcompactBoundarySeq } from "@vincemakes/kiso-runtime/internal";

export function standingPrune(thresholdTokens: number, keepResults?: number) {
	return async (events: readonly Event[], messages: readonly Message[]): Promise<readonly EventInput[]> => {
		if (estimateTokens(messages) <= thresholdTokens) return [];
		const beforeSeq = microcompactBoundarySeq(events, keepResults);
		return beforeSeq === undefined ? [] : [{ type: "microcompacted", beforeSeq }];
	};
}
