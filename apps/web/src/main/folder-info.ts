import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { EnvReply } from "../shared/settings.js";

/** The git directory of a folder (it or the nearest parent holding `.git`, a directory or a worktree's pointer file). */
function gitDir(from: string): string | null {
	for (let dir = from; ; dir = dirname(dir)) {
		const dot = join(dir, ".git");
		if (existsSync(dot)) {
			if (statSync(dot).isDirectory()) return dot;
			const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
			return pointer === null ? null : join(dir, pointer[1]!.trim());
		}
		if (dirname(dir) === dir) return null;
	}
}

/** The branch a folder is on (a short commit when detached); null outside a git folder. */
export function branchOf(workspace: string): string | null {
	try {
		const git = gitDir(workspace);
		if (git === null) return null;
		const head = readFileSync(join(git, "HEAD"), "utf8").trim();
		const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
		return ref !== null ? ref[1]! : head.slice(0, 7);
	} catch {
		return null;
	}
}

/** What the rail's footer says about a Work's folder: its name, its path (the home shortened), its branch. */
export function folderInfo(workspace: string, mode: string): EnvReply {
	const home = homedir();
	return { folder: basename(workspace), path: workspace.startsWith(`${home}/`) ? `~${workspace.slice(home.length)}` : workspace, root: workspace, branch: branchOf(workspace), mode };
}

/** `owner/repo` of a folder's GitHub remote: `origin`'s, else any other remote that is on GitHub. */
export function githubOf(folder: string): string | null {
	try {
		const git = gitDir(folder);
		const config = git === null ? "" : readFileSync(join(git.replace(/\/worktrees\/[^/]+$/, ""), "config"), "utf8");
		const urls = [...config.matchAll(/\[remote "([^"]+)"\][^\[]*?url\s*=\s*(\S+)/g)].map((m) => [m[1]!, m[2]!] as const);
		for (const [, url] of [...urls.filter(([n]) => n === "origin"), ...urls.filter(([n]) => n !== "origin")]) {
			const m = /^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
			if (m !== null) return m[1]!;
		}
		return null;
	} catch {
		return null;
	}
}
