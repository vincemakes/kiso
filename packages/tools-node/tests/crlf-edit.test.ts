/**
 * Windows P3 — edit_file keeps a file's line endings.
 *
 * A file saved with CRLF line endings (the Windows default, and common in
 * any repository touched there) met a model whose search text uses LF:
 * every multi-line hunk read "pattern not found". edit_file now matches a
 * uniformly CRLF file on its LF form and writes CRLF back, so the file's
 * endings never change under an edit. A file that mixes the two keeps the
 * exact matching it always had — normalizing it would rewrite lines the
 * edit never touched. LF files are unchanged. Runs on every OS.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@vincemakes/kiso-core";
import { editFileTool } from "../src/index.js";

const CTX = { signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} } } as unknown as ToolContext;
const revOf = (p: string): string => `rev:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`;

function file(content: string): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "kiso-crlf-"));
	writeFileSync(join(root, "f.txt"), content);
	return { root, path: join(root, "f.txt") };
}

async function edit(root: string, path: string, args: Record<string, unknown>) {
	return editFileTool({ workspaceRoot: root }).execute({ path: "f.txt", expectedRevision: revOf(path), ...args } as never, CTX);
}

describe("edit_file on a CRLF file", () => {
	it("an LF search spanning lines matches, and the file stays CRLF", async () => {
		const { root, path } = file("one\r\ntwo\r\nthree\r\n");
		const r = await edit(root, path, { search: "one\ntwo", replace: "ONE\nTWO\nextra" });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("ONE\r\nTWO\r\nextra\r\nthree\r\n");
	});

	it("a search copied with its CRLF matches too", async () => {
		const { root, path } = file("one\r\ntwo\r\nthree\r\n");
		const r = await edit(root, path, { search: "two\r\nthree", replace: "2\r\n3" });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("one\r\n2\r\n3\r\n");
	});

	it("hunks apply in order on the LF form, and the result is CRLF", async () => {
		const { root, path } = file("a\r\nb\r\nc\r\nd\r\n");
		const r = await edit(root, path, { edits: [{ search: "a\nb", replace: "A\nB" }, { search: "B\nc", replace: "B\nC" }] });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("A\r\nB\r\nC\r\nd\r\n");
	});
});

describe("unchanged elsewhere (guards)", () => {
	it("an LF file: the edit is exact, and stays LF", async () => {
		const { root, path } = file("one\ntwo\nthree\n");
		const r = await edit(root, path, { search: "one\ntwo", replace: "ONE\nTWO" });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("ONE\nTWO\nthree\n");
	});

	it("a single-line edit in a CRLF file", async () => {
		const { root, path } = file("one\r\ntwo\r\n");
		const r = await edit(root, path, { search: "two", replace: "2" });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("one\r\n2\r\n");
	});

	it("a file that mixes CRLF and LF keeps exact matching — no line it did not touch changes", async () => {
		const { root, path } = file("a\r\nb\nc\r\n");
		expect((await edit(root, path, { search: "a\nb", replace: "x" })).isError).toBe(true);
		const r = await edit(root, path, { search: "a\r\nb", replace: "A\r\nB" });
		expect(r.isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("A\r\nB\nc\r\n");
	});
});
