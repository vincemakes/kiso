/**
 * v2e — the diff renderer: edit/write changes as inline ± lines, zero
 * dependencies, no syntax highlighting (the spec's scope line). v2e drew
 * it at the approval moment only; Graphite §6 (R2a) draws it on every
 * edit's card too, from the call's own hunks (`hunksDiff`) — DECLARED
 * REVERSAL of "the frozen summary stays one line".
 *
 * edit_file diffs IN PLACE (the search→replace windows are known — no
 * general engine needed); write_file does a row-level LCS over the old
 * file (small files are the target). Context: 2 rows each side. The
 * RENDERER truncates (18 head + 18 tail + "… N lines"); the stats come
 * from the full diff.
 */

/** The diff block's per-row kind. `note` (0.40.0) is kiso's sentence
 *  ABOUT the diff — the renderer's cut, a search that is not there or is
 *  there more than once — never a line of the file, so never drawn where
 *  the file's lines are. */
export type DiffLine = {
	kind: "-" | "+" | " " | "note";
	text: string;
	/** Graphite §6 (R2a): the changed WORDS of a line that replaced one
	 *  other line — `[start, end)` offsets into `text`, sorted, disjoint.
	 *  Absent everywhere else. */
	marks?: readonly (readonly [number, number])[];
};

/** One change an edit_file call asks for: the text it looks for, and what
 *  replaces it. */
export interface Hunk {
	readonly search: string;
	readonly replace: string;
}

export interface DiffResult {
	/** The FULL diff (with context, not truncated) — the display truncates. */
	lines: DiffLine[];
	added: number;
	removed: number;
	/** Which of the three this result is. Set on EVERY result.
	 *
	 *  - `"diff"` — `lines` is a real diff and the counts are real
	 *  - `"not-found"` — the search is not in the file
	 *  - `"ambiguous"` — the search resolves in more than one place (ACI-2)
	 *
	 *  The last two carry an honest note in `lines` and zero counts: the
	 *  tool will refuse, so there is no edit to draw. */
	outcome?: "diff" | "not-found" | "ambiguous";
	/** TUI2-R1.5 ② (VD-2): the search is not in the file — the tool will
	 *  ERROR, so the panel shows the honest note carried in `lines` and
	 *  never a diff.
	 *
	 *  @deprecated Read `outcome`. This flag means *the search was not
	 *  found*; it has never meant *there is no diff*, and since ACI-2 those
	 *  are different things — an ambiguous search also produces a note with
	 *  no diff and does NOT set this flag. Its value is unchanged and will
	 *  stay `outcome === "not-found"`, so nothing that reads it today
	 *  changes meaning. */
	notFound?: true;
}

/** A line-level LCS diff — the classic two-row DP, ~small inputs. */
export function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
	const n = oldLines.length;
	const m = newLines.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			out.push({ kind: " ", text: oldLines[i]! });
			i += 1;
			j += 1;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			out.push({ kind: "-", text: oldLines[i]! });
			i += 1;
		} else {
			out.push({ kind: "+", text: newLines[j]! });
			j += 1;
		}
	}
	while (i < n) {
		out.push({ kind: "-", text: oldLines[i]! });
		i += 1;
	}
	while (j < m) {
		out.push({ kind: "+", text: newLines[j]! });
		j += 1;
	}
	return out;
}

/** Keep 2 context rows around each change — the unified-style window. */
function withContext(diff: DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let lastAdded = -10;
	for (let k = 0; k < diff.length; k += 1) {
		if (diff[k]!.kind === " ") continue;
		const from = Math.max(0, k - 2);
		const to = Math.min(diff.length - 1, k + 2);
		for (let c = from; c <= to; c += 1) {
			if (c > lastAdded) {
				out.push(diff[c]!);
				lastAdded = c;
			}
		}
		lastAdded = to;
	}
	return out;
}

const MAX_DIFF_LINES = 40; // the RENDERED cap
const TRUNCATE_KEEP = 18;

/** The RENDERER's truncation: head + "… N lines (/last for full)" + tail. */
export function truncateDiff(diff: DiffLine[]): DiffLine[] {
	if (diff.length <= MAX_DIFF_LINES) return diff;
	const omitted = diff.length - 2 * TRUNCATE_KEEP;
	return [
		...diff.slice(0, TRUNCATE_KEEP),
		{ kind: "note", text: `… ${omitted} lines (/last for full)` },
		...diff.slice(diff.length - TRUNCATE_KEEP),
	];
}

function stats(diff: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const d of diff) {
		if (d.kind === "+") added += 1;
		else if (d.kind === "-") removed += 1;
	}
	return { added, removed };
}

