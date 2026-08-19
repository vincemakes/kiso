/**
 * WR-1E2 — the multi-hunk transactional edit (the frozen RED matrix).
 *
 * The law is unchanged: an existing-file mutation cites an observed
 * content state; the state is checked before effect and revalidated
 * before publish. What changes is the SHAPE: one expectedRevision, N
 * disjoint hunks, one postimage, one atomic publish, one new token.
 *
 * Hunk semantics (P0, frozen before GREEN): every hunk resolves
 * against the SAME snapshot expectedRevision validated — never against
 * earlier hunks' output. First-occurrence literal match per hunk; all
 * spans determined before staging; overlaps refuse (duplicate searches
 * both resolve first-occurrence and therefore overlap — never silently
 * retargeted). Shape errors (mixed forms, empty, >32) are
 * invalid_input; world errors (missing pattern, stale) are
 * precondition. No partial postimage is ever published.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editFileTool } from "../src/index.js";
import type { ToolResult } from "@vincemakes/kiso-core";

const kindOf = (r: ToolResult): string | undefined => (r.isError ? r.errorKind : undefined);
const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;
const ORIGINAL = "alpha one\nbeta two\ngamma three\n";

function ws(): { root: string; edit: ReturnType<typeof editFileTool> } {
	const root = mkdtempSync(join(tmpdir(), "kiso-wr1e2-"));
	writeFileSync(join(root, "f.ts"), ORIGINAL);
	return { root, edit: editFileTool({ workspaceRoot: root }) };
}

describe("WR-1E2 — one snapshot, N disjoint hunks, one publish", () => {
	it("① two disjoint hunks: ONE publish, both changes present, one NEW token returned", async () => {
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha", replace: "ALPHA" }, { search: "gamma", replace: "GAMMA" }] },
			undefined as never,
		);
		expect(r.isError).toBe(false);
		const after = readFileSync(join(root, "f.ts"), "utf8");
		expect(after).toBe("ALPHA one\nbeta two\nGAMMA three\n");
		expect(r.content.trimEnd().endsWith(`[${rev(after)}]`)).toBe(true); // ONE new token, of the postimage
	});

	it("② a later hunk missing → precondition NAMING it; the file is byte-identical", async () => {
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha", replace: "A" }, { search: "NOPE", replace: "B" }] },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("hunk 2");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("③ the FIRST hunk missing → same refusal, file intact", async () => {
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "NOPE", replace: "A" }, { search: "beta", replace: "B" }] },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("hunk 1");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("④ overlapping spans refuse — duplicate searches both resolve FIRST occurrence, never a silent retarget", async () => {
		const { root, edit } = ws();
		const dup = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha", replace: "A" }, { search: "alpha", replace: "B" }] },
			undefined as never,
		);
		expect(kindOf(dup)).toBe("precondition");
		expect(dup.content).toContain("overlap");
		const cross = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha one", replace: "X" }, { search: "one\nbeta", replace: "Y" }] },
			undefined as never,
		);
		expect(kindOf(cross)).toBe("precondition");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("⑤ stale expectedRevision refuses BEFORE any hunk classification", async () => {
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev("SOMETHING ELSE"), edits: [{ search: "NOPE", replace: "A" }] },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("changed since");
		expect(r.content).not.toContain("hunk");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("⑧ the legacy single-hunk form is byte/semantic-compatible", async () => {
		const { root, edit } = ws();
		const r = await edit.execute({ path: "f.ts", search: "beta", replace: "BETA", expectedRevision: rev(ORIGINAL) }, undefined as never);
		expect(r.isError).toBe(false);
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("alpha one\nBETA two\ngamma three\n");
	});

	it("⑨ mixing the single form with edits[] is invalid_input — the SHAPE is wrong, not the world", async () => {
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", search: "alpha", replace: "A", expectedRevision: rev(ORIGINAL), edits: [{ search: "beta", replace: "B" }] } as never,
			undefined as never,
		);
		expect(kindOf(r)).toBe("invalid_input");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("⑩ edits: [] and edits > 32 are invalid_input, zero effect", async () => {
		const { root, edit } = ws();
		const empty = await edit.execute({ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [] } as never, undefined as never);
		expect(kindOf(empty)).toBe("invalid_input");
		const many = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: Array.from({ length: 33 }, (_, i) => ({ search: `s${i}`, replace: "x" })) } as never,
			undefined as never,
		);
		expect(kindOf(many)).toBe("invalid_input");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("the postimage is deterministic under out-of-order hunks (applied by descending offset)", async () => {
		const { root, edit } = ws();
		// hunks given in REVERSE document order — the result must not depend
		// on argument order, only on resolved spans
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "gamma", replace: "G" }, { search: "alpha", replace: "A" }] },
			undefined as never,
		);
		expect(r.isError).toBe(false);
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("A one\nbeta two\nG three\n");
	});
});
