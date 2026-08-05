/**
 * v2e — the diff renderer: edit/write changes as inline ± lines, zero
 * dependencies, no syntax highlighting (the spec's scope line). Shown at
 * the approval moment ONLY — the frozen summary stays one line (v2d's
 * anti-leak principle), /last has the full data.
 *
 * edit_file diffs IN PLACE (the search→replace windows are known — no
 * general engine needed); write_file does a row-level LCS over the old
 * file (small files are the target). Context: 2 rows each side. The
 * RENDERER truncates (18 head + 18 tail + "… N lines"); the stats come
 * from the full diff.
 */

/** The diff block's per-row kind. */
export type DiffLine = { kind: "-" | "+" | " "; text: string };

export interface DiffResult {
	/** The FULL diff (with context, not truncated) — the display truncates. */
	lines: DiffLine[];
	added: number;
	removed: number;
}

/** A line-level LCS diff — the classic two-row DP, ~small inputs. */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
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
		{ kind: " ", text: `… ${omitted} lines (/last for full)` },
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

/** edit_file: the search→replace windows replace in place — the changed
 *  region is KNOWN, so the diff is the old window vs the new window,
 *  context from the surrounding file. */
export function editFileDiff(oldContent: string, search: string, replace: string): DiffResult {
	const oldLines = oldContent.split("\n");
	const searchLines = search.split("\n");
	const replaceLines = replace.split("\n");
	// Locate the search window (the first occurrence — the edit tool's own
	// semantics); no occurrence → the whole file is the old side.
	let at = -1;
	for (let i = 0; i + searchLines.length <= oldLines.length; i += 1) {
		if (oldLines.slice(i, i + searchLines.length).join("\n") === search) {
			at = i;
			break;
		}
	}
	const lines = at < 0 ? withContext(lcsDiff(oldLines, replaceLines)) : withContext(lcsDiff(oldLines, [...oldLines.slice(0, at), ...replaceLines, ...oldLines.slice(at + searchLines.length)]));
	return { lines, ...stats(lines) };
}

/** write_file: a new file is all +; an existing file diffs row-level
 *  against its old content. */
export function writeFileDiff(oldContent: string | null, newContent: string): DiffResult {
	if (oldContent === null) {
		const lines = newContent.split("\n").map((text) => ({ kind: "+" as const, text }));
		return { lines, added: lines.length, removed: 0 };
	}
	const lines = withContext(lcsDiff(oldContent.split("\n"), newContent.split("\n")));
	return { lines, ...stats(lines) };
}
