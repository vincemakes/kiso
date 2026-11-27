/**
 * #32: a write result names the file where it landed (its absolute, canonical path), and a folder the write made at the top of
 * a git repository is said in the result, so a tree written in the wrong place is seen at once. A folder made deeper, a
 * workspace that is no repository and a rewrite of an existing file say nothing more.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editFileTool, writeFileTool } from "../src/index.js";

const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const repo = (gitAsFile = false): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiso-32-")));
	if (gitAsFile) writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file
	else mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, "src"));
	return dir;
};
const write = (root: string, path: string, content = "x\n") => writeFileTool({ workspaceRoot: root }).execute({ path, content, expectedRevision: "absent" }, undefined as never);
const note = (dir: string): string => `\nnote: created a new top-level folder in the git repository: ${dir}`;

describe("#32: write results name where the file landed", () => {
	it("a new top-level folder in a git repository is said, the topmost folder made", async () => {
		const root = repo();
		const r = await write(root, "pkg/deep/a.ts");
		expect(r.isError).toBe(false);
		expect(r.content).toBe(`wrote ${join(root, "pkg", "deep", "a.ts")} (2 chars)${note(join(root, "pkg"))}\n[${rev("x\n")}]`);
	});

	it("a worktree's .git file counts as a repository", async () => {
		const root = repo(true);
		expect((await write(root, "tools/b.ts")).content).toContain(note(join(root, "tools")));
	});

	it("a folder made under an existing one says nothing more", async () => {
		const root = repo();
		const r = await write(root, "src/new/c.ts");
		expect(r.content).toBe(`wrote ${join(root, "src", "new", "c.ts")} (2 chars)\n[${rev("x\n")}]`);
	});

	it("a workspace that is no repository says nothing more", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kiso-32-plain-")));
		expect((await write(root, "pkg/d.ts")).content).toBe(`wrote ${join(root, "pkg", "d.ts")} (2 chars)\n[${rev("x\n")}]`);
	});

	it("a file at the repository's top makes no folder and says nothing more", async () => {
		const root = repo();
		expect((await write(root, "e.ts")).content).toBe(`wrote ${join(root, "e.ts")} (2 chars)\n[${rev("x\n")}]`);
	});

	it("an edit names the file by its absolute path, reached through a symlinked workspace as the disk holds it", async () => {
		// the temporary folder as given (on macOS /var is a link to /private/var); the result names the real place
		const given = mkdtempSync(join(tmpdir(), "kiso-32-link-")), root = realpathSync(given);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "f.ts"), "alpha\n");
		const r = await editFileTool({ workspaceRoot: given }).execute({ path: "src/f.ts", search: "alpha", replace: "beta", expectedRevision: rev("alpha\n") }, undefined as never);
		expect(r.content).toBe(`edited ${join(root, "src", "f.ts")}\n[${rev("beta\n")}]`);
	});
});
