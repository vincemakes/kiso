/**
 * When a search does not match, say WHERE it stopped matching.
 *
 * `edit_file: pattern not found in src/report.js (hunk 2)` is true and
 * useless. The tool has already established, by failing, that the text is
 * not there — but it also knows, or can cheaply find out, how much of the
 * search DID match and what the file has instead. Withholding that leaves
 * one recourse: read the whole file again.
 *
 * This is not a guess about what callers need. Ten refused edits in one
 * measured session were all `pattern not found`, none stale, none
 * overlapping, and in every one of them a long prefix matched before the
 * search ran into text the caller had not written yet — 93 of 223
 * characters, 94 of 286, 306 of 913. Four more searched for an import
 * line with the new symbol ALREADY IN IT. The failure has one shape: the
 * search describes the file as it will be, not as it is. A message that
 * names the divergence answers that in one line; the current one costs a
 * whole file read to discover.
 */

/** The longest prefix of `needle` that occurs in `hay`, by length.
 *
 *  Monotone — if a prefix occurs then so does every shorter one — so this
 *  binary-searches instead of walking. A linear walk is O(m) substring
 *  searches, which on a large file and a long search is the kind of cost
 *  that turns a better error message into a worse tool.
 */
function longestMatchingPrefix(hay: string, needle: string): number {
	let lo = 0;
	let hi = needle.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (hay.includes(needle.slice(0, mid))) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** 1-based line number of an offset. */
function lineAt(text: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
	return n;
}

/** A fragment for a one-line message: escaped, and bounded. */
function fragment(s: string, max = 60): string {
	const cut = s.slice(0, max);
	const shown = JSON.stringify(cut).slice(1, -1); // drop the quotes, keep \n and \t visible
	return s.length > max ? `${shown}…` : shown;
}

/**
 * The detail lines for a failed search, or "" when there is nothing useful
 * to say. The caller owns the headline; this is what follows it.
 */
export function describeSearchMiss(text: string, search: string): string {
	if (search.length === 0) return "";
	const matched = longestMatchingPrefix(text, search);
	if (matched === 0) {
		const firstLine = search.split("\n", 1)[0] ?? "";
		return `  no part of it appears in the file — it begins "${fragment(firstLine)}"`;
	}
	// The FIRST place the prefix appears. Since ACI-2 the tool no longer
	// has first-occurrence semantics to match, so the reason is now this
	// function's own: a miss report needs one location and the earliest is
	// the deterministic choice. A prefix occurring in several places is
	// reported at the earliest of them, which can be further from where the
	// caller was aiming than the report admits.
	const at = text.indexOf(search.slice(0, matched));
	const endOfMatch = at + matched;
	const line = lineAt(text, at);
	const endLine = lineAt(text, endOfMatch);
	const head = `  ${matched} of ${search.length} characters matched, from line ${line} to line ${endLine}`;
	const rest = search.slice(matched);
	// RUNNING PAST THE END IS THE COMMON CASE AND ITS OWN SENTENCE. Four of
	// the ten refusals in the measured session ended exactly here, and
	// rendering that as `the file then has: ""` buries the one fact worth
	// having: there is no more file. A caller that appended what it meant
	// to ADD onto the end of what it meant to FIND reads its own mistake
	// off this line.
	if (endOfMatch >= text.length) {
		return [
			head,
			`  the file ENDS there — your oldText continues for ${rest.length} more characters: "${fragment(rest)}"`,
		].join("\n");
	}
	return [
		head,
		`  the file then has:  "${fragment(text.slice(endOfMatch))}"`,
		`  your oldText wanted: "${fragment(rest)}"`,
	].join("\n");
}

/**
 * ACI-3 — the text a refused edit needs to be retried WITHOUT reading the
 * file again. On the owner's disk every edit_file refusal was followed by
 * a read before the retry: two extra requests per failure, 319 failures.
 * The refusal already knows the file; showing the few lines where the
 * search should land costs a couple of KB once instead of a whole read.
 *
 * Whole lines only (a cut mid-line is a lie about the file), `context`
 * lines each side of the search's own span, cut at a line boundary under
 * `maxChars`. Centred on the best partial match — the longest matching
 * prefix at its earliest occurrence, the place describeSearchMiss names —
 * and null when that prefix is too short to say where the caller aimed.
 */
export interface Region {
	/** 1-based, inclusive. */
	readonly from: number;
	readonly to: number;
	readonly body: string;
}

export function regionForSearch(text: string, search: string, context = 6, maxChars = 1500): Region | null {
	if (search.length === 0) return null;
	const matched = longestMatchingPrefix(text, search);
	// A prefix of a character or two lands anywhere: its region would be
	// noise that costs context. A quarter of the search (at most 16 chars)
	// is where the match starts to say WHERE the caller was aiming.
	if (matched === 0 || matched < Math.min(16, Math.ceil(search.length / 4))) return null;
	return regionAt(text, text.indexOf(search.slice(0, matched)), search.split("\n").length, context, maxChars);
}

/** The whole lines from `context` before `offset`'s line to `context` after
 *  the `span` lines that start there. */
export function regionAt(text: string, offset: number, span: number, context = 6, maxChars = 1500): Region {
	const lines = text.split("\n");
	const last = text.endsWith("\n") ? lines.length - 1 : lines.length;
	const at = lineAt(text, offset);
	const from = Math.max(1, at - context);
	let to = Math.max(from, Math.min(last, at + Math.max(span, 1) - 1 + context));
	let body = lines.slice(from - 1, to).join("\n");
	while (body.length > maxChars && to > from) {
		to -= 1;
		body = lines.slice(from - 1, to).join("\n");
	}
	// one line longer than the cap on its own: the honest answer is the cut, said
	if (body.length > maxChars) body = `${body.slice(0, maxChars)}… (line ${from} continues)`;
	return { from, to, body };
}
