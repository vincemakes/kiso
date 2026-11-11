/** ADR-0058 Amendment 19: what the file tools reach beyond the workspace, and where they stop. */

import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { editFileTool, listDirTool, readFileTool, searchTextTool, writeFileTool, type FileAccess } from "../src/index.js";

const CTX: ToolContext = { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, sessionId: "s" };
const dir = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), "kiso-reach-")));

function world(access: FileAccess, stops: readonly string[] = []) {
	const primary = dir();
	const state = { access };
	const opts = { workspaceRoot: primary, access: () => state.access, stopRoots: stops };
	return { primary, state, opts };
}

describe("added folders", () => {
	it("all five tools work in an added folder, and walks name absolute paths", async () => {
		const added = dir();
		writeFileSync(join(added, "a.txt"), "needle // kept\n");
		mkdirSync(join(added, "sub"));
		writeFileSync(join(added, "sub", "b.txt"), "other\n");
		const { opts } = world({ added: [added], outside: "deny" });
		const read = await readFileTool(opts).execute({ path: join(added, "a.txt") }, CTX);
		expect(read).toMatchObject({ isError: false });
		const listed = await listDirTool(opts).execute({ path: added }, CTX);
		expect(listed.content).toContain("a.txt");
		const glob = await listDirTool(opts).execute({ path: added, glob: "**/*.txt" }, CTX);
		expect(glob.content).toContain(join(added, "sub", "b.txt"));
		const found = await searchTextTool(opts).execute({ pattern: "needle", path: added }, CTX);
		expect(found.content).toContain(join(added, "a.txt"));
		expect(found.content).toContain("needle // kept"); // the file's text is not normalized as a path
		const one = await searchTextTool(opts).execute({ pattern: "needle", path: join(added, "a.txt") }, CTX);
		expect(one.content).toContain(join(added, "a.txt"));
		const wrote = await writeFileTool({ ...opts }).execute({ path: join(added, "new.txt"), content: "x\n", expectedRevision: "absent" } as never, CTX);
		expect(wrote).toMatchObject({ isError: false });
		expect(readFileSync(join(added, "new.txt"), "utf8")).toBe("x\n");
		const rev = /\[(rev:[0-9a-f]+)\]/.exec(read.content as string)![1]!;
		const edited = await editFileTool(opts).execute({ path: join(added, "a.txt"), edits: [{ oldText: "needle", newText: "pin" }], expectedRevision: rev } as never, CTX);
		expect(edited).toMatchObject({ isError: false });
	});

	it("a symlink or .. out of an added folder is refused", async () => {
		const added = dir();
		const away = dir();
		writeFileSync(join(away, "s.txt"), "secret\n");
		symlinkSync(away, join(added, "link"));
		const { opts } = world({ added: [added], outside: "deny" });
		expect((await readFileTool(opts).execute({ path: join(added, "link", "s.txt") }, CTX)).content).toContain("[path denied]");
		expect((await readFileTool(opts).execute({ path: join(added, "..", away.split("/").pop()!, "s.txt") }, CTX)).content).toContain("[path denied]");
	});

	it("a removal applies at the very next call", async () => {
		const added = dir();
		writeFileSync(join(added, "a.txt"), "x\n");
		const { opts, state } = world({ added: [added], outside: "deny" });
		const tool = readFileTool(opts);
		expect(await tool.execute({ path: join(added, "a.txt") }, CTX)).toMatchObject({ isError: false });
		state.access = { added: [], outside: "deny" };
		expect((await tool.execute({ path: join(added, "a.txt") }, CTX)).content).toContain("[path denied]");
	});
});

describe("outside the workspace", () => {
	it("is refused with today's words unless the mode allows it, and a mode change applies at once", async () => {
		const away = dir();
		writeFileSync(join(away, "a.txt"), "x\n");
		const { opts, state, primary } = world({ added: [], outside: "deny" });
		const tool = readFileTool(opts);
		const refused = await tool.execute({ path: join(away, "a.txt") }, CTX);
		expect(refused.content).toBe(`[path denied] absolute path outside the workspace: ${join(away, "a.txt")} — the workspace root is ${primary}; use a path inside it`);
		state.access = { added: [], outside: "allow" };
		expect(await tool.execute({ path: join(away, "a.txt") }, CTX)).toMatchObject({ isError: false });
	});

	it("a stop path is refused for read and write, through a symlink too", async () => {
		const stop = dir();
		writeFileSync(join(stop, "key"), "k\n");
		const away = dir();
		symlinkSync(stop, join(away, "via"));
		const { opts } = world({ added: [], outside: "allow" }, [stop]);
		expect((await readFileTool(opts).execute({ path: join(stop, "key") }, CTX)).content).toContain("do not reach");
		expect((await readFileTool(opts).execute({ path: join(away, "via", "key") }, CTX)).content).toContain("do not reach");
		const w = await writeFileTool(opts).execute({ path: join(stop, "new"), content: "x", expectedRevision: "absent" } as never, CTX);
		expect(w.content).toContain("do not reach");
		expect(existsSync(join(stop, "new"))).toBe(false);
	});

	it("a walk from above a stop path does not enter it", async () => {
		const away = dir();
		const stop = join(away, "keys");
		mkdirSync(stop);
		writeFileSync(join(stop, "k.txt"), "needle\n");
		writeFileSync(join(away, "open.txt"), "needle\n");
		const { opts } = world({ added: [], outside: "allow" }, [stop]);
		const found = await searchTextTool(opts).execute({ pattern: "needle", path: away }, CTX);
		expect(found.content).toContain("open.txt");
		expect(found.content).not.toContain("k.txt");
		const glob = await listDirTool(opts).execute({ path: away, glob: "**/*.txt" }, CTX);
		expect(glob.content).not.toContain("k.txt");
	});

	it(".git and .kiso are not written in the new reach, and can be read", async () => {
		const added = dir();
		mkdirSync(join(added, ".git"));
		writeFileSync(join(added, ".git", "config"), "c\n");
		const { opts } = world({ added: [added], outside: "allow" });
		const w = await writeFileTool(opts).execute({ path: join(added, ".GIT", "hook"), content: "x", expectedRevision: "absent" } as never, CTX);
		expect(w.content).toContain("do not write");
		expect(await readFileTool(opts).execute({ path: join(added, ".git", "config") }, CTX)).toMatchObject({ isError: false });
	});

	it("a multi-link file stays refused", async () => {
		const away = dir();
		const other = dir();
		writeFileSync(join(away, "a.txt"), "x\n");
		linkSync(join(away, "a.txt"), join(other, "b.txt"));
		const { opts } = world({ added: [], outside: "allow" });
		expect((await readFileTool(opts).execute({ path: join(away, "a.txt") }, CTX)).content).toContain("hard links");
	});
});

