/**
 * Token 轮 — the scoped-read discipline: read_file's range parameters and
 * the default head-200 with an ACTIONABLE continuation note, search_text's
 * 50-match cap with the honest total, list_dir's 200-entry cap. The red
 * line: every truncation names its continuation; determinism (same input +
 * same file state → same bytes) is asserted per tool.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { listDirTool, readFileTool, searchTextTool } from "../src/index.js";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
};

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "kiso-scope-"));
}

/** A deterministic multi-line file: line i (1-based) is "line <i>". */
function writeLines(root: string, name: string, n: number): void {
	const body = Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
	writeFileSync(join(root, name), `${body}\n`, "utf8");
}

describe("read_file scoped reads", () => {
	it("a small file (≤ 200 lines) reads byte-identically, no note", async () => {
		const root = tempRoot();
		writeLines(root, "small.txt", 200);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "small.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		// The verbatim file content — trailing newline included.
		expect(result.content).toBe(`line 1\n${Array.from({ length: 199 }, (_, i) => `line ${i + 2}`).join("\n")}\n`);
		expect(result.content).not.toContain("more lines");
	});

	it("a large file defaults to the head 200 lines + the continuation note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 1");
		expect(result.content).toContain("line 200");
		expect(result.content).not.toContain("line 201");
		expect(result.content).toContain("… 50 more lines (call again with offset=201)");
	});

	it("the note is singular for exactly one remaining line", async () => {
		const root = tempRoot();
		writeLines(root, "edge.txt", 201);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "edge.txt" }, CTX);
		expect(result.content).toContain("… 1 more line (call again with offset=201)");
	});

	it("offset/limit reads an exact range with its own continuation note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201, limit: 20 }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 201");
		expect(result.content).toContain("line 220");
		expect(result.content).not.toContain("line 221");
		expect(result.content).toContain("… 30 more lines (call again with offset=221)");
	});

	it("a range to EOF has no note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 250");
		expect(result.content).not.toContain("more lines");
	});

	it("offset alone and limit alone work (tail and head forms)", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const tail = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		expect(tail.content).toContain("line 201");
		const head = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", limit: 100 }, CTX);
		expect(head.content).toContain("line 100");
		expect(head.content).toContain("… 150 more lines (call again with offset=101)");
	});

	it("two segment reads reconstruct the full file (the model's path to the whole)", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const first = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		const second = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		const joined = `${first.content.split("\n… ")[0]}\n${second.content.split("\n… ")[0]}`;
		expect(joined).toBe(`line 1\n${Array.from({ length: 249 }, (_, i) => `line ${i + 2}`).join("\n")}`);
	});

	it("offset past the end is an honest invalid_input naming the line count", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 251 }, CTX);
		expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
		expect(result.content).toContain("offset=251 is past the end");
		expect(result.content).toContain("250 lines");
	});

	it("non-positive or non-integer offsets/limits are invalid_input", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		for (const input of [
			{ path: "big.txt", offset: 0 },
			{ path: "big.txt", limit: -1 },
			{ path: "big.txt", offset: 1.5 },
			{ path: "big.txt", limit: 2.5 },
		]) {
			const result = await readFileTool({ workspaceRoot: root }).execute(input as never, CTX);
			expect(result).toMatchObject({ isError: true, errorKind: "invalid_input" });
		}
	});

	it("deterministic: identical input + file state → byte-identical output", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const a = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		const b = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		expect(a.content).toBe(b.content);
	});

	it("the output-char cap cuts at a line boundary and names the next offset", async () => {
		const root = tempRoot();
		// 210 lines × 600 chars — the head-200 default exceeds the 100000 cap.
		writeFileSync(
			join(root, "fat.txt"),
			Array.from({ length: 210 }, (_, i) => `x`.repeat(600)).join("\n") + "\n",
			"utf8",
		);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "fat.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		// 166 lines × 601 chars fit under the cap (the 167th starts past it):
		// the cut lands on a line boundary and names the exact continuation.
		expect(result.content).toContain("… [output capped at 100000 chars — continue with offset=167]");
		// The file-level note follows — both continuations are in the result.
		expect(result.content).toContain("… 10 more lines (call again with offset=201)");
	});

	it("a single line beyond the char cap is called out with the shell path (no loop)", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "huge.txt"), `y`.repeat(120_000) + "\n", "utf8");
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "huge.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("slice it with shell");
	});
});

describe("search_text capped results", () => {
	const root = tempRoot();
	// 60 matching lines across three files (20 each).
	for (let f = 0; f < 3; f++) {
		writeFileSync(
			join(root, `f${f}.txt`),
			Array.from({ length: 20 }, (_, i) => `match ${f}-${i}`).join("\n") + "\n",
			"utf8",
		);
	}

	it("shows 50 excerpts and reports the honest overflow total", async () => {
		const result = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "match", path: "." }, CTX);
		expect(result).toMatchObject({ isError: false });
		const shown = result.content.split("\n").filter((l) => /f\d\.txt:\d+: match /.test(l));
		expect(shown).toHaveLength(50);
		expect(result.content).toContain("… +10 more matches (narrow the pattern)");
	});

	it("≤ 50 matches: no note", async () => {
		const result = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "match 0-", path: "." }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("f0.txt:1:");
		expect(result.content).not.toContain("more matches");
	});

	it("deterministic: identical input + file state → byte-identical output", async () => {
		const a = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "match", path: "." }, CTX);
		const b = await searchTextTool({ workspaceRoot: root }).execute({ pattern: "match", path: "." }, CTX);
		expect(a.content).toBe(b.content);
	});
});

describe("list_dir capped entries", () => {
	it("> 200 entries: 200 shown + the overflow note", async () => {
		const root = tempRoot();
		for (let i = 0; i < 210; i++) writeFileSync(join(root, `f${i}.txt`), "x", "utf8");
		const result = await listDirTool({ workspaceRoot: root }).execute({ path: "." }, CTX);
		expect(result).toMatchObject({ isError: false });
		const shown = result.content.split("\n").filter((l) => l.startsWith("file f"));
		expect(shown).toHaveLength(200);
		expect(result.content).toContain("… +10 more entries (narrow to a subdirectory)");
	});

	it("≤ 200 entries: no note", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "a.txt"), "x", "utf8");
		const result = await listDirTool({ workspaceRoot: root }).execute({ path: "." }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toBe("file a.txt");
	});
});
