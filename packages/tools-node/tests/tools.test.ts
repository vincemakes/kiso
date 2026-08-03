/**
 * The coding tools, pinned: bound to a workspace root (Area 5), reads are
 * idempotent, writes are side effects, shell runs/times out/kills trees.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@kiso/core";
import {
	createCodingTools,
	editFileTool,
	listDirTool,
	readFileTool,
	searchTextTool,
	shellTool,
	writeFileTool,
} from "../src/index.js";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
};

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "kiso-tools-"));
}

const denied = (result: { isError: boolean; errorKind?: string; content: string }) =>
	result.isError === true && result.errorKind === "precondition";

describe("read / list / search", () => {
	it("write then read round-trips within the workspace", async () => {
		const root = tempRoot();
		const target = join(root, "a.txt");
		await writeFileTool({ workspaceRoot: root }).execute({ path: "a.txt", content: "hello kiso" }, CTX);
		const read = await readFileTool({ workspaceRoot: root }).execute({ path: "a.txt" }, CTX);
		expect(read).toMatchObject({ content: "hello kiso", isError: false });
		expect(readFileSync(target, "utf8")).toBe("hello kiso");
	});

	it("list_dir shows entries with type prefixes", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "file.txt"), "x");
		const listed = await listDirTool({ workspaceRoot: root }).execute({ path: "." }, CTX);
		expect(listed.content).toContain("file file.txt");
	});

	it("search_text finds a pattern with file:line anchors", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "src.ts"), "const answer = 42;\n");
		const found = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "answer", path: "." }, CTX);
		expect(found).toMatchObject({ isError: false });
		expect(found.content).toContain("src.ts:1:");
	});
});

describe("edit / shell", () => {
	it("edit_file replaces only the first occurrence", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "a.txt"), "one one two", "utf8");
		await editFileTool({ workspaceRoot: root }).execute({ path: "a.txt", search: "one", replace: "ONE" }, CTX);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("ONE one two");
	});

	it("edit_file reports a missing pattern as invalid_input, not a crash", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "a.txt"), "hello", "utf8");
		const result = await editFileTool({ workspaceRoot: root }).execute({ path: "a.txt", search: "absent", replace: "x" }, CTX);
		expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
	});

	it("shell runs a command with the workspace as cwd", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "marker.txt"), "here", "utf8");
		const result = await shellTool({ workspaceRoot: root }).execute({ command: "ls marker.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("marker.txt");
	});

	it("shell reports non-zero exits as errors", async () => {
		const root = tempRoot();
		const result = await shellTool({ workspaceRoot: root }).execute({ command: "exit 3" }, CTX);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toContain("exit 3");
	});

	it("shell times out a runaway command", async () => {
		const root = tempRoot();
		const result = await shellTool({ workspaceRoot: root }).execute({ command: "sleep 5", timeoutMs: 200 }, CTX);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toMatch(/timed out/);
	});

	it("shell timeout kills the WHOLE process tree, including backgrounded children", async () => {
		const root = tempRoot();
		const pidFile = join(root, "child.pid");
		const result = await shellTool({ workspaceRoot: root }).execute(
			{ command: `sh -c 'sleep 30 & echo $! > ${pidFile}; wait'`, timeoutMs: 300 },
			CTX,
		);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toMatch(/timed out/);
		const childPid = readFileSync(pidFile, "utf8").trim();
		const alive = spawnSync("ps", ["-p", childPid, "-o", "pid="]).stdout.toString().trim();
		expect(alive).toBe("");
	});
});

describe("workspace boundary (Area 5)", () => {
	it("absolute paths are refused — /etc/hosts never readable", async () => {
		const root = tempRoot();
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "/etc/hosts" }, CTX);
		expect(denied(result)).toBe(true);
		expect(result.content).toMatch(/absolute|denied/i);
	});

	it(".. escapes are refused for reads", async () => {
		const root = tempRoot();
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "../outside.txt" }, CTX);
		expect(denied(result)).toBe(true);
	});

	it(".. escapes are refused for writes (the file is never created)", async () => {
		const root = tempRoot();
		const outside = join(dirname(root), "escaped.txt");
		const result = await writeFileTool({ workspaceRoot: root }).execute({ path: "../escaped.txt", content: "x" }, CTX);
		expect(denied(result)).toBe(true);
		expect(existsSync(outside)).toBe(false);
	});

	it("a symlink inside the workspace pointing outside is refused", async () => {
		const root = tempRoot();
		symlinkSync("/etc", join(root, "etc-link"));
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "etc-link/hosts" }, CTX);
		expect(denied(result)).toBe(true);
	});

	it("a symlinked FILE pointing outside is refused", async () => {
		const root = tempRoot();
		symlinkSync("/etc/hosts", join(root, "hosts-link"));
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "hosts-link" }, CTX);
		expect(denied(result)).toBe(true);
	});

	it("a nested directory inside the workspace still works (no false positives)", async () => {
		const root = tempRoot();
		const nested = join(root, "deep", "deeper");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "x.txt"), "nested", "utf8");
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "deep/deeper/x.txt" }, CTX);
		expect(result).toMatchObject({ content: "nested", isError: false });
	});

	it("the toolset registers without collisions and is bound to one root", async () => {
		const root = tempRoot();
		const tools = createCodingTools({ workspaceRoot: root });
		const names = new Set(tools.map((t) => t.name));
		expect(names.size).toBe(tools.length);
	});
});
