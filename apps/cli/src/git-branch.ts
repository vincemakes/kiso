/**
 * Graphite §8.9 — the branch the status bar names.
 *
 * Read from `.git/HEAD`, walking up from the working directory — no git
 * process is spawned, because the status bar paints on every idle frame.
 * A `.git` FILE (a worktree, a submodule) points at the real git
 * directory with `gitdir: <path>`, and that is followed. A detached HEAD
 * shows its short sha. Outside a repository, or on any read error, there
 * is no branch and the bar says nothing about one.
 *
 * The answer is cached per HEAD file and re-read only when HEAD's mtime
 * moves — a checkout the model runs mid-session is picked up on the next
 * paint, and an idle session reads one stat per paint.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const cache = new Map<string, { readonly mtimeMs: number; readonly branch: string | null }>();

/** The HEAD file of the repository `dir` is inside, or null. */
function headFile(dir: string): string | null {
	let d = resolve(dir);
	for (;;) {
		const dotGit = join(d, ".git");
		try {
			const st = statSync(dotGit);
			if (st.isDirectory()) return join(dotGit, "HEAD");
			if (st.isFile()) {
				const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
				if (m !== null) return join(resolve(d, m[1]!.trim()), "HEAD");
				return null;
			}
		} catch {
			// no .git here — keep walking
		}
		const up = dirname(d);
		if (up === d) return null;
		d = up;
	}
}

/** What a HEAD file's contents name: the branch, or a detached sha's head. */
export function branchOf(head: string): string | null {
	const text = head.trim();
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref !== null) return ref[1]!;
	if (/^[0-9a-f]{7,64}$/i.test(text)) return text.slice(0, 7);
	return null;
}

export function currentBranch(dir: string): string | null {
	try {
		const head = headFile(dir);
		if (head === null) return null;
		const mtimeMs = statSync(head).mtimeMs;
		const hit = cache.get(head);
		if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.branch;
		const branch = branchOf(readFileSync(head, "utf8"));
		cache.set(head, { mtimeMs, branch });
		return branch;
	} catch {
		return null;
	}
}
