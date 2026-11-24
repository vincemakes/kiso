import { InFlightError } from "@vincemakes/kiso-server";
import { liveCard } from "../shared/decision.js";
import type { Space } from "./space.js";

/**
 * The decision card's click. The page sends only `{ invocationSeq, option }`: the card is derived again from the log, `choices[option]` of
 * the call at that seq is the line, and it is appended as the person's input marked `via: { kind: "choice", invocationSeq: card.invocationSeq, option }`. A label sent by
 * the page is never read, so the page cannot put words in the person's mouth. A card already overtaken (or a run begun in between)
 * is a 409 and nothing is sent.
 */
export async function answerDecision(space: Space, session: string, invocationSeq: unknown, option: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
	const card = liveCard(space.service.events(session));
	if (card === null || card.invocationSeq !== invocationSeq) return { status: 409, body: { error: "superseded" } };
	if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= card.choices.length) return { status: 400, body: { error: "no such choice" } };
	try {
		await space.service.run(session, card.choices[option]!, { via: { kind: "choice", invocationSeq: card.invocationSeq, option } });
	} catch (e) {
		if (e instanceof InFlightError) return { status: 409, body: { error: "superseded" } };
		throw e;
	}
	return { status: 200, body: {} };
}
