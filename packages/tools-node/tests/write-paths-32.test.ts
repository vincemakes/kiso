/**
 * #32: a folder write_file makes at the top of a git repository is said in its result, by its absolute path, so a tree written
 * in the wrong place (the incident: a relative delivery path made a new top-level folder) is seen at once. Every other result
 * is unchanged, byte for byte: a folder made deeper, a workspace that is no repository, a file at the top. The absolute path
 * of the file itself is not echoed (declined: its per-request cost against WR-1E).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileTool } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const repo = (gitAsFile = false): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiso-32-")));
	if (gitAsFile) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file
	else mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, "src"));
	return dir;
};
const write = (root: string, path: string, content = "x\n") => writeFileTool({ workspaceRoot: root }).execute({ path, content, expectedRevision: "absent" }, undefined as never);
const plain = (path: string): string => `wrote ${path} (2 chars)\n[${rev("x\n")}]`;

describe("#32: a new top-level folder in a git repository is said", () => {
	it("the note, its exact bytes, naming the topmost folder the write made", async () => {
		const root = repo();
		const r = await write(root, "pkg/deep/a.ts");
		expect(r.isError).toBe(false);
		expect(r.content).toBe(`wrote pkg/deep/a.ts (2 chars)\nnote: created a new top-level folder in the git repository: ${join(root, "pkg")}\n[${rev("x\n")}]`);
	});

	it("a worktree's .git file counts as a repository", async () => {
		const root = repo(true);
		expect((await write(root, "tools/b.ts")).content).toBe(`wrote tools/b.ts (2 chars)\nnote: created a new top-level folder in the git repository: ${join(root, "tools")}\n[${rev("x\n")}]`);
	});

	it("a folder made under an existing one: the result is unchanged", async () => {
		expect((await write(repo(), "src/new/c.ts")).content).toBe(plain("src/new/c.ts"));
	});

	it("a workspace that is no repository: the result is unchanged", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kiso-32-plain-")));
		expect((await write(root, "pkg/d.ts")).content).toBe(plain("pkg/d.ts"));
	});

	it("a file at the repository's top makes no folder: the result is unchanged", async () => {
		expect((await write(repo(), "e.ts")).content).toBe(plain("e.ts"));
	});
});
