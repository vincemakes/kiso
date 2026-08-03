/**
 * The coding tools, pinned: read/list/search are idempotent reads; write is
 * a side effect; shell runs, times out, and reports exit codes.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type ToolContext } from "@kiso/core";
import {
	CODING_TOOLS,
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

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-tools-"));
}

describe("read / list / search", () => {
	it("write then read round-trips", async () => {
		const dir = tempDir();
		const target = join(dir, "a.txt");
		await writeFileTool().execute({ path: target, content: "hello kiso" }, CTX);
		const read = await readFileTool().execute({ path: target }, CTX);
		expect(read).toMatchObject({ content: "hello kiso", isError: false });
	});

	it("list_dir shows entries with type prefixes", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "file.txt"), "x");
		const listed = await listDirTool().execute({ path: dir }, CTX);
		expect(listed.content).toContain("file file.txt");
	});

	it("search_text finds a pattern with file:line anchors", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "src.ts"), "const answer = 42;\n");
		const found = await searchTextTool().execute({ pattern: "answer", path: dir }, CTX);
		expect(found).toMatchObject({ isError: false });
		expect(found.content).toContain("src.ts:1:");
	});
});

describe("edit / shell", () => {
	it("edit_file replaces only the first occurrence", async () => {
		const dir = tempDir();
		const target = join(dir, "a.txt");
		writeFileSync(target, "one one two", "utf8");
		await editFileTool().execute({ path: target, search: "one", replace: "ONE" }, CTX);
		expect(readFileSync(target, "utf8")).toBe("ONE one two");
	});

	it("edit_file reports a missing pattern as invalid_input, not a crash", async () => {
		const dir = tempDir();
		const target = join(dir, "a.txt");
		writeFileSync(target, "hello", "utf8");
		const result = await editFileTool().execute({ path: target, search: "absent", replace: "x" }, CTX);
		expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
	});

	it("shell runs a command and reports its stdout", async () => {
		const result = await shellTool().execute({ command: "echo hello-from-shell" }, CTX);
		expect(result).toMatchObject({ content: "hello-from-shell", isError: false });
	});

	it("shell reports non-zero exits as errors", async () => {
		const result = await shellTool().execute({ command: "exit 3" }, CTX);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toContain("exit 3");
	});

	it("shell times out a runaway command", async () => {
		const result = await shellTool().execute({ command: "sleep 5", timeoutMs: 200 }, CTX);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toMatch(/timed out/);
	});

	it("shell timeout kills the WHOLE process tree, including backgrounded children", async () => {
		// A command that backgrounds a child and keeps the parent alive.
		const result = await shellTool().execute(
			{ command: "sh -c 'sleep 30 & echo $! > /tmp/kiso-child.pid; wait'", timeoutMs: 300 },
			CTX,
		);
		expect(result).toMatchObject({ isError: true });
		expect(result.content).toMatch(/timed out/);
		// The backgrounded child must be dead too — not just the outer shell.
		const childPid = readFileSync("/tmp/kiso-child.pid", "utf8").trim();
		const alive = spawnSync("ps", ["-p", childPid, "-o", "pid="]).stdout.toString().trim();
		expect(alive).toBe("");
	});
});

it("the exported toolset registers without name collisions", () => {
	const names = new Set(CODING_TOOLS.map((t) => t.name));
	expect(names.size).toBe(CODING_TOOLS.length);
});
