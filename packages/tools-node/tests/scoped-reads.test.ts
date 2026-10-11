/**
 * the token round — the scoped-read discipline: read_file's range parameters and
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listDirTool, readFileTool, searchTextTool, shellTool } from "../src/index.js";
// WR-1: reads now end with the revision trailer; these helpers strip it
// for byte-identity pins and compute a citation for existing files.
const stripRev = (s: string): string => s.replace(/\n\[rev:[0-9a-f]{16}\]$/, "");
const revOf = (p: string): string => `rev:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;


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
		expect(stripRev(result.content)).toBe(`line 1\n${Array.from({ length: 199 }, (_, i) => `line ${i + 2}`).join("\n")}\n`);
		expect(result.content).not.toContain("more lines");
	});

	// The read-window correctness fix. The default window used to apply only
	// when BOTH offset and limit were absent, so `offset` alone read to the
	// END OF FILE — and the continuation note named only `offset`, so a model
	// following its own note literally defeated the window from the second
	// read onward. Measured before the fix: 7.3% of real reads and 11.5% of
	// bench reads took that path, returning a median of 207 lines and a
	// maximum of 759.
	it("offset WITHOUT limit takes the default window, not the rest of the file", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 1000);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 101 }, CTX);
		expect(result).toMatchObject({ isError: false });
		const body = stripRev(result.content).split("\n… ")[0]!;
		expect(body.split("\n").filter((l) => l !== "")).toHaveLength(200);
		expect(body.startsWith("line 101\n")).toBe(true);
		expect(body).toContain("line 300");
		expect(body).not.toContain("line 301");
	});

	it("the continuation note names BOTH parameters, and its offset is the true next line", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 1000);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 101 }, CTX);
		expect(result.content).toContain("… 700 more lines (call again with offset=301 limit=200)");
		// the note's own offset must be the next UNREAD line, not an estimate
		const next = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 301 }, CTX);
		expect(stripRev(next.content).startsWith("line 301\n")).toBe(true);
	});

	it("the default window is also cut at 16k chars, and never mid-line", async () => {
		const root = tempRoot();
		// 200 lines of 200 chars is 40k — the char budget binds before the line budget
		const wide = Array.from({ length: 400 }, (_, i) => `${i + 1}:${"x".repeat(198)}`).join("\n") + "\n";
		writeFileSync(join(root, "wide.txt"), wide, "utf8");
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "wide.txt" }, CTX);
		const body = stripRev(result.content).split("\n… ")[0]!;
		expect(body.length).toBeLessThanOrEqual(16_000);
		// every delivered line is whole: each starts with its own number and is full width
		for (const line of body.split("\n").filter((l) => l !== "")) {
			// whole lines only: the full run of x's must be present, and the
			// width varies with the line number's digits, so the PATTERN is
			// the assertion, not a fixed length.
			expect(line).toMatch(/^\d+:x{198}$/);
		}
		const shown = body.split("\n").filter((l) => l !== "").length;
		expect(shown).toBeLessThan(200);
		expect(result.content).toContain(`(call again with offset=${shown + 1} limit=200)`);
	});

	it("a large file defaults to the head 200 lines + the continuation note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 1");
		expect(result.content).toContain("line 200");
		expect(result.content).not.toContain("line 201");
		expect(result.content).toContain("… 50 more lines (call again with offset=201 limit=200)");
	});

	it("the note is singular for exactly one remaining line", async () => {
		const root = tempRoot();
		writeLines(root, "edge.txt", 201);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "edge.txt" }, CTX);
		expect(result.content).toContain("… 1 more line (call again with offset=201 limit=200)");
	});

	it("offset/limit reads an exact range with its own continuation note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201, limit: 20 }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 201");
		expect(result.content).toContain("line 220");
		expect(result.content).not.toContain("line 221");
		expect(result.content).toContain("… 30 more lines (call again with offset=221 limit=20)");
	});

	it("a range to EOF has no note", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("line 250");
		expect(result.content).not.toContain("more lines");
	});

	// The schema is the contract the model reads: it said "default: to the
	// end of the file" while the tool reads the bounded window above (red:
	// the old description).
	it("the limit's schema description names the bounded default, never the end of the file", () => {
		const limit = (readFileTool({ workspaceRoot: tempRoot() }).parameters as { properties: { limit: { description: string } } }).properties.limit;
		expect(limit.description).not.toMatch(/end of the file/i);
		expect(limit.description).toMatch(/default bounded window/i);
	});

	it("offset alone and limit alone work (tail and head forms)", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		// `offset` alone is a WINDOW from that line, not a read to EOF: here
		// only 50 lines remain, so the window ends at the file and says so by
		// carrying no note.
		const tail = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		expect(tail.content).toContain("line 201");
		expect(tail.content).toContain("line 250");
		expect(tail.content).not.toContain("more lines");
		const head = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", limit: 100 }, CTX);
		expect(head.content).toContain("line 100");
		expect(head.content).toContain("… 150 more lines (call again with offset=101 limit=100)");
	});

	it("two segment reads reconstruct the full file (the model's path to the whole)", async () => {
		const root = tempRoot();
		writeLines(root, "big.txt", 250);
		const first = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt" }, CTX);
		const second = await readFileTool({ workspaceRoot: root }).execute({ path: "big.txt", offset: 201 }, CTX);
		const joined = `${stripRev(first.content).split("\n… ")[0]}\n${stripRev(second.content).split("\n… ")[0]}`;
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
		// 210 lines x 600 chars. The DEFAULT window would stop at 16000 chars
		// long before the 100000 output cap, so the cap is now reached only
		// through an explicit `limit` — which is the contract: an explicit
		// limit is honoured as given, and the output cap is what bounds it.
		writeFileSync(
			join(root, "fat.txt"),
			Array.from({ length: 210 }, (_, i) => `x`.repeat(600)).join("\n") + "\n",
			"utf8",
		);
		const result = await readFileTool({ workspaceRoot: root }).execute({ path: "fat.txt", limit: 200 }, CTX);
		expect(result).toMatchObject({ isError: false });
		// 166 lines × 601 chars fit under the cap (the 167th starts past it):
		// the cut lands on a line boundary and names the exact continuation.
		expect(result.content).toContain("… [output capped at 100000 chars — continue with offset=167]");
		// The file-level note follows — both continuations are in the result.
		expect(result.content).toContain("… 10 more lines (call again with offset=201 limit=200)");
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
		expect(result.content).toContain("… 50 of 60 matches shown (narrow the pattern for more)");
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
		expect(result.content).toContain("… 200 of 210 entries shown (narrow to a subdirectory for more)");
	});

	it("≤ 200 entries: no note", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "a.txt"), "x", "utf8");
		const result = await listDirTool({ workspaceRoot: root }).execute({ path: "." }, CTX);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toBe("file a.txt");
	});
});

describe("shell output cap (R-C item 2)", () => {
	it("overflow states WHAT was dropped (exact byte count) and the recovery path", async () => {
		const root = tempRoot();
		const result = await shellTool({ workspaceRoot: root }).execute(
			{ command: `node -e "process.stdout.write('x'.repeat(120000))"` },
			CTX,
		);
		expect(result).toMatchObject({ isError: false });
		expect(result.content).toContain("stdout capped at 100000 chars");
		expect(result.content).toContain("— 20000 more chars dropped");
		expect(result.content).toContain("capture to a file and read it with read_file, or narrow the command");
		// the retained prefix is intact — the note is appended, not substituted.
		expect(result.content.startsWith("x".repeat(100_000))).toBe(true);
	});

	it("a quiet command gets no note", async () => {
		const root = tempRoot();
		const result = await shellTool({ workspaceRoot: root }).execute({ command: "echo done" }, CTX);
		expect(result).toMatchObject({ isError: false, content: "done" });
	});
});
