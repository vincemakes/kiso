/**
 * Graphite §8.9 — the branch the status bar names, read from the files
 * git keeps (no git process: the bar paints on every idle frame).
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchOf, currentBranch } from "../src/git-branch.js";

const SHA = "3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345";

function repo(head: string): { root: string; deep: string; headFile: string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-branch-"));
	mkdirSync(join(root, ".git"));
	const headFile = join(root, ".git", "HEAD");
	writeFileSync(headFile, head);
	const deep = join(root, "src", "a", "b");
	mkdirSync(deep, { recursive: true });
	return { root, deep, headFile };
}

describe("§8.9 — the branch", () => {
	it("a branch, from any directory inside the repository", () => {
		const { root, deep } = repo("ref: refs/heads/feat/tui-graphite\n");
		expect(currentBranch(root)).toBe("feat/tui-graphite");
		expect(currentBranch(deep)).toBe("feat/tui-graphite");
	});

	it("a detached HEAD shows its short sha", () => {
		const { root } = repo(`${SHA}\n`);
		expect(currentBranch(root)).toBe(SHA.slice(0, 7));
	});

	it("a `.git` FILE (a worktree, a submodule) is followed to the real git directory", () => {
		const { root: main } = repo("ref: refs/heads/main\n");
		const gitdir = join(main, ".git", "worktrees", "wt");
		mkdirSync(gitdir, { recursive: true });
		writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/wt\n");
		const wt = mkdtempSync(join(tmpdir(), "kiso-branch-wt-"));
		writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
		expect(currentBranch(wt)).toBe("feat/wt");
		// a relative gitdir resolves against the directory holding the file
		const rel = mkdtempSync(join(main, "nested-"));
		mkdirSync(join(rel, "real"), { recursive: true });
		writeFileSync(join(rel, "real", "HEAD"), "ref: refs/heads/rel\n");
		writeFileSync(join(rel, ".git"), "gitdir: real\n");
		expect(currentBranch(rel)).toBe("rel");
	});

	it("outside a repository, or on a HEAD it cannot read, there is no branch", () => {
		const bare = mkdtempSync(join(tmpdir(), "kiso-branch-none-"));
		expect(currentBranch(bare)).toBeNull();
		expect(currentBranch(join(bare, "does-not-exist"))).toBeNull();
		const { root } = repo("garbage\n");
		expect(currentBranch(root)).toBeNull();
		const broken = mkdtempSync(join(tmpdir(), "kiso-branch-broken-"));
		writeFileSync(join(broken, ".git"), "not a gitdir line\n");
		expect(currentBranch(broken)).toBeNull();
	});

	it("a checkout mid-session is seen on the next paint: HEAD's mtime moves", () => {
		const { root, headFile } = repo("ref: refs/heads/one\n");
		expect(currentBranch(root)).toBe("one");
		writeFileSync(headFile, "ref: refs/heads/two\n");
		const later = new Date(Date.now() + 5_000);
		utimesSync(headFile, later, later);
		expect(currentBranch(root)).toBe("two");
	});

	it("the HEAD grammar", () => {
		expect(branchOf("ref: refs/heads/main")).toBe("main");
		expect(branchOf("ref: refs/heads/a/b/c\n")).toBe("a/b/c");
		expect(branchOf(SHA)).toBe("3f9c2a1");
		expect(branchOf("ref: refs/remotes/origin/main")).toBeNull();
		expect(branchOf("")).toBeNull();
	});
});
