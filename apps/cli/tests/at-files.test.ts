/**
 * KC3 T-A5 — the @ picker's file source.
 *
 * Two branches, and the test distinguishes them by their OBSERVABLE
 * difference rather than by mocking: inside a repo the ignore rules
 * are git's, so a `node_modules` entry listed in .gitignore is absent
 * because GIT excluded it; outside a repo the walk's own AT_SKIP is
 * what excludes it, and it excludes the directory even when nothing
 * ignores it.
 *
 * The cap is asserted honestly: the source must hand back AT_CAP + 1
 * entries when more exist, because that extra entry is the ONLY thing
 * that lets the panel's counter distinguish "exactly 2000 files" from
 * "the first 2000 of many".
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AT_CAP } from "@vincemakes/kiso-tui";
import { atFiles } from "../src/state.js";

const ORIG_CWD = process.cwd();
const made: string[] = [];

afterEach(() => {
	process.chdir(ORIG_CWD);
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-at-"));
	made.push(dir);
	return dir;
}

const write = (root: string, rel: string, text = "x"): void => {
	const cut = rel.lastIndexOf("/");
	if (cut !== -1) mkdirSync(join(root, rel.slice(0, cut)), { recursive: true });
	writeFileSync(join(root, rel), text, "utf8");
};

const listed = (): string[] => atFiles().map((i) => i.path);

describe("KC3 T-A5: inside a git repo", () => {
	function repo(): string {
		const root = sandbox();
		execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
		return root;
	}

	it("lists the TRACKED files and the untracked-but-not-ignored ones, and nothing ignored", () => {
		const root = repo();
		write(root, ".gitignore", "ignored.txt\nnode_modules/\n");
		write(root, "src/range.js");
		write(root, "untracked.md");
		write(root, "ignored.txt");
		write(root, "node_modules/dep/index.js");
		execFileSync("git", ["add", "src/range.js"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
		process.chdir(root);
		const out = listed();
		expect(out).toContain("src/range.js"); // tracked (the index, no commit needed)
		expect(out).toContain("untracked.md"); // untracked, not ignored
		expect(out).toContain(".gitignore"); // itself untracked and not ignored
		expect(out).not.toContain("ignored.txt"); // GIT excluded it
		expect(out.some((p) => p.startsWith("node_modules/"))).toBe(false);
	});

	it("no duplicates — `-c -o` is a union, not two overlapping lists", () => {
		const root = repo();
		write(root, "a.ts");
		write(root, "b.ts");
		execFileSync("git", ["add", "a.ts"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
		process.chdir(root);
		const out = listed();
		expect(out.length).toBe(new Set(out).size);
		expect([...out].sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("paths are repo-relative and forward-slashed", () => {
		const root = repo();
		write(root, "deep/nested/dir/file.ts");
		process.chdir(root);
		expect(listed()).toContain("deep/nested/dir/file.ts");
		expect(listed().every((p) => !p.startsWith("/") && !p.includes("\\"))).toBe(true);
	});

	it("an empty repo lists nothing and does not throw", () => {
		process.chdir(repo());
		expect(listed()).toEqual([]);
	});
});

describe("KC3 T-A5: the walk fallback, outside a repo", () => {
	it("it really IS the walk: a .gitignore here is just a file, and what it names is still listed", () => {
		// the discriminator for this whole describe. In the git branch
		// "secret.txt" would be excluded; the walk knows nothing about
		// ignore files, so its presence proves which branch ran.
		const root = sandbox();
		write(root, ".gitignore", "secret.txt\n");
		write(root, "secret.txt");
		process.chdir(root);
		expect([...listed()].sort()).toEqual([".gitignore", "secret.txt"]);
	});

	it("lists files recursively with forward-slashed relative paths", () => {
		const root = sandbox();
		write(root, "a.ts");
		write(root, "src/range.js");
		write(root, "src/deep/nested.ts");
		process.chdir(root);
		expect([...listed()].sort()).toEqual(["a.ts", "src/deep/nested.ts", "src/range.js"]);
	});

	it("PRUNES .git, node_modules, dist, build and coverage — with nothing ignoring them", () => {
		const root = sandbox();
		write(root, "keep.ts");
		for (const skip of [".git", "node_modules", "dist", "build", "coverage"]) {
			write(root, `${skip}/inside.ts`);
			write(root, `nested/${skip}/inside.ts`);
		}
		process.chdir(root);
		const out = listed();
		expect(out).toEqual(["keep.ts"]);
	});

	it("a directory NAMED like a skip but not equal to one is walked", () => {
		const root = sandbox();
		write(root, "distribution/x.ts");
		write(root, "my-node_modules/y.ts");
		process.chdir(root);
		expect([...listed()].sort()).toEqual(["distribution/x.ts", "my-node_modules/y.ts"]);
	});

	it("the cap: more than AT_CAP files yields AT_CAP + 1 — the extra entry is the truncation signal", () => {
		const root = sandbox();
		for (let i = 0; i < AT_CAP + 50; i += 1) write(root, `f${i}.ts`);
		process.chdir(root);
		expect(listed().length).toBe(AT_CAP + 1);
	});

	it("under the cap, everything is listed and nothing signals truncation", () => {
		const root = sandbox();
		for (let i = 0; i < 25; i += 1) write(root, `f${i}.ts`);
		process.chdir(root);
		expect(listed().length).toBe(25);
	});

	it("an empty directory lists nothing and does not throw", () => {
		process.chdir(sandbox());
		expect(listed()).toEqual([]);
	});
});