/** edit_file: the preview of a CHARACTER splice.
 *
 *  TUI2-R1.5 ② (VD-2): the locator is the tool's own, verbatim — the
 *  workspace edit_file does `i = text.indexOf(search)` and writes
 *  `text.slice(0, i) + replace + text.slice(i + search.length)`. This
 *  function mirrors those two lines and diffs the result against the
 *  original; it does not model the edit, it reproduces it.
 *
 *  The retired locator required the search to align to FULL LINES. A
 *  mid-line search ("// OLD" inside "  // OLD") therefore missed, and
 *  the miss branch rendered the WHOLE FILE as the old side: a one-line
 *  edit was drawn as a catastrophic rewrite, on the approval panel, at
 *  the moment a human was deciding whether to allow it. A preview that
 *  can be that wrong is worse than no preview.
 *
 *  A genuine miss is now reported as a miss: the tool will return
 *  `pattern not found in <path>` and change nothing, so the panel says
 *  exactly that instead of inventing a diff for an edit that will not
 *  happen. `path` names the file in that note.
 *
 *  Since ACI-2 an AMBIGUOUS search is the second case of the same rule:
 *  the tool refuses it, so there is no edit to draw. */
export function editFileDiff(oldContent: string, search: string, replace: string, path?: string): DiffResult {
	const at = oldContent.indexOf(search);
	if (at < 0) {
		return {
			lines: [{ kind: "note", text: `pattern not found in ${path ?? "the file"}` }],
			added: 0,
			removed: 0,
			outcome: "not-found",
			notFound: true,
		};
	}
	// ACI-2: an ambiguous search is REFUSED by the tool, and this diff is
	// drawn for the APPROVAL PANEL — before the tool runs. Previewing the
	// first of N places showed a human the very edit ACI-2 exists to
	// prevent, then asked them to approve one that would not happen. The
	// same rule as the miss above, for the same reason.
	if (search.length > 0 && oldContent.indexOf(search, at + 1) > at) {
		return {
			lines: [{ kind: "note", text: `pattern matches more than one place in ${path ?? "the file"}` }],
			added: 0,
			removed: 0,
			outcome: "ambiguous",
		};
	}
	const result = oldContent.slice(0, at) + replace + oldContent.slice(at + search.length);
	const lines = withMarks(withContext(lcsDiff(oldContent.split("\n"), result.split("\n"))));
	return { lines, ...stats(lines), outcome: "diff" };
}

/** write_file: a new file is all +; an existing file diffs row-level
 *  against its old content. */
export function writeFileDiff(oldContent: string | null, newContent: string): DiffResult {
	if (oldContent === null) {
		const lines = newContent.split("\n").map((text) => ({ kind: "+" as const, text }));
		return { lines, added: lines.length, removed: 0, outcome: "diff" };
	}
	const lines = withContext(lcsDiff(oldContent.split("\n"), newContent.split("\n")));
	return { lines, ...stats(lines), outcome: "diff" };
}

/** The hunks an edit_file call carries, in either vocabulary the tool
 *  takes (ADR-0061): `edits` of `{oldText, newText}` or of legacy
 *  `{search, replace}`, or the legacy top-level pair. A log written before
 *  the rename keeps the old names, so a reader must take both. Null when
 *  the tool would refuse the shape (nothing, or a hunk mixing the two) —
 *  there is nothing to draw. */
export function hunksOf(input: Record<string, unknown>): Hunk[] | null {
	const pair = (x: unknown, current: boolean): Hunk | null => {
		if (typeof x !== "object" || x === null) return null;
		const { oldText, newText, search, replace } = x as { oldText?: unknown; newText?: unknown; search?: unknown; replace?: unknown };
		const hasCurrent = oldText !== undefined || newText !== undefined;
		const hasLegacy = search !== undefined || replace !== undefined;
		if (hasCurrent && (hasLegacy || !current)) return null;
		if (hasCurrent) return typeof oldText === "string" && typeof newText === "string" ? { search: oldText, replace: newText } : null;
		return typeof search === "string" && typeof replace === "string" ? { search, replace } : null;
	};
	if (Array.isArray(input.edits)) {
		const hunks = input.edits.map((h) => pair(h, true));
		return hunks.length > 0 && hunks.every((h) => h !== null) ? (hunks as Hunk[]) : null;
	}
	const one = pair(input, false);
	return one === null ? null : [one];
}

/** Graphite §6 (R2a) — what an edit CHANGED, drawn from the call's own
 *  hunks: per hunk a line LCS of `search` against `replace`, the lines
 *  both keep as context (two around each change), a `···` note between
 *  hunks, and word marks where one line replaced one line. The file is
 *  never read, so the diff is a pure function of the durable log — the
 *  same live, after a reprint, after resume. */
export function hunksDiff(hunks: readonly Hunk[]): DiffResult {
	const lines: DiffLine[] = [];
	for (const [i, h] of hunks.entries()) {
		const one = withMarks(withContext(lcsDiff(h.search.split("\n"), h.replace.split("\n"))));
		if (one.length === 0) continue;
		if (i > 0 && lines.length > 0) lines.push({ kind: "note", text: "\u00b7\u00b7\u00b7" });
		lines.push(...one);
	}
	return { lines, ...stats(lines), outcome: "diff" };
}

