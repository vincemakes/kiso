/**
 * ADR-0064 § 6 / ADR-0063 § 5.2 — the provenance check: does a candidate quote
 * appear, mechanically, in the text a person wrote at one seq of one log?
 *
 * NEUTRAL: neither memory nor work owns it; both import it. A pure validator
 * over (events, { owner, seq, span }): it reads nothing but its arguments,
 * decides nothing about what a caller does with a failure, and returns the
 * EXACT source bytes of the located span, never the candidate's rendering.
 *
 * The match is light canonical (ADR-0063 § 5.2 step 3): runs of whitespace
 * compare as one space, and full-width forms compare as their half-width
 * ASCII. No punctuation folding: code, `!`, `-` and paths change meaning.
 */
import { resolveHistory, type Event } from "@vincemakes/kiso-core";
import { humanAuthoredSurface } from "./effective-history.js";

export type EvidenceOwner = `session/${string}` | `work/${string}`;
export type EvidenceRef = { readonly owner: EvidenceOwner; readonly seq: number };
export type Quote = EvidenceRef & { readonly span: string };

/** One canonical character and the source range it came from. */
type Mapped = { readonly text: string; readonly starts: number[]; readonly ends: number[] };

function canonical(source: string): Mapped {
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let i = 0;
	while (i < source.length) {
		const cp = source.codePointAt(i)!;
		const width = cp > 0xffff ? 2 : 1;
		if (/\s/u.test(String.fromCodePoint(cp))) {
			let j = i + width;
			while (j < source.length && /\s/u.test(String.fromCodePoint(source.codePointAt(j)!))) j += source.codePointAt(j)! > 0xffff ? 2 : 1;
			text += " ";
			starts.push(i);
			ends.push(j);
			i = j;
			continue;
		}
		const folded = cp >= 0xff01 && cp <= 0xff5e ? String.fromCodePoint(cp - 0xfee0) : String.fromCodePoint(cp);
		for (let k = 0; k < folded.length; k++) {
			starts.push(i);
			ends.push(i + width);
		}
		text += folded;
		i += width;
	}
	return { text, starts, ends };
}

/**
 * Locate `quote.span` (the candidate) in the human-authored surface of the
 * event at `quote.seq`. Returns the quote with `span` replaced by the exact
 * source bytes, or null when the seq carries no human-authored surface
 * (tasks, peer, a vetoed input, model output) or the candidate is not in it.
 * The caller has already chosen `events` as the log `quote.owner` names.
 */
export function locateQuote(events: readonly Event[], quote: Quote): Quote | null {
	const needle = canonical(quote.span.trim()).text;
	if (needle === "") return null;
	const ev = events.find((e) => e.seq === quote.seq);
	if (ev === undefined) return null;
	const surface = humanAuthoredSurface(ev, resolveHistory(events));
	if (surface === null) return null;
	const hay = canonical(surface);
	const at = hay.text.indexOf(needle);
	if (at === -1) return null;
	return { owner: quote.owner, seq: quote.seq, span: surface.slice(hay.starts[at]!, hay.ends[at + needle.length - 1]!) };
}
