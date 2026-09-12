/**
 * PR-1 §6.1 — the ENVIRONMENT block, computed once at session start.
 *
 * The base prompt is byte-stable for a session's lifetime (the A-area rule),
 * and this section keeps that promise: it is composed once from facts that
 * cannot change under the session's feet, and never recomputed.
 *
 * Every line is a fact the model would otherwise have to spend a tool call
 * discovering, or worse, guess at. What is deliberately NOT here:
 *
 *   - no MODEL line. `/model` switches mid-session and the base is fixed for
 *     the session, so a model line would go stale the moment it mattered. A
 *     stale name is worse than none.
 *   - no CURRENT TIME. The session-start date is stable; "now" is not, and a
 *     rounded "now" read hours later is a lie the model cannot detect. The
 *     line says to run a command for it.
 *
 * The git line asks the filesystem, not git: a subprocess at startup is a
 * cost on every session for one boolean, and `.git` can be a FILE rather than
 * a directory (that is what a worktree leaves), which a naive directory check
 * gets wrong — this round's arms are built in worktrees, so that case is not
 * hypothetical.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { release, type } from "node:os";

/** Walk UP from the workspace root looking for `.git`, as a directory OR a
 *  file. No subprocess. */
export function inGitWorkTree(root: string, exists: (p: string) => boolean = existsSync): boolean {
	let dir = resolve(root);
	for (;;) {
		if (exists(join(dir, ".git"))) return true;
		const up = dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

export interface EnvironmentFacts {
	readonly workspaceRoot: string;
	readonly git: boolean;
	readonly platform: string;
	readonly osType: string;
	readonly osRelease: string;
	/** The session's start instant, as YYYY-MM-DD in the local zone. */
	readonly date: string;
	readonly timeZone: string;
}

/** The facts, read once. `now` and the probes are parameters so the gate can
 *  pin the block's SHAPE without depending on the machine it runs on. */
export function environmentFacts(
	root: string,
	now: Date = new Date(),
	deps: { exists?: (p: string) => boolean; platform?: string; osType?: string; osRelease?: string; timeZone?: string } = {},
): EnvironmentFacts {
	const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	// The LOCAL calendar date in that zone, not the UTC one. Read the parts BY
	// TYPE rather than by position: the order of a locale's parts is the
	// locale's business, and a positional read is a bug waiting for a locale
	// change.
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const part = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
	const [y, m, d] = [part("year"), part("month"), part("day")];
	return {
		workspaceRoot: root,
		git: inGitWorkTree(root, deps.exists ?? existsSync),
		platform: deps.platform ?? process.platform,
		osType: deps.osType ?? type(),
		osRelease: deps.osRelease ?? release(),
		date: `${y}-${m}-${d}`,
		timeZone: zone,
	};
}

/** The block as it appears in the prompt. The DATE LINE IS LAST, after the
 *  stable text, so the bytes above it are identical across sessions on the
 *  same machine — which is what makes a provider's prefix cache worth
 *  anything. */
export function environmentBlock(f: EnvironmentFacts): string {
	return [
		"",
		"# Environment",
		`- Workspace root, your working directory: ${f.workspaceRoot}`,
		`- ${f.git ? "Inside a git work tree" : "Not in a git work tree"}`,
		`- Platform: ${f.platform} ${f.osType} ${f.osRelease}; shell runs through /bin/sh in the`,
		"  workspace root, not your login shell.",
		`- Session started ${f.date} (${f.timeZone}); for the current time, run a`,
		"  command.",
	].join("\n");
}
