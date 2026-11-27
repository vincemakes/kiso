/**
 * ADR-0064 § 4 — a user criterion's quote must trace mechanically to text a
 * person wrote (ADR-0063 § 5.2), through the runtime's neutral provenance
 * check. The reducer cannot re-run it (it has only the work log);
 * `auditAcceptance` can, given the sessions.
 */
import type { Event } from "@vincemakes/kiso-core";
import { locateQuote } from "@vincemakes/kiso-runtime/evidence";
import type { EvidenceOwner, WorkQuote } from "./events.js";
import type { Commitment } from "./reducer.js";

/** The located quote with the exact source bytes, or null when the check fails. */
export function verifyUserQuote(events: readonly Event[], candidate: WorkQuote): WorkQuote | null {
	return locateQuote(events, candidate);
}

/** Every user criterion whose stored span is not, byte for byte, what the check locates now. */
export function auditAcceptance(commitment: Commitment, load: (owner: EvidenceOwner) => readonly Event[]): string[] {
	return commitment.acceptance
		.filter((c) => c.authority === "user")
		.filter((c) => c.quote === undefined || locateQuote(load(c.quote.owner), c.quote)?.span !== c.quote.span)
		.map((c) => c.criterionId);
}
