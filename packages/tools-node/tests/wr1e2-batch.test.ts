/**
 * WR-1E2 — the multi-hunk transactional edit (the frozen RED matrix).
 *
 * The law is unchanged: an existing-file mutation cites an observed
 * content state; the state is checked before effect and revalidated
 * before publish. What changes is the SHAPE: one expectedRevision, N
 * disjoint hunks, one postimage, one atomic publish, one new token.
 *
 * Hunk semantics (P0, frozen before GREEN; ACI-3 supersedes the first
 * sentence): every hunk resolves against the SAME snapshot
 * expectedRevision validated — never against earlier hunks' output.
 * Since ACI-3 the hunks apply IN ORDER, each against the result of the
 * ones before it, still all or nothing. Exactly-once literal match per hunk (ACI-2); all
 * spans determined before staging; overlaps refuse (duplicate searches
 * both resolve to that same one place and therefore overlap — never silently
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

	it("④ a duplicate search never silently retargets — after hunk 1 its text is gone, and the call refuses whole", async () => {
		// ACI-3 (declared): hunks now apply IN ORDER, so the duplicate is
		// refused because hunk 2 no longer finds "alpha" — not as an
		// "overlap" against one snapshot. Still nothing is written.
		const { root, edit } = ws();
		const dup = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha", replace: "A" }, { search: "alpha", replace: "B" }] },
			undefined as never,
		);
		expect(kindOf(dup)).toBe("precondition");
		expect(dup.content.split("\n")[0]).toContain("(hunk 2, matched after hunk 1) — nothing was written, f.ts is unchanged");
		const cross = await edit.execute(
			{ path: "f.ts", expectedRevision: rev(ORIGINAL), edits: [{ search: "alpha one", replace: "X" }, { search: "one\nbeta", replace: "Y" }] },
			undefined as never,
		);
		expect(kindOf(cross)).toBe("precondition");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe(ORIGINAL);
	});

	it("⑤ a stale expectedRevision refuses FIRST — the staleness is the headline, and nothing is applied", async () => {
		// ACI-3 (declared): below the headline the refusal now reports where
		// each hunk stands in the file as it is — reported, never applied.
		const { root, edit } = ws();
		const r = await edit.execute(
			{ path: "f.ts", expectedRevision: rev("SOMETHING ELSE"), edits: [{ search: "NOPE", replace: "A" }] },
			undefined as never,
		);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content.split("\n")[0]).toContain("changed since");
		expect(r.content.split("\n")[0]).not.toContain("hunk");
		expect(r.content).toContain("hunk 1: not found");
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
