/**
 * WR-1 — per-file optimistic concurrency, the explicit-revision design
 * (spec v2, post-review).
 *
 * The invariant (the narrowed, provable claim): kiso refuses an
 * existing-file mutation when the file's content revision at validation
 * time differs from the revision the agent observed; non-cooperating
 * writers may still race the final validation→replacement window.
 *
 * Authority rides the RESULT and the citation, never a hidden ledger:
 * read_file returns `[rev: …]`, write_file/edit_file take
 * `expectedRevision` (`rev:…` or "absent"), refusals are
 * errorKind:"precondition" with one actionable sentence. A voided
 * turn's revision is unciteable by construction — the EC-1 coherence
 * the review demanded.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { editFileTool, readFileTool, writeFileTool } from "../src/index.js";
import type { ToolResult } from "@vincemakes/kiso-core";

/** union-honest errorKind access: undefined unless the result IS an error. */
const kindOf = (r: ToolResult): string | undefined => (r.isError ? r.errorKind : undefined);

const REV_LINE = /\[(rev:[0-9a-f]{16})\]$/;

function ws(): { root: string } {
	return { root: mkdtempSync(join(tmpdir(), "kiso-wr1-")) };
}
function tools(root: string) {
	const opts = { workspaceRoot: root };
	return { read: readFileTool(opts), write: writeFileTool(opts), edit: editFileTool(opts) };
}
async function readRev(read: ReturnType<typeof tools>["read"], path: string): Promise<{ content: string; rev: string }> {
	const res = await read.execute({ path }, undefined as never);
	expect(res.isError).toBe(false);
	const m = REV_LINE.exec(res.content.trimEnd());
	expect(m, `no [rev:…] trailer in: ${res.content.slice(-80)}`).not.toBeNull();
	return { content: res.content, rev: m![1]! };
}
const revOf = (bytes: Buffer | string): string =>
	`rev:${createHash("sha256")
		.update(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
		.digest("hex")
		.slice(0, 16)}`;

describe("WR-1 ① — the read side: every read returns the content revision", () => {
	it("default, ranged, and the revision is of the WHOLE file in every case", async () => {
		const { root } = ws();
		const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(join(root, "a.txt"), body);
		const { read } = tools(root);
		const whole = revOf(readFileSync(join(root, "a.txt")));

		const full = await readRev(read, "a.txt");
		expect(full.rev).toBe(whole);

		const ranged = await read.execute({ path: "a.txt", offset: 250, limit: 10 }, undefined as never);
		expect(ranged.isError).toBe(false);
		const m = REV_LINE.exec(ranged.content.trimEnd());
		expect(m).not.toBeNull();
		expect(m![1]).toBe(whole); // a partial VIEW still cites the whole-file revision
	});

	it("raw BYTES are hashed — invalid UTF-8 gets a stable revision (decode-then-hash would lie)", async () => {
		const { root } = ws();
		const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a, 0x68, 0x69]);
		writeFileSync(join(root, "bin.txt"), bytes);
		const { read } = tools(root);
		const { rev } = await readRev(read, "bin.txt");
		expect(rev).toBe(revOf(bytes));
	});
});

describe("WR-1 ② — the mutation lattice (write_file)", () => {
	it("flagship: read → write with the cited revision → success returning the NEW revision; chained edit needs no re-read", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "export const x = 1;\n");
		const { read, write, edit } = tools(root);
		const { rev } = await readRev(read, "f.ts");

		const w = await write.execute({ path: "f.ts", content: "export const x = 2;\n", expectedRevision: rev }, undefined as never);
		expect(w.isError).toBe(false);
		const newRev = REV_LINE.exec(w.content.trimEnd())![1]!;
		expect(newRev).toBe(revOf("export const x = 2;\n"));

		// the model just authored these bytes — a legal new world witness
		const e = await edit.execute({ path: "f.ts", search: "x = 2", replace: "x = 3", expectedRevision: newRev }, undefined as never);
		expect(e.isError).toBe(false);
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("export const x = 3;\n");
	});

	it("the teaching loop: omitted on an EXISTING file → precondition; read; retry → success", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "old\n");
		const { read, write } = tools(root);

		const refused = await write.execute({ path: "f.ts", content: "new\n" }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
		expect(refused.content).toContain("already exists");
		expect(refused.content).toContain("expectedRevision");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("old\n"); // nothing was written

		const { rev } = await readRev(read, "f.ts");
		const ok = await write.execute({ path: "f.ts", content: "new\n", expectedRevision: rev }, undefined as never);
		expect(ok.isError).toBe(false);
	});

	it("external mutation between read and write → stale refusal NAMING the cited revision; re-read heals", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "v1\n");
		const { read, write } = tools(root);
		const { rev } = await readRev(read, "f.ts");

		writeFileSync(join(root, "f.ts"), "v2 — the user edited meanwhile\n");

		const refused = await write.execute({ path: "f.ts", content: "v3\n", expectedRevision: rev }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
		expect(refused.content).toContain("changed since");
		expect(refused.content).toContain(rev);
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("v2 — the user edited meanwhile\n");

		const again = await readRev(read, "f.ts");
		const ok = await write.execute({ path: "f.ts", content: "v3\n", expectedRevision: again.rev }, undefined as never);
		expect(ok.isError).toBe(false);
	});

	it("shell-shaped mutation is just observation: the pre-shell revision refuses, no ledger anywhere", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "before\n");
		const { read, write } = tools(root);
		const { rev } = await readRev(read, "f.ts");
		// what a shell command does to the file is indistinguishable from
		// any other external writer — the whole point of v2
		writeFileSync(join(root, "f.ts"), "after — a shell command rewrote me\n");
		const refused = await write.execute({ path: "f.ts", content: "x\n", expectedRevision: rev }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
	});

	it("creation lattice: omitted+absent creates; \"absent\"+absent creates; \"absent\"+existing refuses", async () => {
		const { root } = ws();
		const { write } = tools(root);

		const plain = await write.execute({ path: "new1.ts", content: "a\n" }, undefined as never);
		expect(plain.isError).toBe(false);

		const explicit = await write.execute({ path: "new2.ts", content: "b\n", expectedRevision: "absent" }, undefined as never);
		expect(explicit.isError).toBe(false);
		expect(REV_LINE.exec(explicit.content.trimEnd())).not.toBeNull();

		const clash = await write.execute({ path: "new1.ts", content: "c\n", expectedRevision: "absent" }, undefined as never);
		expect(clash.isError).toBe(true);
		expect(kindOf(clash)).toBe("precondition");
		expect(clash.content).toContain("already exists");
		expect(readFileSync(join(root, "new1.ts"), "utf8")).toBe("a\n");
	});

	it("the delete race made visible: a cited revision against a vanished file names the fix", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "v1\n");
		const { read, write } = tools(root);
		const { rev } = await readRev(read, "f.ts");
		const { rmSync } = await import("node:fs");
		rmSync(join(root, "f.ts"));
		const refused = await write.execute({ path: "f.ts", content: "v2\n", expectedRevision: rev }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
		expect(refused.content).toContain("no longer exists");
		expect(refused.content).toContain("absent");
	});
});

