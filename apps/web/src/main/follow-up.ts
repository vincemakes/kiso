/**
 * The follow-up the input box offers after a run (plan follow-up rev 2, owner 2026-11-03): what the Work's own model is
 * asked after the run's last reply, and how its answer becomes one line. The ask goes through Session.followUp, so the
 * request's prefix is the run's own and a caching route reads nearly all of it from the cache.
 */

export const FOLLOW_UP_ASK =
	"Write the one message the person is most likely to send you next, as they would type it, and nothing else. If the work is done and nothing naturally follows, answer with nothing.";

/** The model's answer as the box shows it: its first non-empty line, without quotes around it, at most 200 characters; "" for none. */
export function oneLine(text: string): string {
	const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
	const bare = first.replace(/^["'“‘`]+|["'”’`]+$/g, "").trim();
	return bare.length > 200 ? `${bare.slice(0, 199)}…` : bare;
}
