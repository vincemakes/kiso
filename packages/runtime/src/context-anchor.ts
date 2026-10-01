/**
 * 0.40.0 (the owner's session) — what the context holds, anchored on the
 * last BILLED request.
 *
 * The estimate alone read a Chinese-heavy context as ~470k while the
 * provider billed 732,448 input tokens on a 1M window: the ctx row said
 * "~53% left" and the microcompact trigger (window/2) never fired. The
 * provider's own count of the last request is the truth; only what the log
 * appended after it is estimated.
 *
 * The anchor is refused — the caller falls back to the estimate — when no
 * bill describes the context any more: no usage yet, a usage the provider
 * did not report (`known: false`), a usage at or before `floorSeq` (the
 * session switched models since, and a different tokenizer counts
 * differently), or one of the STALE_AFTER events after it, each of which
 * changes what the next request carries.
 */
import type { Event, Usage } from "@vincemakes/kiso-core";
import { estimateTokens } from "./estimate-tokens.js";

const STALE_AFTER: ReadonlySet<Event["type"]> = new Set<Event["type"]>([
	"compacted",
	"microcompacted",
	"summarized",
	"user_input_replaced",
	"model_output_abandoned",
]);

/**
 * `usageTotal` turns one usage event into the tokens that request put in
 * the context: its canonical prompt (fresh + cache read + cache write — the
 * raw `inputTokens` means different things per route) plus its output.
 * Returns undefined when the anchor is refused.
 */
export function contextAnchor(events: readonly Event[], usageTotal: (u: Usage) => number, floorSeq = -1): number | undefined {
	let appended = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!;
		if (e.type === "usage") return e.known && e.seq > floorSeq ? usageTotal(e) + appended : undefined;
		if (STALE_AFTER.has(e.type)) return undefined;
		if (e.type === "tool_result") appended += estimateTokens([{ role: "tool", callId: e.callId, content: e.content, isError: e.isError }]);
		else if (e.type === "user_input") appended += estimateTokens([{ role: "user", content: e.content }]);
	}
	return undefined;
}
