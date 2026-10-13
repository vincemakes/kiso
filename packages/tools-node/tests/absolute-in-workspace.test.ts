/**
 * An absolute path that lies inside the workspace is the workspace-relative
 * path it names. Models write absolute paths constantly (the TB20
 * trajectory audit found the refusal in 13 of 14 tasks, each costing a
 * retry); the refusal protected nothing, since the same file was reachable
 * by its relative name. The boundary itself is unchanged: a path outside
 * the root, a `..` that leaves it, a symlink whose target leaves it, and a
 * protected file are all refused as before.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { editFileTool, listDirTool, readFileTool, resolveWithinRoot, searchTextTool, writeFileTool } from "../src/index.js";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
};

/** tmpdir() is a symlinked path on macOS (/var → /private/var), so the
 *  root as written and the root as it resolves are both exercised. */
function workspace(): { written: string; real: string } {
	const written = mkdtempSync(join(tmpdir(), "kiso-abs-"));
	mkdirSync(join(written, "src"));
	writeFileSync(join(written, "src", "a.txt"), "alpha\nneedleABS\n", "utf8");
	return { written, real: realpathSync(written) };
}

describe("an absolute path inside the workspace is admitted", () => {
	it("read_file reads it, by the root as written and as it resolves", async () => {
		const { written, real } = workspace();
		for (const base of [written, real]) {
			const r = await readFileTool({ workspaceRoot: written }).execute({ path: join(base, "src", "a.txt") }, CTX);
			expect(r.isError).toBe(false);
			expect(r.content).toContain("needleABS");
		}
	});

	it("write_file creates the file in the workspace", async () => {
		const { written, real } = workspace();
		const r = await writeFileTool({ workspaceRoot: written }).execute({ path: join(real, "src", "new.txt"), content: "fresh" }, CTX);
		expect(r.isError).toBe(false);
		expect(readFileSync(join(real, "src", "new.txt"), "utf8")).toBe("fresh");
	});

	it("edit_file edits it", async () => {
		const { written, real } = workspace();
		const expectedRevision = `rev:${createHash("sha256").update(readFileSync(join(real, "src", "a.txt"))).digest("hex").slice(0, 16)}`;
		const r = await editFileTool({ workspaceRoot: written }).execute({ path: join(real, "src", "a.txt"), edits: [{ oldText: "alpha", newText: "beta" }], expectedRevision }, CTX);
		expect(r.isError).toBe(false);
		expect(readFileSync(join(real, "src", "a.txt"), "utf8")).toBe("beta\nneedleABS\n");
	});

	it("list_dir and search_text take it, and the root itself", async () => {
		const { written, real } = workspace();
		const ls = await listDirTool({ workspaceRoot: written }).execute({ path: real }, CTX);
		expect(ls.isError).toBe(false);
		expect(ls.content).toContain("src");
		const hits = await searchTextTool({ workspaceRoot: written }).execute({ pattern: "needleABS", path: join(real, "src") }, CTX);
		expect(hits.isError).toBe(false);
		expect(hits.content).toContain("src/a.txt:2:");
	});

	it("resolves to the same canonical path as the relative name", () => {
		const { written, real } = workspace();
		expect(resolveWithinRoot(written, join(written, "src", "a.txt"))).toBe(resolveWithinRoot(written, "src/a.txt"));
		expect(resolveWithinRoot(written, real)).toBe(real);
	});
});

describe("the boundary is unchanged", () => {
	it("an absolute path outside the workspace is refused, and the refusal names the root", async () => {
		const { written, real } = workspace();
		const r = await readFileTool({ workspaceRoot: written }).execute({ path: "/etc/hosts" }, CTX);
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(r.content).toContain("absolute path outside the workspace: /etc/hosts");
		expect(r.content).toContain(`the workspace root is ${real}`);
	});

	it("a sibling directory sharing the root's prefix is outside", async () => {
		const { written } = workspace();
		mkdirSync(`${written}-twin`);
		writeFileSync(join(`${written}-twin`, "x.txt"), "twin", "utf8");
		const r = await readFileTool({ workspaceRoot: written }).execute({ path: join(`${written}-twin`, "x.txt") }, CTX);
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
	});

	it("an absolute path that leaves through `..` is refused", async () => {
		const { written } = workspace();
		const r = await writeFileTool({ workspaceRoot: written }).execute({ path: `${written}/src/../../escape.txt`, content: "x" }, CTX);
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
	});

	it("an absolute path through a symlink whose target leaves the workspace is refused", async () => {
		const { written, real } = workspace();
		const outside = mkdtempSync(join(tmpdir(), "kiso-abs-out-"));
		writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
		symlinkSync(outside, join(real, "link"));
		const r = await readFileTool({ workspaceRoot: written }).execute({ path: join(real, "link", "secret.txt") }, CTX);
		expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
		expect(r.content).not.toContain("secret\n");
	});

	it("a protected file is refused by its absolute path as by its relative one", async () => {
		const { written, real } = workspace();
		const store = join(real, "creds.json");
		writeFileSync(store, "{}", "utf8");
		const opts = { workspaceRoot: written, protectedFiles: [store] };
		for (const path of [store, "creds.json"]) {
			const r = await readFileTool(opts).execute({ path }, CTX);
			expect(r).toMatchObject({ isError: true, errorKind: "precondition" });
		}
	});
});