/** The approval preview of a batch: the hunks applied IN ORDER, each to
 *  the text the ones before it left — the tool's own rule (ACI-3) — and
 *  the result diffed against the file. A hunk the tool would refuse (not
 *  there, or there more than once) is named, and nothing is drawn: the
 *  tool writes all of the batch or none of it. */
export function editFileHunksDiff(oldContent: string, hunks: readonly Hunk[], path?: string): DiffResult {
	if (hunks.length === 1) return editFileDiff(oldContent, hunks[0]!.search, hunks[0]!.replace, path);
	const where = path ?? "the file";
	let edited = oldContent;
	for (const [i, h] of hunks.entries()) {
		const at = edited.indexOf(h.search);
		const which = i === 0 ? "hunk 1" : `hunk ${i + 1}, after ${i === 1 ? "hunk 1" : `hunks 1\u2013${i}`} applied`;
		if (at < 0) return { lines: [{ kind: "note", text: `pattern not found in ${where} (${which})` }], added: 0, removed: 0, outcome: "not-found", notFound: true };
		if (h.search.length > 0 && edited.indexOf(h.search, at + 1) > at) {
			return { lines: [{ kind: "note", text: `pattern matches more than one place in ${where} (${which})` }], added: 0, removed: 0, outcome: "ambiguous" };
		}
		edited = edited.slice(0, at) + h.replace + edited.slice(at + h.search.length);
	}
	const lines = withMarks(withContext(lcsDiff(oldContent.split("\n"), edited.split("\n"))));
	return { lines, ...stats(lines), outcome: "diff" };
}

/** A line's tokens: runs of word characters, runs of spaces, and every
 *  other character on its own. Joined, they are the line. */
export function wordTokens(line: string): string[] {
	return line.match(/[\p{L}\p{N}_]+|\s+|[\s\S]/gu) ?? [];
}

/** The share of a replaced line's tokens (spaces aside) that must survive
 *  for word marks to help: below it the whole line changed, and marking
 *  nearly every word says less than the line's own colour does. */
const MARK_MIN_KEPT = 0.34;

/** Word marks on a diff: every `-` line directly followed by one `+` line,
 *  with no other change beside the pair, gets the offsets of the tokens
 *  the other side does not keep (a token LCS). */
function withMarks(diff: DiffLine[]): DiffLine[] {
	const changed = (k: number): boolean => k >= 0 && k < diff.length && (diff[k]!.kind === "-" || diff[k]!.kind === "+");
	return diff.map((d, k) => {
		const pairAt = d.kind === "-" ? k : d.kind === "+" ? k - 1 : -1;
		if (pairAt < 0 || diff[pairAt]?.kind !== "-" || diff[pairAt + 1]?.kind !== "+" || changed(pairAt - 1) || changed(pairAt + 2)) return d;
		const [oldMarks, newMarks] = tokenMarks(diff[pairAt]!.text, diff[pairAt + 1]!.text);
		if (oldMarks === null || newMarks === null) return d;
		const marks = d.kind === "-" ? oldMarks : newMarks;
		return marks.length === 0 ? d : { ...d, marks };
	});
}

/** The token LCS of two lines: for each side, the `[start, end)` offsets
 *  of the tokens the other side does not keep, adjacent ones merged.
 *  Null when too little survives for marks to mean anything. */
export function tokenMarks(a: string, b: string): [Array<[number, number]> | null, Array<[number, number]> | null] {
	const ta = wordTokens(a);
	const tb = wordTokens(b);
	const n = ta.length;
	const m = tb.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) dp[i]![j] = ta[i] === tb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	}
	const keptA = new Array<boolean>(n).fill(false);
	const keptB = new Array<boolean>(m).fill(false);
	for (let i = 0, j = 0; i < n && j < m; ) {
		if (ta[i] === tb[j]) {
			keptA[i] = true;
			keptB[j] = true;
			i += 1;
			j += 1;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1;
		else j += 1;
	}
	const solid = (t: string): boolean => /\S/.test(t);
	const words = ta.filter(solid).length + tb.filter(solid).length;
	const kept = ta.filter((t, i) => keptA[i] && solid(t)).length + tb.filter((t, j) => keptB[j] && solid(t)).length;
	if (words === 0 || kept / words < MARK_MIN_KEPT) return [null, null];
	return [spans(ta, keptA), spans(tb, keptB)];
}

/** The offsets of the tokens not kept, adjacent spans merged; a run of
 *  spaces between two changed tokens joins them. */
function spans(tokens: readonly string[], kept: readonly boolean[]): Array<[number, number]> {
	const line = tokens.join("");
	const out: Array<[number, number]> = [];
	let at = 0;
	for (const [i, t] of tokens.entries()) {
		const end = at + t.length;
		if (!kept[i] && /\S/.test(t)) {
			const last = out[out.length - 1];
			if (last !== undefined && /^\s*$/.test(line.slice(last[1], at))) last[1] = end;
			else out.push([at, end]);
		}
		at = end;
	}
	return out;
}
