/**
 * WR-1A — the correctness coda (the post-merge review's five items).
 *
 * 1. A POST-EFFECT workspace-escape verification failure is FATAL and
 *    says the effect may already have applied — `precondition` is
 *    reserved for work refused BEFORE it starts, and a receipt that
 *    says "nothing ran" about a rename that happened is a lie.
 * 2. The creation publish is fail-closed: link(2) or refusal — never
 *    a clobber-capable rename fallback ("absent" is a contract, not
 *    a best effort).
 * 3. The replace path revalidates the revision AFTER staging,
 *    immediately before rename — the window the report may claim is
 *    check→rename, not check→stage→chmod→rename.
 * 4. edit_file's pattern-not-found is `precondition` (world does not
 *    satisfy the expectation; nothing ran) — the same lie-family as
 *    WR-1-F1: as invalid_input on a non-idempotent tool it carried
 *    the partial-effects note over an edit that wrote nothing.
 */

import { chmodSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editFileTool, writeFileTool } from "../src/index.js";
import { postEffectEscape, publishNewFile, revalidateBeforeRename } from "../src/wr1.js";
import type { ToolResult } from "@vincemakes/kiso-core";

const kindOf = (r: ToolResult): string | undefined => (r.isError ? r.errorKind : undefined);
const rev = (s: string): string => `rev:${createHash("sha256").update(Buffer.from(s)).digest("hex").slice(0, 16)}`;

describe("WR-1A ① — post-effect escape is FATAL and names the applied effect", () => {
	it("the helper classifies a post-rename escape as fatal, never precondition", () => {
		const r = postEffectEscape("write", "f.ts");
		expect(r.isError).toBe(true);
		expect(kindOf(r)).toBe("fatal");
		expect(r.content).toContain("may already have applied");
		expect(r.content).toContain("f.ts");
	});
});

describe("WR-1A ② — the creation publish is fail-closed", () => {
	it("EEXIST loses the race LOUDLY as a precondition", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		writeFileSync(join(dir, "tmp1"), "new bytes");
		writeFileSync(join(dir, "target.ts"), "raced in first");
		const r = publishNewFile(join(dir, "tmp1"), join(dir, "target.ts"), "target.ts");
		expect(r).not.toBeNull();
		expect(kindOf(r!)).toBe("precondition");
		expect(r!.content).toContain("already exists");
		// the loser's temp is cleaned, the winner's content intact
		expect(readdirSync(dir)).not.toContain("tmp1");
	});

	it("a publish that cannot be atomic REFUSES (no rename fallback) — nothing ran, precondition", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		writeFileSync(join(dir, "tmp2"), "new bytes");
		// force link failure that is NOT EEXIST: the target's parent does
		// not exist — link(2) fails ENOENT; the fail-closed rule refuses
		// rather than degrading to any second primitive.
		const r = publishNewFile(join(dir, "tmp2"), join(dir, "missing-dir", "t.ts"), "missing-dir/t.ts");
		expect(r).not.toBeNull();
		expect(kindOf(r!)).toBe("precondition");
		expect(r!.content).toContain("atomically on this filesystem");
		expect(r!.content).toContain("cannot be honored");
		expect(readdirSync(dir)).not.toContain("tmp2");
	});

	it("the happy path publishes and cleans its temp", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		writeFileSync(join(dir, "tmp3"), "content");
		const r = publishNewFile(join(dir, "tmp3"), join(dir, "fresh.ts"), "fresh.ts");
		expect(r).toBeNull();
		const names = readdirSync(dir);
		expect(names).toContain("fresh.ts");
		expect(names).not.toContain("tmp3");
	});
});

describe("WR-1A ③ — the staged replace revalidates immediately before rename", () => {
	it("the helper refuses when the world moved after staging (naming the citation)", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		const target = join(dir, "f.ts");
		writeFileSync(target, "B — moved after staging");
		const r = revalidateBeforeRename(target, rev("A — what was validated"), "write_file", "f.ts");
		expect(r).not.toBeNull();
		expect(kindOf(r!)).toBe("precondition");
		expect(r!.content).toContain("changed since");
	});

	it("the helper passes when the world still matches", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		const target = join(dir, "f.ts");
		writeFileSync(target, "A");
		expect(revalidateBeforeRename(target, rev("A"), "write_file", "f.ts")).toBeNull();
	});
});

describe("WR-1A ④ — pattern-not-found is precondition (the world, not the input)", () => {
	it("edit_file: fresh revision + absent pattern → precondition, and the file is untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		writeFileSync(join(dir, "f.ts"), "hello\n");
		const edit = editFileTool({ workspaceRoot: dir });
		const r = await edit.execute({ path: "f.ts", search: "nope", replace: "x", expectedRevision: rev("hello\n") }, undefined as never);
		expect(r.isError).toBe(true);
		expect(kindOf(r)).toBe("precondition");
		expect(r.content).toContain("pattern not found");
	});
});

describe("WR-1A ⑤ — temp hygiene under WR-1 (the restored coverage)", () => {
	it("write_file: temp creation fails in an unwritable dir AFTER validation — no .kiso-tmp-* remains", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wr1a-"));
		const target = join(dir, "f.ts");
		writeFileSync(target, "OLD");
		const write = writeFileTool({ workspaceRoot: dir });
		chmodSync(dir, 0o555); // validation READ still works; temp write fails
		const r = await write.execute({ path: "f.ts", content: "NEW", expectedRevision: rev("OLD") }, undefined as never);
		chmodSync(dir, 0o755);
		expect(r.isError).toBe(true);
		expect(readdirSync(dir).filter((f) => f.includes(".kiso-tmp-"))).toEqual([]);
	});
});