describe("WR-1 ③ — edit_file: same lattice, single snapshot, stale before pattern", () => {
	it("stale + pattern-gone reports STALENESS (the truer cause)", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "alpha\n");
		const { read, edit } = tools(root);
		const { rev } = await readRev(read, "f.ts");
		writeFileSync(join(root, "f.ts"), "beta\n"); // alpha is gone AND the file is stale
		const refused = await edit.execute({ path: "f.ts", search: "alpha", replace: "gamma", expectedRevision: rev }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
		expect(refused.content).toContain("changed since");
		expect(refused.content).not.toContain("pattern not found");
	});

	it("omitted expectedRevision on edit → the teaching refusal (edits always target existing files)", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "alpha\n");
		const { edit } = tools(root);
		const refused = await edit.execute({ path: "f.ts", search: "alpha", replace: "beta" }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
		expect(refused.content).toContain("expectedRevision");
		expect(readFileSync(join(root, "f.ts"), "utf8")).toBe("alpha\n");
	});

	it("a fresh revision + matching pattern edits and returns the NEW revision", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "alpha beta\n");
		const { read, edit } = tools(root);
		const { rev } = await readRev(read, "f.ts");
		const ok = await edit.execute({ path: "f.ts", search: "beta", replace: "gamma", expectedRevision: rev }, undefined as never);
		expect(ok.isError).toBe(false);
		expect(REV_LINE.exec(ok.content.trimEnd())![1]).toBe(revOf("alpha gamma\n"));
	});

	it("ranged read's revision still guards an edit far OUTSIDE the read range", async () => {
		const { root } = ws();
		const body = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(join(root, "f.txt"), body);
		const { read, edit } = tools(root);
		const res = await read.execute({ path: "f.txt", offset: 1, limit: 5 }, undefined as never);
		const rev = REV_LINE.exec(res.content.trimEnd())![1]!;
		const ok = await edit.execute({ path: "f.txt", search: "line 299", replace: "LINE 299", expectedRevision: rev }, undefined as never);
		expect(ok.isError).toBe(false);
	});
});

describe("WR-1 ④ — the recovery acceptance (the review's): durable intent re-asks reality", () => {
	it("the same invocation citing rev A executes when the disk still says A, refuses when it says B — no special case", async () => {
		const { root } = ws();
		writeFileSync(join(root, "f.ts"), "A\n");
		const { read, write } = tools(root);
		const { rev } = await readRev(read, "f.ts");
		// "resume" is nothing but a later call with the SAME durable input —
		// v2 has no process state to lose, so the crash is not simulated, it
		// is IRRELEVANT: the tool factories are recreated fresh.
		const fresh = tools(root);
		const ok = await fresh.write.execute({ path: "f.ts", content: "A2\n", expectedRevision: rev }, undefined as never);
		expect(ok.isError).toBe(false);

		writeFileSync(join(root, "f.ts"), "B — the world moved\n");
		const fresh2 = tools(root);
		const refused = await fresh2.write.execute({ path: "f.ts", content: "A3\n", expectedRevision: rev }, undefined as never);
		expect(refused.isError).toBe(true);
		expect(kindOf(refused)).toBe("precondition");
	});
});