describe("the primary does not change", () => {
	it("a stop path inside the primary keeps today's behaviour, and walks stay relative", async () => {
		const { opts, primary } = world({ added: [], outside: "allow" }, []);
		const inner = join(primary, "keys");
		mkdirSync(inner);
		writeFileSync(join(inner, "k.txt"), "needle\n");
		mkdirSync(join(primary, ".git"));
		const stopped = { ...opts, stopRoots: [inner] };
		expect(await readFileTool(stopped).execute({ path: "keys/k.txt" }, CTX)).toMatchObject({ isError: false });
		const w = await writeFileTool(stopped).execute({ path: ".git/hook", content: "x", expectedRevision: "absent" } as never, CTX);
		expect(w).toMatchObject({ isError: false });
		const found = await searchTextTool(stopped).execute({ pattern: "needle" }, CTX);
		expect(found.content).toContain(join("keys", "k.txt"));
		expect(found.content).not.toContain(primary);
	});

	it("with no access option the tools refuse exactly as before", async () => {
		const primary = dir();
		const away = dir();
		writeFileSync(join(away, "a.txt"), "x\n");
		const r = await readFileTool({ workspaceRoot: primary }).execute({ path: join(away, "a.txt") }, CTX);
		expect(r.content).toContain("absolute path outside the workspace");
	});
});

describe("the review's cases (M5, M6)", () => {
	it("an added folder replaced by a symlink grants nothing until it is added again", async () => {
		const added = dir();
		const away = dir();
		writeFileSync(join(away, "secret.txt"), "s\n");
		const { opts } = world({ added: [added], outside: "deny" });
		renameSync(added, `${added}-old`);
		symlinkSync(away, added);
		const r = await readFileTool(opts).execute({ path: join(added, "secret.txt") }, CTX);
		expect(r.content).toContain("[path denied]");
	});

	it("a folder swapped for a symlink to a stop path between the check and the commit: nothing is written there", async () => {
		const away = dir();
		const stop = dir();
		const work = join(away, "work");
		mkdirSync(work);
		writeFileSync(join(work, "f.txt"), "x\n");
		writeFileSync(join(stop, "f.txt"), "x\n");
		const rev = `rev:${createHash("sha256").update("x\n").digest("hex").slice(0, 16)}`;
		const swap = () => (renameSync(work, `${work}-old`), symlinkSync(stop, work), rev);
		const opts = { workspaceRoot: dir(), access: () => ({ added: [], outside: "allow" as const }), stopRoots: [stop], observedRevision: swap };
		const before = statSync(stop).mtimeMs;
		const w = await writeFileTool(opts).execute({ path: join(work, "f.txt"), content: "changed\n" } as never, CTX);
		expect(w.isError).toBe(true);
		expect(readFileSync(join(stop, "f.txt"), "utf8")).toBe("x\n");
		// not even a temporary file was created and removed there: the folder's own entry list never changed (the review's M7)
		expect(readdirSync(stop)).toEqual(["f.txt"]);
		expect(statSync(stop).mtimeMs).toBe(before);
	});

	it("the same holds for edit_file", async () => {
		const away = dir();
		const stop = dir();
		const work = join(away, "work");
		mkdirSync(work);
		writeFileSync(join(work, "f.txt"), "x\n");
		writeFileSync(join(stop, "f.txt"), "x\n");
		const rev = `rev:${createHash("sha256").update("x\n").digest("hex").slice(0, 16)}`;
		const swap = () => (renameSync(work, `${work}-old`), symlinkSync(stop, work), rev);
		const opts = { workspaceRoot: dir(), access: () => ({ added: [], outside: "allow" as const }), stopRoots: [stop], observedRevision: swap };
		const before = statSync(stop).mtimeMs;
		const e = await editFileTool(opts).execute({ path: join(work, "f.txt"), edits: [{ oldText: "x", newText: "y" }] } as never, CTX);
		expect(e.isError).toBe(true);
		expect(readdirSync(stop)).toEqual(["f.txt"]);
		expect(statSync(stop).mtimeMs).toBe(before);
	});
});
