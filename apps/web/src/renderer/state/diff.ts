/**
 * A small line diff for an edit step: the lines that changed, with one line
 * of context each side. Not a general diff: an edit's oldText and newText
 * share their head and tail, and what lies between them is shown as removed
 * then added.
 */

export interface DiffLine {
	readonly kind: "ctx" | "add" | "del";
	readonly text: string;
}

export function lineDiff(oldText: string, newText: string, context = 1): DiffLine[] {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
	const out: DiffLine[] = [];
	for (let i = Math.max(0, head - context); i < head; i++) out.push({ kind: "ctx", text: a[i]! });
	for (let i = head; i < a.length - tail; i++) out.push({ kind: "del", text: a[i]! });
	for (let i = head; i < b.length - tail; i++) out.push({ kind: "add", text: b[i]! });
	for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + context); i++) out.push({ kind: "ctx", text: a[i]! });
	return out;
}

/** The lines an `edit_file` call changes, over all its hunks. */
export function editDiff(input: Readonly<Record<string, unknown>> | null): DiffLine[] {
	const edits = input?.["edits"];
	if (!Array.isArray(edits)) return [];
	return edits.flatMap((h) => {
		const hunk = h as { oldText?: unknown; newText?: unknown };
		return typeof hunk.oldText === "string" && typeof hunk.newText === "string" ? lineDiff(hunk.oldText, hunk.newText) : [];
	});
}
